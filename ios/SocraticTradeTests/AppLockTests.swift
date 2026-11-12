import XCTest
@testable import SocraticTrade

final class AppLockPolicyTests: XCTestCase {
    func testGracePeriodIsOneMinute() {
        XCTAssertEqual(AppLockPolicy.defaultGracePeriod, 60)
    }

    func testDisabledNeverLocks() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertFalse(
            AppLockPolicy.shouldRequireLock(
                isEnabled: false,
                isUnlocked: false,
                lastBackgroundedAt: now,
                now: now
            )
        )
    }

    func testEnabledColdStartRequiresUnlock() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertTrue(
            AppLockPolicy.shouldRequireLock(
                isEnabled: true,
                isUnlocked: false,
                lastBackgroundedAt: nil,
                now: now
            )
        )
    }

    func testEnabledWithinGraceStaysUnlocked() {
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        let now = backgrounded.addingTimeInterval(AppLockPolicy.defaultGracePeriod - 5)
        XCTAssertFalse(
            AppLockPolicy.shouldRequireLock(
                isEnabled: true,
                isUnlocked: true,
                lastBackgroundedAt: backgrounded,
                now: now
            )
        )
    }

    func testEnabledAtExactGraceStaysUnlocked() {
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        let now = backgrounded.addingTimeInterval(AppLockPolicy.defaultGracePeriod)
        XCTAssertFalse(
            AppLockPolicy.shouldRequireLock(
                isEnabled: true,
                isUnlocked: true,
                lastBackgroundedAt: backgrounded,
                now: now
            )
        )
    }

    func testEnabledPastGraceRequiresUnlock() {
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        let now = backgrounded.addingTimeInterval(AppLockPolicy.defaultGracePeriod + 1)
        XCTAssertTrue(
            AppLockPolicy.shouldRequireLock(
                isEnabled: true,
                isUnlocked: true,
                lastBackgroundedAt: backgrounded,
                now: now
            )
        )
    }
}

@MainActor
final class AppLockControllerTests: XCTestCase {
    private let defaultsSuite = "AppLockControllerTests"
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: defaultsSuite)
        defaults.removePersistentDomain(forName: defaultsSuite)
        AppLockPreferences.defaults = defaults
        AppLockDeviceAuthentication.reset()
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: defaultsSuite)
        AppLockPreferences.defaults = .standard
        AppLockDeviceAuthentication.reset()
        super.tearDown()
    }

    func testDefaultOffDoesNotLock() {
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        XCTAssertFalse(controller.requiresLockScreen)
        XCTAssertTrue(controller.isUnlocked)
    }

    func testEnablingForcesLockUntilUnlock() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        controller.isEnabled = true
        XCTAssertTrue(AppLockPreferences.isEnabled)
        XCTAssertTrue(controller.requiresLockScreen)
        XCTAssertNil(controller.lastErrorMessage)
        controller.unlockSucceeded()
        XCTAssertFalse(controller.requiresLockScreen)
    }

    func testEnablingWhenAuthenticationUnavailableDoesNotLock() {
        AppLockDeviceAuthentication.isAvailable = { false }
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        controller.isEnabled = true
        XCTAssertFalse(AppLockPreferences.isEnabled)
        XCTAssertFalse(controller.requiresLockScreen)
        XCTAssertTrue(controller.isUnlocked)
        XCTAssertNotNil(controller.lastErrorMessage)
    }

    func testColdStartKeepsAppLockPreferenceWhenEnabled() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        XCTAssertTrue(AppLockPreferences.isEnabled)
        XCTAssertTrue(controller.requiresLockScreen)
        XCTAssertNil(controller.lastErrorMessage)
    }

    func testColdStartWithoutAuthenticationStaysLockedUntilTurnedOff() {
        AppLockDeviceAuthentication.isAvailable = { false }
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        XCTAssertTrue(AppLockPreferences.isEnabled)
        XCTAssertFalse(controller.deviceAuthenticationAvailable)
        XCTAssertTrue(controller.requiresLockScreen)
        XCTAssertNotNil(controller.lastErrorMessage)
        controller.disableBecauseAuthenticationUnavailable()
        XCTAssertFalse(AppLockPreferences.isEnabled)
        XCTAssertFalse(controller.requiresLockScreen)
        XCTAssertTrue(controller.isUnlocked)
        XCTAssertNil(controller.lastErrorMessage)
    }

    func testEnablingClearsLastUnlockErrorMessage() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        controller.reportUnlockFailure("Could not unlock.\u{00A0} Try again.")
        controller.isEnabled = true
        XCTAssertNil(controller.lastErrorMessage)
        XCTAssertTrue(controller.requiresLockScreen)
    }

    func testDismissUnlockErrorClearsLastErrorMessage() {
        let controller = AppLockController()
        controller.reportUnlockFailure("Could not unlock.\u{00A0} Try again.")
        XCTAssertNotNil(controller.lastErrorMessage)
        controller.dismissUnlockError()
        XCTAssertNil(controller.lastErrorMessage)
    }

    func testReturningWithinGraceClearsBackgroundTimestamp() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        controller.unlockSucceeded()
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        controller.recordDidEnterBackground(at: backgrounded)
        controller.evaluateForegroundEntry(at: backgrounded.addingTimeInterval(30))
        XCTAssertNil(controller.lastBackgroundedAt)
        XCTAssertTrue(controller.isUnlocked)
        XCTAssertFalse(controller.requiresLockScreen)
    }

    func testReturningAtExactGraceStaysUnlocked() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        controller.unlockSucceeded()
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        controller.recordDidEnterBackground(at: backgrounded)
        controller.evaluateForegroundEntry(
            at: backgrounded.addingTimeInterval(AppLockPolicy.defaultGracePeriod)
        )
        XCTAssertNil(controller.lastBackgroundedAt)
        XCTAssertTrue(controller.isUnlocked)
        XCTAssertFalse(controller.requiresLockScreen)
    }

    func testReturningPastGraceLocks() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        controller.unlockSucceeded()
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        controller.recordDidEnterBackground(at: backgrounded)
        controller.evaluateForegroundEntry(
            at: backgrounded.addingTimeInterval(AppLockPolicy.defaultGracePeriod + 1)
        )
        XCTAssertFalse(controller.isUnlocked)
        XCTAssertTrue(controller.requiresLockScreen)
    }

    func testDisablingUnlocksAndClearsTheGraceTimestamp() {
        AppLockDeviceAuthentication.isAvailable = { true }
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        controller.isEnabled = true
        controller.recordDidEnterBackground(at: Date(timeIntervalSince1970: 1_700_000_000))
        controller.isEnabled = false
        XCTAssertFalse(AppLockPreferences.isEnabled)
        XCTAssertTrue(controller.isUnlocked)
        XCTAssertNil(controller.lastBackgroundedAt)
        XCTAssertNil(controller.lastErrorMessage)
        XCTAssertFalse(controller.requiresLockScreen)
    }

    func testBackgroundInvalidatesInFlightForegroundResume() {
        let controller = AppLockController()
        let resumeID = controller.beginForegroundResume()
        controller.invalidateForegroundResume()
        XCTAssertNotEqual(resumeID, controller.foregroundResumeID)
        XCTAssertTrue(controller.isUnlocked)
    }
}
