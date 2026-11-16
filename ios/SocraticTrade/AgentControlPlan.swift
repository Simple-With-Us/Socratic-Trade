import Foundation

/// What the Home Agent Controls card should show.  Website chrome already uses
/// one Start / Resume / Stop control plus a sheet of only the available actions.
/// iOS used to dump every button at once, so Start looked dead next to a live Stop
/// while the agent was already on (and only waiting for the market to open).
struct AgentControlPlan: Equatable {
    enum Primary: String {
        case start
        case resume
        case stop
    }

    let statusTitle: String
    let statusDetail: String
    let primary: Primary
    let showStart: Bool
    let showStop: Bool
    let showCloseOnly: Bool
    let showWindDown: Bool
    let startLabel: String
    let startEnabled: Bool
    let startDisabledReason: String?

    static func from(
        systemState: String,
        runState: RunStateWord,
        authority: String,
        snapshotStale: Bool,
        ready: Bool
    ) -> AgentControlPlan {
        let autopilot = authority.lowercased() == "decide"
        let authorityWord = autopilot ? "Autopilot" : "Ask-first"
        let state = systemState.lowercased()

        let startEnabled = ready && !snapshotStale
        let startDisabledReason: String? = {
            if !ready { return "Connect an account and a symbol universe first." }
            if snapshotStale { return "Refresh the desk before starting.  Stop still works." }
            return nil
        }()

        switch state {
        case "active":
            let paused = runState == .pausedMarketClosed
            return AgentControlPlan(
                statusTitle: paused ? "Agent Is On · Waiting for Open" : "Agent Is On",
                statusDetail: paused
                    ? "Scheduled \(authorityWord) runs wait for the next regular session.  Stop Agent turns them off.  The market being closed is not the same as the agent being stopped."
                    : "Scheduled \(authorityWord) runs are live.  Stop Agent turns them off without selling anything.",
                primary: .stop,
                showStart: false,
                showStop: true,
                showCloseOnly: true,
                showWindDown: true,
                startLabel: "Start Agent",
                startEnabled: startEnabled,
                startDisabledReason: startDisabledReason
            )
        case "close_only":
            return AgentControlPlan(
                statusTitle: "Exit-only",
                statusDetail: "The agent will not open new risk.  Protective exits keep working.  Approving an opening places it anyway.  Resume Agent restores scheduled runs.",
                primary: .resume,
                showStart: true,
                showStop: true,
                showCloseOnly: false,
                showWindDown: true,
                startLabel: "Resume Agent",
                startEnabled: startEnabled,
                startDisabledReason: startDisabledReason
            )
        case "liquidating":
            return AgentControlPlan(
                // State word, not the "Wind Down" command name — `RunStateWord.windingDown`.
                statusTitle: "Winding down",
                statusDetail: "Only sell orders until the account is in cash.  This sells things.",
                primary: .stop,
                showStart: true,
                showStop: true,
                showCloseOnly: true,
                showWindDown: false,
                startLabel: "Resume Agent",
                startEnabled: startEnabled,
                startDisabledReason: startDisabledReason
            )
        default:
            return AgentControlPlan(
                statusTitle: "Agent Is Stopped",
                statusDetail: "Nothing is submitted.  Start Agent turns scheduled runs back on.  Run Once still works for a single cycle.",
                primary: .start,
                showStart: true,
                showStop: false,
                showCloseOnly: true,
                showWindDown: true,
                startLabel: "Start Agent",
                startEnabled: startEnabled,
                startDisabledReason: startDisabledReason
            )
        }
    }
}
