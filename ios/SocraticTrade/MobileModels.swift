import Foundation

struct MobileSnapshot: Decodable {
    let currentUser: CurrentUser?
    /// Server-advertised control catalog.  Optional: a server that predates it (or any
    /// payload where it is absent) leaves this nil and the app falls back to its built-in
    /// controls — see `MobileStore.serverAdvertises`.
    let catalog: ControlCatalog?
    let readiness: Readiness
    let policy: PolicySummary
    let marketSession: String
    let scheduler: SchedulerSummary
    let portfolio: PortfolioSummary?
    let positions: [Position]
    let orders: [EquityOrder]
    let pendingProposals: [PendingProposal]
    let dailyStats: DailyStats
    let performance: PerformanceSummary?
    let connectedAccounts: [ConnectedAccount]
    let watchlist: [WatchlistItem]
    let alerts: [PriceAlert]
    let recentCommands: [MobileCommand]

    private enum CodingKeys: String, CodingKey {
        case currentUser
        case catalog
        case readiness
        case policy
        case marketSession
        case scheduler
        case portfolio
        case positions
        case orders
        case pendingProposals
        case dailyStats
        case performance
        case connectedAccounts
        case watchlist
        case alerts
        case recentCommands
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        currentUser = try values.decodeIfPresent(CurrentUser.self, forKey: .currentUser)
        catalog = try values.decodeIfPresent(ControlCatalog.self, forKey: .catalog)
        readiness = try values.decode(Readiness.self, forKey: .readiness)
        policy = try values.decode(PolicySummary.self, forKey: .policy)
        marketSession = try values.decodeIfPresent(String.self, forKey: .marketSession) ?? "unknown"
        scheduler = try values.decodeIfPresent(SchedulerSummary.self, forKey: .scheduler) ?? .empty
        portfolio = try values.decodeIfPresent(PortfolioSummary.self, forKey: .portfolio)
        positions = try values.decodeIfPresent([Position].self, forKey: .positions) ?? []
        orders = try values.decodeIfPresent([EquityOrder].self, forKey: .orders) ?? []
        pendingProposals = try values.decodeIfPresent([PendingProposal].self, forKey: .pendingProposals) ?? []
        dailyStats = try values.decodeIfPresent(DailyStats.self, forKey: .dailyStats) ?? .empty
        performance = try values.decodeIfPresent(PerformanceSummary.self, forKey: .performance)
        connectedAccounts = try values.decodeIfPresent([ConnectedAccount].self, forKey: .connectedAccounts) ?? []
        watchlist = try values.decodeIfPresent([WatchlistItem].self, forKey: .watchlist) ?? []
        alerts = try values.decodeIfPresent([PriceAlert].self, forKey: .alerts) ?? []
        recentCommands = try values.decodeIfPresent([MobileCommand].self, forKey: .recentCommands) ?? []
    }
}

/// The server's own description of what this deployment's mobile control plane offers —
/// `catalog: mobileControlCatalog()` in app/api/mobile/snapshot/route.ts.  The catalog is
/// built in src/lib/mobile-api.ts:
///
///     commands: MOBILE_COMMAND_TYPES.map((type) => ({ type }))
///
/// so `commands[].type` is exactly the set of `commandType` values `/api/mobile/commands`
/// will accept (`isMobileCommandType`).  Only the fields the app actually acts on are
/// decoded; `auth`, `realtime`, and `accountDeletion` are deliberately left out rather than
/// mirrored into dead model surface.
struct ControlCatalog: Decodable, Equatable {
    struct Command: Decodable, Equatable {
        let type: String
    }

    let version: Int?
    let commands: [Command]?

    var advertisedCommandTypes: Set<String> {
        Set((commands ?? []).map(\.type))
    }

    /// Whether this catalog can answer "does the server support command X?".  A missing or
    /// empty `commands` array cannot, and must never be read as "the server supports
    /// nothing" — callers fall back to their built-in controls instead.
    var describesCommands: Bool {
        (commands?.isEmpty == false)
    }
}

struct CurrentUser: Decodable {
    let userId: String
    let email: String?
    let name: String?
    let imageUrl: String?
    let loginProvider: String?
    let isAdmin: Bool?
}

struct Readiness: Decodable {
    let hasAccount: Bool
    let hasUniverse: Bool
    let systemState: String
    let strategyAuthority: String
    let selectedAccountNumber: String?
    let activeConnectedAccount: ConnectedAccount?
    let commandBacklog: CommandBacklog
}

struct CommandBacklog: Decodable {
    let queued: Int
    let running: Int
}

struct ConnectedAccount: Decodable, Identifiable, Hashable {
    let id: String
    let label: String
    let broker: String
    let environment: String
    let accountNumber: String?
    let isActive: Bool?
    let isDraining: Bool?
    let capabilities: AccountCapabilities?
}

struct AccountCapabilities: Decodable, Hashable {
    let equityTrading: Bool?
    let shortSelling: Bool?
    let optionsTrading: Bool?
    let optionsLevel: Int?
    let marginEnabled: Bool?
    let accountType: String?
}

struct PolicySummary: Decodable {
    let systemState: String
    let strategyAuthority: String
    let accountNumber: String?
    let connectedAccountId: String?
    let includedIndices: [String]?
    let additionalSymbols: [String]?
    let blocklist: [String]?
    let holdingHorizon: String?
    let runCadenceMinutes: Int?
    let maxOrderNotional: Double?
    let maxOrderPctOfNav: Double?
    let maxDailyNotional: Double?
    let maxDailyPctOfNav: Double?
    let maxDailyOrders: Int?
    let requireTypedConfirmation: Bool?
    /// Mirrors the server snapshot's policy.runDuringExtendedHours (app/api/mobile/snapshot).
    /// nil ≠ false: older payloads without the field cannot answer the market-window question.
    let runDuringExtendedHours: Bool?
}

/// The console's shared run-state vocabulary (app/console/lib/derive.ts `deriveStateInfo`).
/// The words are load-bearing: this app must never say "Running" while the console says
/// "Paused · market closed" for the same account.
enum RunStateWord: String {
    case running = "Running"
    case pausedMarketClosed = "Paused · market closed"
    case exitOnly = "Exit-only"
    case windingDown = "Winding down"
    case stopped = "Stopped"
}

/// Pure mirror of the console's `deriveStateInfo` word selection, using the server-computed
/// `marketSession` instead of a client clock.  Rules, in console order:
/// - Only `active` is market-gated.  A closed/pre/post session with extended hours OFF means
///   scheduled runs are paused, so the word is "Paused · market closed".
/// - `runDuringExtendedHours == nil` (older payload) makes the market split unanswerable —
///   keep the plain "Running" claim rather than fabricate a pause.
/// - An unknown/absent session likewise cannot answer the question — keep "Running".
func deriveRunStateWord(
    systemState: String,
    runDuringExtendedHours: Bool?,
    marketSession: String?
) -> RunStateWord {
    switch systemState.lowercased() {
    case "active":
        guard let extendedHours = runDuringExtendedHours else { return .running }
        switch (marketSession ?? "").lowercased() {
        case "regular", "open":
            return .running
        case "pre", "post":
            return extendedHours ? .running : .pausedMarketClosed
        case "closed":
            return .pausedMarketClosed
        default:
            return .running
        }
    case "close_only":
        return .exitOnly
    case "liquidating":
        return .windingDown
    default:
        return .stopped
    }
}

/// Convenience over the snapshot's own policy + market session.
func deriveRunStateWord(snapshot: MobileSnapshot) -> RunStateWord {
    deriveRunStateWord(
        systemState: snapshot.readiness.systemState,
        runDuringExtendedHours: snapshot.policy.runDuringExtendedHours,
        marketSession: snapshot.marketSession
    )
}

struct PortfolioSummary: Decodable {
    let accountNumber: String?
    let totalMarketValue: Double?
    let buyingPower: Double?
    let equityMarketValue: Double?
    let optionMarketValue: Double?
    let cash: Double?
}

struct Position: Decodable, Identifiable {
    var id: String { symbol }

    let symbol: String
    let quantity: Double
    let marketValue: Double
    let averageCost: Double?
    let sector: String?
    let industry: String?
}

enum AccountMetrics {
    static func usesLiveMetrics(environment: String?) -> Bool {
        environment?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "live"
    }

    /// Open P&L from the broker position list (mark − cost).  The fill-ledger
    /// unrealized fields report $0 when marks were never applied, which is why
    /// a Tradier Sandbox book with many positions looked like it had no P&L.
    static func unrealizedFromPositions(_ positions: [Position]) -> Double? {
        var total = 0.0
        var counted = 0
        for position in positions {
            guard let averageCost = position.averageCost else { continue }
            total += position.marketValue - position.quantity * averageCost
            counted += 1
        }
        return counted > 0 ? total : nil
    }

    static func displayedUnrealized(positions: [Position], ledger: Double?) -> Double? {
        if let fromPositions = unrealizedFromPositions(positions) {
            return fromPositions
        }
        return ledger
    }

    /// `$0.00` from an empty fill ledger is not a measured result — show "—".
    static func displayedRealized(ledger: Double?, hasFillHistory: Bool) -> Double? {
        if !hasFillHistory { return nil }
        return ledger
    }
}

struct EquityOrder: Decodable, Identifiable {
    let id: String
    let symbol: String
    let side: String
    let type: String
    let state: String
    let quantity: Double?
    let dollarAmount: Double?
    let filledQuantity: Double?
    let averagePrice: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let timeInForce: String?
    let createdAt: String?
    let updatedAt: String?
}

struct PendingProposal: Decodable, Identifiable {
    let id: String
    let createdAt: String?
    let accountNumber: String?
    let executionMode: String?
    let estimatedNotional: Double?
    let lastRevalidatedAt: String?
    let revalidationNote: String?
    let performanceSinceProposalPct: Double?
    let proposalReferencePrice: Double?
    let proposalCurrentPrice: Double?
    let proposal: Proposal
}

struct Proposal: Decodable {
    let symbol: String
    let side: String
    let type: String
    let quantity: Double?
    let dollarAmount: Double?
    let limitPrice: Double?
    let stopPrice: Double?
    let timeInForce: String?
    let rationale: String?
    let greenTeamRationale: String?
    let tradeThesisTag: String?
    let entryMarketRegime: String?
    let confidenceScore: Double?
    let proposedByModel: String?
    let reviewedByModel: String?
    let redTeamVerdict: RedTeamVerdict?
}

struct RedTeamVerdict: Decodable {
    let verdict: String?
    let rejected: Bool
    let available: Bool
    let reason: String
    let model: String?
    let overridden: Bool?
    let humanOverrideApplied: Bool?
    let failureKind: String?

    private enum CodingKeys: String, CodingKey {
        case verdict
        case decision
        case rejected
        case available
        case reason
        case rationale
        case model
        case overridden
        case humanOverrideApplied
        case failureKind
    }

    init(from decoder: Decoder) throws {
        if let value = try? decoder.singleValueContainer().decode(String.self) {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            verdict = normalized.isEmpty ? nil : normalized
            rejected = normalized == "reject" || normalized == "rejected"
            available = !normalized.isEmpty
            reason = "Legacy adversarial verdict; no rationale was recorded."
            model = nil
            overridden = nil
            humanOverrideApplied = nil
            failureKind = nil
            return
        }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        let decodedVerdict =
            try values.decodeIfPresent(String.self, forKey: .verdict) ??
            values.decodeIfPresent(String.self, forKey: .decision)
        let normalizedVerdict = decodedVerdict?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let decodedReason =
            try values.decodeIfPresent(String.self, forKey: .reason) ??
            values.decodeIfPresent(String.self, forKey: .rationale)
        let normalizedReason = decodedReason?.trimmingCharacters(in: .whitespacesAndNewlines)
        let decodedRejected = try values.decodeIfPresent(Bool.self, forKey: .rejected)

        verdict = normalizedVerdict?.isEmpty == false ? normalizedVerdict : nil
        // The oldest persisted review shape carried only `rejected`. It is still evidence that a
        // review happened, so never present it as an unavailable review merely because it predates
        // `available`, `verdict`, and the reviewer rationale.
        rejected = decodedRejected ??
            (verdict == "reject" || verdict == "rejected")
        available = try values.decodeIfPresent(Bool.self, forKey: .available) ??
            (verdict != nil || normalizedReason?.isEmpty == false || decodedRejected != nil)
        reason = normalizedReason?.isEmpty == false
            ? normalizedReason!
            : "No adversarial review rationale was recorded."
        model = try values.decodeIfPresent(String.self, forKey: .model)
        overridden = try values.decodeIfPresent(Bool.self, forKey: .overridden)
        humanOverrideApplied = try values.decodeIfPresent(Bool.self, forKey: .humanOverrideApplied)
        failureKind = try values.decodeIfPresent(String.self, forKey: .failureKind)
    }
}

func liveApprovalConfirmationText(forSymbol symbol: String) -> String {
    "APPROVE LIVE \(symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased())"
}

struct LiveApprovalConfirmation {
    let proposalId: String
    let accountNumber: String?
    let estimatedNotional: Double?
    let typedText: String

    var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "proposalId": proposalId,
            "executionMode": "broker/live",
            "estimatedNotional": estimatedNotional ?? NSNull(),
            "typedText": typedText
        ]
        if let accountNumber {
            object["accountNumber"] = accountNumber
        }
        return object
    }
}

struct DailyStats: Decodable {
    let orderCount: Int
    let openingOrderCount: Int
    let notional: Double

    static let empty = DailyStats(orderCount: 0, openingOrderCount: 0, notional: 0)
}

struct PerformanceSummary: Decodable {
    let liveRealizedPnl: Double?
    let paperRealizedPnl: Double?
    let liveUnrealizedPnl: Double?
    let paperUnrealizedPnl: Double?
    let liveWinRate: Double?
    let paperWinRate: Double?
    let liveAverageReturnPct: Double?
    let paperAverageReturnPct: Double?
    let benchmark: BenchmarkComparison?
    let fills: [FillEvent]?
}

struct BenchmarkComparison: Decodable {
    let accountReturnPct: Double
    let benchmarkReturnPct: Double
    let excessReturnPct: Double
    let startDate: String
    let endDate: String
    let points: Int
    let benchmarkSymbol: String
    let cashFlowAdjusted: Bool?
    let netExternalFlows: Double?
}

struct FillEvent: Decodable, Identifiable {
    let id: String
    let symbol: String
    let side: String
    let quantity: Double
    let price: Double
    let notional: Double
    let status: String
    let filledAt: String
}

struct SchedulerSummary: Decodable {
    let lastRunAt: String?
    let nextRunAt: String?

    static let empty = SchedulerSummary(lastRunAt: nil, nextRunAt: nil)
}

struct WatchlistItem: Decodable, Identifiable {
    var id: String { symbol }

    let symbol: String
    let addedAt: String
}

struct PriceAlert: Decodable, Identifiable {
    let id: String
    let symbol: String
    let op: String
    let price: Double
    let note: String?
    let status: String
    let createdAt: String?
    let triggeredAt: String?
    let triggeredPrice: Double?
}

struct MobileCommand: Decodable, Identifiable {
    let id: String
    let commandType: String
    let status: String
    let error: String?
    let createdAt: String
    let queuedAt: String?
    let startedAt: String?
    let finishedAt: String?
    let updatedAt: String

    var isTerminal: Bool {
        status == "succeeded" || status == "failed" || status == "cancelled"
    }

    var didFail: Bool {
        status == "failed" || status == "cancelled"
    }
}

/// On-demand single-symbol quote + fundamentals — the mobile counterpart of the web console's
/// `/api/quote` fetch used by the symbol drilldown drawer (app/console/ui/symbol-drilldown.tsx),
/// decoded from that same flattened response. Every field is optional and rendered as an honest
/// "—"/"n/a" (see `AppFormat`) when the provider cascade didn't return it — never fabricated.
struct SymbolQuoteInfo: Decodable {
    let symbol: String
    let companyName: String?
    let price: Double?
    let intradayChangePct: Double?
    let asOf: String?
    let sector: String?
    let industry: String?
    let volume: Double?
    let peRatio: Double?
    let eps: Double?
    let dividendYield: Double?
    let beta: Double?
    let fiftyTwoWeekHigh: Double?
    let fiftyTwoWeekLow: Double?
    let analystRating: String?
    let analystScore: Double?
    let targetMean: Double?
    let targetHigh: Double?
    let targetLow: Double?
    let daysToEarnings: Double?
}

struct CommandEnvelope: Decodable {
    let command: MobileCommand
    let deduped: Bool?
}

struct DeletionRequestEnvelope: Decodable {
    let deletionRequest: AccountDeletionRequest
}

struct AccountDeletionRequest: Decodable {
    // Read-only previews intentionally have no durable request id. The backend creates the
    // prepared request only inside the final confirmation action.
    let requestId: String?
    let userId: String
    let email: String?
    let requiredText: String
    // The current mobile deletion request contract does not return an expiry.
    // Keep this additive for compatibility with servers that add one later.
    let expiresAt: String?
    let steps: [String]
}

struct AccountDeletionResult: Decodable {
    let ok: Bool
    let counts: [String: Int]
    let logoutUrl: String?

    static let successfulHTTP = AccountDeletionResult(ok: true, counts: [:], logoutUrl: nil)

    private enum CodingKeys: String, CodingKey {
        case ok
        case counts
        case logoutUrl
    }

    init(ok: Bool, counts: [String: Int], logoutUrl: String?) {
        self.ok = ok
        self.counts = counts
        self.logoutUrl = logoutUrl
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        counts = try values.decodeIfPresent([String: Int].self, forKey: .counts) ?? [:]
        logoutUrl = try values.decodeIfPresent(String.self, forKey: .logoutUrl)
    }
}
