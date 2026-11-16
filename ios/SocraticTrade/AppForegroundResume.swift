import Foundation

@MainActor
protocol SessionRestoreAwaiting: AnyObject {
    func ensurePersistedSessionRestoredBeforeAuthenticatedRequests() async
}

extension MobileStore: SessionRestoreAwaiting {}

@MainActor
enum AppForegroundResume {
    /// Returns true when the live stream is left running (see `AppLiveSessionResume`).
    @discardableResult
    static func resumeAfterBecomingActive(
        store: some LiveSessionResuming & SessionRestoreAwaiting,
        isScreenshotMode: Bool,
        shouldContinue: @escaping () -> Bool
    ) async -> Bool {
        guard !isScreenshotMode else { return false }
        await store.ensurePersistedSessionRestoredBeforeAuthenticatedRequests()
        guard shouldContinue() else { return false }
        return await AppLiveSessionResume.resumeLiveSession(
            store: store,
            isScreenshotMode: false,
            shouldStartEvents: shouldContinue
        )
    }
}
