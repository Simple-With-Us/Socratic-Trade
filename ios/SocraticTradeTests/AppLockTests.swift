import XCTest
@testable import SocraticTrade

final class AppLockPolicyTests: XCTestCase {
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
    override func tearDown() {
        AppLockPreferences.isEnabled = false
        super.tearDown()
    }

    func testDefaultOffDoesNotLock() {
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        XCTAssertFalse(controller.requiresLockScreen)
    }

    func testEnablingForcesLockUntilUnlock() {
        AppLockPreferences.isEnabled = false
        let controller = AppLockController()
        controller.isEnabled = true
        XCTAssertTrue(controller.requiresLockScreen)
        controller.unlockSucceeded()
        XCTAssertFalse(controller.requiresLockScreen)
    }

    func testColdStartKeepsAppLockPreferenceWhenEnabled() {
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        XCTAssertTrue(AppLockPreferences.isEnabled)
        XCTAssertTrue(controller.requiresLockScreen)
    }

    func testEnablingClearsLastUnlockErrorMessage() {
        guard AppLockController.deviceAuthenticationAvailable() else { return }
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

    func testDisableBecauseAuthenticationUnavailableClearsLastErrorMessage() {
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        controller.reportUnlockFailure("Could not unlock.  Try again.")
        XCTAssertNotNil(controller.lastErrorMessage)
        controller.disableBecauseAuthenticationUnavailable()
        XCTAssertNil(controller.lastErrorMessage)
        XCTAssertFalse(AppLockPreferences.isEnabled)
    }

    func testReturningWithinGraceClearsBackgroundTimestamp() {
        AppLockPreferences.isEnabled = true
        let controller = AppLockController()
        controller.unlockSucceeded()
        let backgrounded = Date(timeIntervalSince1970: 1_700_000_000)
        controller.recordDidEnterBackground(at: backgrounded)
        controller.evaluateForegroundEntry(at: backgrounded.addingTimeInterval(30))
        XCTAssertNil(controller.lastBackgroundedAt)
        XCTAssertFalse(
            AppLockPolicy.shouldRequireLock(
                isEnabled: true,
                isUnlocked: true,
                lastBackgroundedAt: controller.lastBackgroundedAt,
                now: backgrounded.addingTimeInterval(120)
            )
        )
    }
}
