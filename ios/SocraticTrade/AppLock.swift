import Foundation
import LocalAuthentication
import Observation
import SwiftUI
import UIKit

/// Pure lock decision. The product timeout is `defaultGracePeriod` (one minute).
enum AppLockPolicy {
    static let defaultGracePeriod: TimeInterval = 60

    /// Cold start with app lock on always requires unlock (`isUnlocked == false`).
    /// After backgrounding, require unlock again only once the grace window has elapsed.
    /// A return inside the window must clear `lastBackgroundedAt`; otherwise a later
    /// render would lock the app while the user is still in the foreground.
    static func shouldRequireLock(
        isEnabled: Bool,
        isUnlocked: Bool,
        lastBackgroundedAt: Date?,
        now: Date,
        gracePeriod: TimeInterval = defaultGracePeriod
    ) -> Bool {
        guard isEnabled else { return false }
        if !isUnlocked { return true }
        guard let lastBackgroundedAt else { return false }
        return now.timeIntervalSince(lastBackgroundedAt) > gracePeriod
    }
}

enum AppLockPreferences {
    /// Tests swap this for an isolated suite. Production uses the standard defaults.
    static var defaults: UserDefaults = .standard

    private static let enabledKey = "appLock.enabled.v1"

    static var isEnabled: Bool {
        get { defaults.bool(forKey: enabledKey) }
        set { defaults.set(newValue, forKey: enabledKey) }
    }
}

/// `deviceOwnerAuthentication` accepts biometrics and falls back to the device passcode.
/// Tests replace `isAvailable` so the suite does not depend on the simulator enrollment.
enum AppLockDeviceAuthentication {
    static var isAvailable: () -> Bool = live

    static func live() -> Bool {
        let context = LAContext()
        var policyError: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError)
    }

    static func reset() {
        isAvailable = live
    }
}

@MainActor
@Observable
final class AppLockController {
    private(set) var isUnlocked: Bool
    var lastErrorMessage: String?
    private(set) var lastBackgroundedAt: Date?
    /// Cached so the lock screen can show an escape hatch without probing LocalAuthentication in `body`.
    private(set) var deviceAuthenticationAvailable: Bool
    /// Bumped when a foreground resume must not start the live stream (background, or a newer resume).
    @ObservationIgnored private(set) var foregroundResumeID = 0

    var isEnabled: Bool {
        get { AppLockPreferences.isEnabled }
        set {
            if newValue {
                guard AppLockDeviceAuthentication.isAvailable() else {
                    lastErrorMessage =
                        "Set a device passcode or enroll biometrics before turning on app lock."
                    AppLockPreferences.isEnabled = false
                    isUnlocked = true
                    refreshDeviceAuthenticationAvailability()
                    return
                }
                AppLockPreferences.isEnabled = true
                isUnlocked = false
                lastErrorMessage = nil
                refreshDeviceAuthenticationAvailability()
            } else {
                AppLockPreferences.isEnabled = false
                isUnlocked = true
                lastBackgroundedAt = nil
                lastErrorMessage = nil
            }
        }
    }

    var requiresLockScreen: Bool {
        AppLockPolicy.shouldRequireLock(
            isEnabled: isEnabled,
            isUnlocked: isUnlocked,
            lastBackgroundedAt: lastBackgroundedAt,
            now: Date()
        )
    }

    init() {
        let available = AppLockDeviceAuthentication.isAvailable()
        deviceAuthenticationAvailable = available
        if AppLockPreferences.isEnabled {
            // Keep the preference. A transient LocalAuthentication failure must not
            // silently turn the setting off. The lock screen offers Turn Off App Lock
            // when the device cannot authenticate, so the user is not stuck.
            isUnlocked = false
            if !available {
                lastErrorMessage =
                    "A device passcode or biometrics is required to use app lock.\u{00A0} Add one in Settings, then unlock."
            }
        } else {
            isUnlocked = true
        }
    }

    func recordDidEnterBackground(at date: Date = Date()) {
        lastBackgroundedAt = date
    }

    func beginForegroundResume() -> Int {
        foregroundResumeID &+= 1
        return foregroundResumeID
    }

    func invalidateForegroundResume() {
        foregroundResumeID &+= 1
    }

    func evaluateForegroundEntry(at date: Date = Date()) {
        guard isEnabled else {
            isUnlocked = true
            lastBackgroundedAt = nil
            return
        }
        guard let lastBackgroundedAt else { return }
        let elapsed = date.timeIntervalSince(lastBackgroundedAt)
        if elapsed <= AppLockPolicy.defaultGracePeriod {
            self.lastBackgroundedAt = nil
            return
        }
        isUnlocked = false
    }

    func unlockSucceeded() {
        isUnlocked = true
        lastBackgroundedAt = nil
        lastErrorMessage = nil
    }

    func reportUnlockFailure(_ message: String) {
        lastErrorMessage = message
    }

    func dismissUnlockError() {
        lastErrorMessage = nil
    }

    func refreshDeviceAuthenticationAvailability() {
        deviceAuthenticationAvailable = AppLockDeviceAuthentication.isAvailable()
    }

    func disableBecauseAuthenticationUnavailable() {
        AppLockPreferences.isEnabled = false
        isUnlocked = true
        lastBackgroundedAt = nil
        lastErrorMessage = nil
        refreshDeviceAuthenticationAvailability()
    }
}

struct AppLockView: View {
    @Bindable var controller: AppLockController
    @State private var didAttemptInitialUnlock = false

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(AppPalette.accent)
                    .accessibilityHidden(true)
                Text("Unlock Socratic Trade")
                    .font(.appTitle3)
                Text("Face ID, Touch ID, or your device passcode protects this session.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                if let message = controller.lastErrorMessage {
                    Text(message)
                        .font(.appFootnote)
                        .foregroundStyle(AppPalette.warning)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
                Button("Unlock") {
                    authenticate()
                }
                .buttonStyle(.borderedProminent)
                if !controller.deviceAuthenticationAvailable {
                    Button("Turn Off App Lock") {
                        controller.disableBecauseAuthenticationUnavailable()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(32)
        }
        .preferredColorScheme(.light)
        .onAppear {
            controller.refreshDeviceAuthenticationAvailability()
            guard !didAttemptInitialUnlock else { return }
            didAttemptInitialUnlock = true
            authenticate()
        }
        .accessibilityAddTraits(.isModal)
    }

    private func authenticate() {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        // deviceOwnerAuthentication presents biometrics and, when that fails or is
        // not enrolled, the device passcode. Do not set localizedFallbackTitle:
        // a custom fallback button returns userFallback instead of showing the passcode.
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            controller.refreshDeviceAuthenticationAvailability()
            controller.reportUnlockFailure(
                "Biometrics or a device passcode is required to use app lock.\u{00A0} Turn off app lock to continue."
            )
            return
        }
        let reason = "Unlock your Socratic Trade session."
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            Task { @MainActor in
                if success {
                    controller.unlockSucceeded()
                    return
                }
                handleAuthenticationFailure(error)
            }
        }
    }

    private func handleAuthenticationFailure(_ error: Error?) {
        guard let error, let laError = error as? LAError else {
            controller.refreshDeviceAuthenticationAvailability()
            controller.reportUnlockFailure("Could not unlock.\u{00A0} Try again.")
            return
        }
        switch laError.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback:
            controller.dismissUnlockError()
        case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
            controller.refreshDeviceAuthenticationAvailability()
            controller.reportUnlockFailure(
                "Biometrics or a device passcode is required to use app lock.\u{00A0} Turn off app lock to continue."
            )
        case .biometryLockout:
            controller.refreshDeviceAuthenticationAvailability()
            controller.reportUnlockFailure("Could not unlock.\u{00A0} Try again with your device passcode.")
        default:
            controller.refreshDeviceAuthenticationAvailability()
            controller.reportUnlockFailure("Could not unlock.\u{00A0} Try again.")
        }
    }
}

/// Above the app window, so a sheet that is already presented cannot sit on top
/// of the lock. Below system alerts, so the device-passcode UI still appears.
enum AppLockCoverWindow {
    static var level: UIWindow.Level {
        UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
    }
}

/// A root `.fullScreenCover` is dropped while a descendant sheet owns the
/// hosting controller. This host puts the lock in its own window instead.
struct AppLockCoverHost: UIViewRepresentable {
    var isPresented: Bool
    var controller: AppLockController

    func makeUIView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.isHidden = true
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ uiView: AnchorView, context: Context) {
        context.coordinator.isPresented = isPresented
        context.coordinator.controller = controller
        context.coordinator.sync(anchor: uiView)
    }

    static func dismantleUIView(_ uiView: AnchorView, coordinator: Coordinator) {
        coordinator.dismiss()
        uiView.coordinator = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class AnchorView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.coordinator?.sync(anchor: self)
            }
        }
    }

    final class Coordinator {
        var isPresented = false
        var controller: AppLockController?
        private var coverWindow: UIWindow?
        private weak var previousKeyWindow: UIWindow?

        func sync(anchor: UIView) {
            guard isPresented, let controller else {
                dismiss()
                return
            }
            guard let scene = anchor.window?.windowScene else { return }
            if let coverWindow, coverWindow.windowScene === scene, !coverWindow.isHidden {
                if !coverWindow.isKeyWindow {
                    claimKey(coverWindow, in: scene)
                }
                return
            }
            dismiss()
            let hosting = UIHostingController(rootView: AppLockView(controller: controller))
            hosting.view.backgroundColor = .clear
            hosting.overrideUserInterfaceStyle = .light
            let cover = UIWindow(windowScene: scene)
            cover.windowLevel = AppLockCoverWindow.level
            cover.backgroundColor = .clear
            cover.rootViewController = hosting
            claimKey(cover, in: scene)
            coverWindow = cover
        }

        func dismiss() {
            guard let coverWindow else { return }
            let previous = previousKeyWindow
            let scene = coverWindow.windowScene
            coverWindow.isHidden = true
            coverWindow.rootViewController = nil
            self.coverWindow = nil
            previousKeyWindow = nil
            if previous?.isHidden == false {
                previous?.makeKey()
                return
            }
            scene?.windows.first { $0 !== coverWindow && $0.isHidden == false }?.makeKey()
        }

        private func claimKey(_ cover: UIWindow, in scene: UIWindowScene) {
            previousKeyWindow = scene.windows.first { $0.isKeyWindow && $0 !== cover }
            cover.makeKeyAndVisible()
        }
    }
}
