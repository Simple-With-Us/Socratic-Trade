import Foundation
import LocalAuthentication
import Observation
import SwiftUI

enum AppLockPolicy {
    static let defaultGracePeriod: TimeInterval = 60

    /// When app lock is enabled, a cold start always requires unlock (`isUnlocked == false`).
    /// After backgrounding, require unlock again once the grace window has elapsed.
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
    private static let enabledKey = "appLock.enabled.v1"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
}

@MainActor
@Observable
final class AppLockController {
    private(set) var isUnlocked: Bool
    var lastErrorMessage: String?

    private(set) var lastBackgroundedAt: Date?

    static func deviceAuthenticationAvailable() -> Bool {
        let context = LAContext()
        var policyError: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError)
    }

    var isEnabled: Bool {
        get { AppLockPreferences.isEnabled }
        set {
            if newValue {
                guard Self.deviceAuthenticationAvailable() else {
                    lastErrorMessage =
                        "Set a device passcode or enroll biometrics before turning on app lock."
                    AppLockPreferences.isEnabled = false
                    isUnlocked = true
                    return
                }
                AppLockPreferences.isEnabled = true
                isUnlocked = false
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
        if AppLockPreferences.isEnabled {
            if Self.deviceAuthenticationAvailable() {
                isUnlocked = false
            } else {
                AppLockPreferences.isEnabled = false
                isUnlocked = true
            }
        } else {
            isUnlocked = true
        }
    }

    func recordDidEnterBackground(at date: Date = Date()) {
        lastBackgroundedAt = date
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

    func disableBecauseAuthenticationUnavailable() {
        AppLockPreferences.isEnabled = false
        isUnlocked = true
        lastBackgroundedAt = nil
        lastErrorMessage = nil
    }
}

struct AppLockView: View {
    @Bindable var controller: AppLockController
    @State private var deviceAuthenticationAvailable = AppLockController.deviceAuthenticationAvailable()

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(AppPalette.accent)
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
                if !deviceAuthenticationAvailable {
                    Button("Turn Off App Lock") {
                        controller.disableBecauseAuthenticationUnavailable()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(32)
        }
        .onAppear {
            refreshDeviceAuthenticationAvailability()
            authenticate()
        }
        .accessibilityAddTraits(.isModal)
    }

    private func authenticate() {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            refreshDeviceAuthenticationAvailability()
            controller.reportUnlockFailure(
                "Biometrics or a device passcode is required to use app lock.  Turn off app lock to continue."
            )
            return
        }
        let reason = "Unlock your Socratic Trade session."
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            Task { @MainActor in
                if success {
                    controller.unlockSucceeded()
                } else if let error {
                    let nsError = error as NSError
                    if nsError.code == LAError.userCancel.rawValue
                        || nsError.code == LAError.appCancel.rawValue
                        || nsError.code == LAError.systemCancel.rawValue {
                        return
                    }
                    refreshDeviceAuthenticationAvailability()
                    controller.reportUnlockFailure("Could not unlock.  Try again.")
                }
            }
        }
    }

    private func refreshDeviceAuthenticationAvailability() {
        deviceAuthenticationAvailable = AppLockController.deviceAuthenticationAvailable()
    }
}
