import Foundation

@MainActor
protocol LiveSessionResuming: AnyObject {
    var isAuthenticated: Bool { get }
    func load() async
    func startEvents()
}

extension MobileStore: LiveSessionResuming {}

@MainActor
enum AppLiveSessionResume {
    static func resumeLiveSession(store: some LiveSessionResuming, isScreenshotMode: Bool) async {
        if isScreenshotMode { return }
        guard store.isAuthenticated else { return }
        await store.load()
        guard store.isAuthenticated else { return }
        store.startEvents()
    }
}
