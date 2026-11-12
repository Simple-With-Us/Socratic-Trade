import Foundation

@MainActor
protocol LiveSessionResuming: AnyObject {
    var isAuthenticated: Bool { get }
    /// True while the SSE connection is up. A resume must not replace that task.
    var isLiveStreamConnected: Bool { get }
    func load() async
    func startEvents()
    func stopEvents()
}

extension MobileStore: LiveSessionResuming {
    var isLiveStreamConnected: Bool { isStreamConnected }
}

struct LiveResumeOutcome: Equatable {
    var startedEvents: Bool
    var joinedInFlight: Bool
}

/// One foreground resume at a time. A second caller waits for the in-flight
/// reload instead of tearing the stream down and fetching the snapshot again.
/// Waiters suspend on a continuation, not on `Task.value`, so cancelling a
/// waiter does not cancel the shared reload.
@MainActor
final class LiveResumeGate {
    private final class Handle {
        var outcome: Bool?
        var waiters: [CheckedContinuation<Bool, Never>] = []

        func finish(_ value: Bool) {
            outcome = value
            let pending = waiters
            waiters.removeAll()
            for waiter in pending {
                waiter.resume(returning: value)
            }
        }

        func value() async -> Bool {
            if let outcome { return outcome }
            return await withCheckedContinuation { continuation in
                if let outcome {
                    continuation.resume(returning: outcome)
                } else {
                    waiters.append(continuation)
                }
            }
        }
    }

    private var inFlight: Handle?
    private(set) var joinCount = 0

    func run(_ body: @escaping @MainActor () async -> Bool) async -> LiveResumeOutcome {
        if let inFlight, inFlight.outcome == nil {
            joinCount += 1
            let startedEvents = await inFlight.value()
            return LiveResumeOutcome(startedEvents: startedEvents, joinedInFlight: true)
        }
        let handle = Handle()
        inFlight = handle
        Task { @MainActor in
            handle.finish(await body())
        }
        let startedEvents = await handle.value()
        if inFlight === handle {
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
        // startEvents replaces its previous task. Leave a connected stream up
        // so Control Center does not drop and reopen the same session.
        if !store.isLiveStreamConnected {
            store.startEvents()
        }
        await store.load()
        let stillWanted = shouldStartEvents?() ?? true
        guard store.isAuthenticated, stillWanted else {
            store.stopEvents()
            return false
        }
        return true
    }
}
