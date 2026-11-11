import Foundation

@MainActor
protocol SessionRestoreAwaiting: AnyObject {
    func ensurePersistedSessionRestoredBeforeAuthenticatedRequests() async
}

extension MobileStore: SessionRestoreAwaiting {}

@MainActor
enum AppForegroundResume {
    static func resumeAfterBecomingActive(
        store: some LiveSessionResuming & SessionRestoreAwaiting,
        isScreenshotMode: Bool,
        shouldContinue: () -> Bool
    ) async {
        guard !isScreenshotMode else { return }
        await store.ensurePersistedSessionRestoredBeforeAuthenticatedRequests()
        guard shouldContinue() else { return }
        await AppLiveSessionResume.resumeLiveSession(
            store: store,
            isScreenshotMode: false,
            shouldStartEvents: shouldContinue
        )
    }
}
