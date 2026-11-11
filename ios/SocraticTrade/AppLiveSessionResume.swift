import Foundation

@MainActor
protocol LiveSessionResuming: AnyObject {
    var isAuthenticated: Bool { get }
    func load() async
    func startEvents()
    func stopEvents()
}

extension MobileStore: LiveSessionResuming {}

@MainActor
enum AppLiveSessionResume {
    static func resumeLiveSession(
        store: some LiveSessionResuming,
        isScreenshotMode: Bool,
        shouldStartEvents: (@escaping () -> Bool)? = nil
    ) async {
        if isScreenshotMode { return }
        guard store.isAuthenticated else { return }
        store.stopEvents()
        await store.load()
        guard store.isAuthenticated else { return }
        if let shouldStartEvents, !shouldStartEvents() { return }
        store.startEvents()
    }
}
