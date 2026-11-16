import SwiftUI

/// Tracks the live scene phase so async foreground resume can re-check after awaits.
@MainActor
final class ScenePhaseResumeGate {
    var phase: ScenePhase = .inactive

    func shouldContinueResume() -> Bool {
        !Task.isCancelled && phase == .active
    }
}
