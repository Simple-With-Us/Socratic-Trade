import Foundation

@MainActor
protocol LiveSessionResuming: AnyObject {
    var isAuthenticated: Bool { get }
    func load() async
    func startEvents()
    func stopEvents()
}

extension MobileStore: LiveSessionResuming {}

struct LiveResumeOutcome: Equatable {
    var startedEvents: Bool
    var joinedInFlight: Bool
}

/// One foreground resume at a time. A second caller waits for the in-flight
/// reload instead of tearing the stream down and fetching the snapshot again.
@MainActor
final class LiveResumeGate {
    private var inFlight: Task<Bool, Never>?
    private(set) var joinCount = 0

    func run(_ body: @escaping @MainActor () async -> Bool) async -> LiveResumeOutcome {
        if let inFlight {
            joinCount += 1
            let startedEvents = await inFlight.value
            return LiveResumeOutcome(startedEvents: startedEvents, joinedInFlight: true)
        }
        let task = Task { @MainActor in
            await body()
        }
        inFlight = task
        let startedEvents = await task.value
        if inFlight == task {
            inFlight = nil
        }
        return LiveResumeOutcome(startedEvents: startedEvents, joinedInFlight: false)
    }
}

@MainActor
enum AppLiveSessionResume {
    /// Start the live stream, then reload. Stop the stream if this resume no
    /// longer owns it when the reload finishes (signed out, or backgrounded).
    @discardableResult
    static func resumeLiveSession(
        store: some LiveSessionResuming,
        isScreenshotMode: Bool,
        shouldStartEvents: (() -> Bool)? = nil
    ) async -> Bool {
        if isScreenshotMode { return false }
        guard store.isAuthenticated else { return false }
        if let shouldStartEvents, !shouldStartEvents() { return false }
        store.startEvents()
        await store.load()
        let stillWanted = shouldStartEvents?() ?? true
        guard store.isAuthenticated, stillWanted else {
            store.stopEvents()
            return false
        }
        return true
    }
}
