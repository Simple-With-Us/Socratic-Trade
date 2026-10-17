import Foundation
import Combine
import Sentry

// MARK: - Duplicate command folding
//
// The `/api/mobile` snapshot can legitimately list the same `MobileCommand.id` twice
// (overlapping poll windows, or a paginated fetch that straddles a page boundary).
// Every command lookup folds those duplicates to the same deterministic winner so the
// tracker (`CommandAttemptTracker.reconcile`) and the proposal-card feedback lookup
// (`MobileStore.proposalActionFeedback`) can never disagree about which version of a
// command is current.

extension MobileCommand {
    /// Deterministic fold of two versions of the same command id: the freshest
    /// `updatedAt` wins (ISO8601 timestamps sort lexicographically), an exact timestamp
    /// tie prefers the terminal state, and a full tie keeps the existing value.  The
    /// outcome for a pair is order-independent, so lookups no longer depend on whatever
    /// array order the server happened to send.
    static func foldDuplicate(existing: MobileCommand, incoming: MobileCommand) -> MobileCommand {
        if incoming.updatedAt != existing.updatedAt {
            return incoming.updatedAt > existing.updatedAt ? incoming : existing
        }
        if incoming.isTerminal != existing.isTerminal {
            return incoming.isTerminal ? incoming : existing
        }
        return existing
    }
}

struct CommandAttemptTracker {
    private struct PendingAttempt {
        let fingerprint: String
        let idempotencyKey: String
        var commandID: String?
    }

    struct Resolution: Equatable {
        let operationID: String
        let status: String
        let error: String?
        let commandID: String?
    }

    private var attempts: [String: PendingAttempt] = [:]

    mutating func idempotencyKey(
        operationID: String,
        commandType: String,
        payload: [String: Any]
    ) -> String {
        let object: [String: Any] = ["commandType": commandType, "payload": payload]
        let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let fingerprint = data?.base64EncodedString() ?? "\(commandType):\(operationID)"
        if let pending = attempts[operationID], pending.fingerprint == fingerprint {
            return pending.idempotencyKey
        }
        let key = UUID().uuidString
        attempts[operationID] = PendingAttempt(
            fingerprint: fingerprint,
            idempotencyKey: key,
            commandID: nil
        )
        return key
    }

    mutating func track(_ command: MobileCommand, operationID: String) {
        guard var attempt = attempts[operationID] else { return }
        attempt.commandID = command.id
        attempts[operationID] = attempt
    }

    mutating func reconcile(_ commands: [MobileCommand]) -> [Resolution] {
        // The server can legitimately report the same command id twice (e.g. overlapping
        // poll windows or a paginated fetch that straddles a page boundary), and
        // `Dictionary(uniqueKeysWithValues:)` traps (hard crash) on any duplicate key.
        // Fold duplicates to a single deterministic winner instead: freshest by
        // `updatedAt`, and on an exact timestamp tie the terminal state wins
        // (`MobileCommand.foldDuplicate`).  A collision here means the server sent
        // inconsistent data, so surface it — but only when a pending attempt is actually
        // waiting on that command id, so a server-side duplicate that no local operation
        // is tracking cannot re-report itself on every poll and flood Sentry.
        var commandsByID: [String: MobileCommand] = [:]
        var duplicateIDsOnTrackedAttempts = Set<String>()
        for command in commands {
            if let existing = commandsByID[command.id] {
                commandsByID[command.id] = MobileCommand.foldDuplicate(existing: existing, incoming: command)
                if attempts.values.contains(where: { $0.commandID == command.id }) {
                    duplicateIDsOnTrackedAttempts.insert(command.id)
                }
            } else {
                commandsByID[command.id] = command
            }
        }
        if !duplicateIDsOnTrackedAttempts.isEmpty {
            SentrySDK.capture(
                message: "MobileStore.reconcile: dropped \(duplicateIDsOnTrackedAttempts.count) duplicate command id(s) from server response"
            ) { scope in
                scope.setLevel(.warning)
            }
        }
        var resolutions: [Resolution] = []
        for (operationID, attempt) in Array(attempts) {
            guard
                let commandID = attempt.commandID,
                let command = commandsByID[commandID],
                command.isTerminal
            else {
                continue
            }
            attempts.removeValue(forKey: operationID)
            resolutions.append(
                Resolution(
                    operationID: operationID,
                    status: command.status,
                    error: command.error,
                    commandID: commandID
                )
            )
        }
        return resolutions
    }

    mutating func release(operationID: String) {
        attempts.removeValue(forKey: operationID)
    }

    mutating func removeAll() {
        attempts = [:]
    }
}

/// Per-proposal approve/reject feedback — mirrors PWA `proposalActionFeedback`.
enum ProposalActionFeedback: Equatable {
    case sending(action: ProposalAction)
    case pending(action: ProposalAction, status: String)
    case failed(action: ProposalAction, message: String)
    case retryable(action: ProposalAction, message: String)
    case succeeded(action: ProposalAction)
    case placementSettled(action: ProposalAction, status: String, reasons: [String]?)

    enum ProposalAction: String, Equatable {
        case approve
        case reject
    }

    var action: ProposalAction {
        switch self {
        case .sending(let action), .pending(let action, _), .failed(let action, _), .retryable(let action, _),
             .succeeded(let action), .placementSettled(let action, _, _):
            return action
        }
    }

    var isInFlight: Bool {
        switch self {
        case .sending, .pending: return true
        case .failed, .retryable, .succeeded, .placementSettled: return false
        }
    }

    var isSettledSuccess: Bool {
        switch self {
        case .succeeded:
            return true
        case .placementSettled(let action, let status, _):
            guard action == .approve else { return true }
            return status == "filled" || status == "placed" || status == "paper"
        case .sending, .pending, .failed, .retryable:
            return false
        }
    }
}

/// Approve, reject, and cancel each end as success, a terminal failure, or a retry.
enum MoneyAction: String, Equatable {
    case approve
    case reject
    case cancel

    init?(commandType: String) {
        switch commandType {
        case "proposal.approve": self = .approve
        case "proposal.reject": self = .reject
        case "order.cancel": self = .cancel
        default: return nil
        }
    }
}

enum MoneyActionResultKind: String, Equatable {
    case success
    case failed
    case retryable
}

struct MoneyActionResult: Equatable, Identifiable {
    let action: MoneyAction
    let kind: MoneyActionResultKind
    let message: String
    /// Approve and reject results belong to one proposal.  A later result for a
    /// different proposal must not repaint this card.
    let proposalId: String?

    init(action: MoneyAction, kind: MoneyActionResultKind, message: String, proposalId: String? = nil) {
        self.action = action
        self.kind = kind
        self.message = message
        self.proposalId = proposalId
    }

    var id: String { "\(action.rawValue)|\(kind.rawValue)|\(proposalId ?? "")|\(message)" }

    func matches(_ action: ProposalActionFeedback.ProposalAction, proposalId: String) -> Bool {
        guard self.proposalId == proposalId else { return false }
        switch (self.action, action) {
        case (.approve, .approve), (.reject, .reject):
            return true
        case (.cancel, _), (.approve, .reject), (.reject, .approve):
            return false
        }
    }

    func scoped(to proposalId: String?) -> MoneyActionResult {
        MoneyActionResult(action: action, kind: kind, message: message, proposalId: proposalId)
    }

    var title: String {
        switch (action, kind) {
        case (.approve, .success): return "Approved"
        case (.reject, .success): return "Rejected"
        case (.cancel, .success): return "Order Cancelled"
        case (.approve, .failed): return "Approve Failed"
        case (.reject, .failed): return "Reject Failed"
        case (.cancel, .failed): return "Cancel Failed"
        case (.approve, .retryable): return "Try Approve Again"
        case (.reject, .retryable): return "Try Reject Again"
        case (.cancel, .retryable): return "Try Cancel Again"
        }
    }

    /// Classifies a finished mobile command.  Approve reads `result` even when the
    /// row status is `succeeded`, because a busy or not-placed placement can still
    /// land on a succeeded row.  Reject's `rejected` result is success.
    static func classify(command: MobileCommand) -> MoneyActionResult? {
        guard let action = MoneyAction(commandType: command.commandType) else { return nil }
        let detail = combinedDetail(command)
        if action == .approve, let status = command.result?.status, !status.isEmpty {
            return approveResult(
                status: status,
                outcome: command.result?.outcome,
                reasons: command.result?.reasons,
                detail: detail
            )
        }
        switch command.status {
        case "succeeded":
            return MoneyActionResult(action: action, kind: .success, message: successCopy(action))
        case "failed", "cancelled":
            return terminalFailure(action: action, command: command, detail: detail)
        default:
            return nil
        }
    }

    /// A submit that never returned a command row.  Session expiry stays on the
    /// sign-in path and does not become a money-action result.
    static func classify(commandType: String, transportError: Error) -> MoneyActionResult? {
        guard let action = MoneyAction(commandType: commandType) else { return nil }
        if let apiError = transportError as? MobileAPIError, case .unauthorized = apiError {
            return nil
        }
        let raw = (transportError as? LocalizedError)?.errorDescription ?? transportError.localizedDescription
        let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = message.isEmpty ? retryableCopy(action) : message
        if isTerminalRefusal(text) {
            return MoneyActionResult(action: action, kind: .failed, message: text)
        }
        if isTransportRetry(transportError) || isRetryableSignal(status: nil, outcome: nil, message: text) {
            return MoneyActionResult(action: action, kind: .retryable, message: text)
        }
        return MoneyActionResult(action: action, kind: .failed, message: text)
    }

    private static func approveResult(
        status: String,
        outcome: String?,
        reasons: [String]?,
        detail: String
    ) -> MoneyActionResult {
        let message = AppFormat.placementApproveMessage(status: status, reasons: reasons)
        switch status {
        case "filled", "placed", "paper":
            return MoneyActionResult(action: .approve, kind: .success, message: message)
        case "busy", "not_placed":
            return MoneyActionResult(action: .approve, kind: .retryable, message: message)
        default:
            if isRetryableSignal(status: status, outcome: outcome, message: detail), !isTerminalRefusal(detail) {
                return MoneyActionResult(action: .approve, kind: .retryable, message: message)
            }
            return MoneyActionResult(action: .approve, kind: .failed, message: message)
        }
    }

    private static func terminalFailure(
        action: MoneyAction,
        command: MobileCommand,
        detail: String
    ) -> MoneyActionResult {
        if isTerminalRefusal(detail) {
            return MoneyActionResult(action: action, kind: .failed, message: nonempty(detail, failedCopy(action)))
        }
        if isRetryableSignal(status: command.result?.status, outcome: command.result?.outcome, message: detail) {
            return MoneyActionResult(action: action, kind: .retryable, message: nonempty(detail, retryableCopy(action)))
        }
        let fallback = command.status == "cancelled" ? "The queued action was cancelled." : failedCopy(action)
        return MoneyActionResult(action: action, kind: .failed, message: nonempty(detail, fallback))
    }

    private static func combinedDetail(_ command: MobileCommand) -> String {
        let reasons = command.result?.reasons?
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let error = command.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return [reasons, error].filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func nonempty(_ detail: String, _ fallback: String) -> String {
        detail.isEmpty ? fallback : detail
    }

    private static func isTransportRetry(_ error: Error) -> Bool {
        guard let apiError = error as? MobileAPIError else { return false }
        switch apiError {
        case .network, .decoding:
            return true
        case .serverError(let statusCode, _):
            return statusCode == 408 || statusCode == 429 || statusCode >= 500
        case .scanQuotesUnavailable, .unauthorized:
            return false
        }
    }

    private static func isTerminalRefusal(_ message: String) -> Bool {
        let text = message.lowercased()
        let needles = [
            "different account",
            "no longer working",
            "not open",
            "nothing left to cancel",
            "not found",
            "blocked at approval",
            "buying power"
        ]
        return needles.contains { text.contains($0) }
    }

    private static func isRetryableSignal(status: String?, outcome: String?, message: String) -> Bool {
        switch status?.lowercased() {
        case "busy", "not_placed":
            return true
        default:
            break
        }
        switch outcome?.lowercased() {
        case "busy", "retryable":
            return true
        default:
            break
        }
        let text = message.lowercased()
        let needles = [
            "safe to retry",
            "try again",
            "timed out",
            "timeout",
            "rate-limited",
            "rate limited",
            "http 429",
            "http 408",
            "http 502",
            "http 503",
            "mutation lease",
            "uncertain",
            "never reached the broker",
            "couldn't reach",
            "couldn’t reach",
            "check your connection",
            "server is slow"
        ]
        return needles.contains { text.contains($0) }
    }

    private static func successCopy(_ action: MoneyAction) -> String {
        switch action {
        case .approve:
            return "Approved.  Waiting for the desk to refresh."
        case .reject:
            return "Rejected.  Waiting for the desk to refresh."
        case .cancel:
            return "Order cancelled.  Waiting for the desk to refresh."
        }
    }

    private static func failedCopy(_ action: MoneyAction) -> String {
        switch action {
        case .approve:
            return "Approve did not place an order."
        case .reject:
            return "Reject did not go through."
        case .cancel:
            return "That order could not be cancelled."
        }
    }

    private static func retryableCopy(_ action: MoneyAction) -> String {
        switch action {
        case .approve:
            return "Approve did not finish.  Try again."
        case .reject:
            return "Reject did not finish.  Try again."
        case .cancel:
            return "Cancel did not finish.  Try again."
        }
    }
}

@MainActor
final class MobileStore: ObservableObject {
    @Published private(set) var snapshot: MobileSnapshot?
    @Published var error: String?
    @Published var successMessage: String?
    /// Latest approve, reject, or cancel result.  Load does not clear it.
    @Published private(set) var moneyActionResult: MoneyActionResult?
    /// Bumps when account-scoped caches are dropped, so SwiftUI view state rebuilds.
    @Published private(set) var sessionEpoch = 0
    @Published private(set) var isAuthenticated = false
    @Published private(set) var hasInitialized = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var lastUpdatedAt: Date?
    @Published private(set) var isStreamConnected = false
    @Published private(set) var busyOperations: Set<String> = []
    /// Account the user asked to switch to.  Stays set until a snapshot
    /// reports that id as active, so the Use row does not go idle while the
    /// (often slow) post-switch snapshot is still in flight.
    @Published private(set) var pendingAccountId: String?
    @Published private(set) var deletionRequest: AccountDeletionRequest?
    @Published private(set) var isDeletingAccount = false
    @Published private(set) var isAcceptingConsent = false
    @Published private(set) var isSigningIn = false
    @Published private(set) var snapshotLoadFailed = false
    /// 2026-09-23 MM (held-batch): flips to true when the most recent snapshot decoded with
    /// at least one money-path collection element dropped (positions / orders /
    /// pendingProposals).  When true, Owner Approve is BLOCKED — a partial feed might hide a
    /// pending proposal the user did not see, so approving any visible card is unsafe.  Other
    /// commands (cancel, account switch, read-only browse) remain available.  See
    /// MobileSnapshot.PartialDropCounts for which collection was lossy.  UI surfaces a banner
    /// at the top of the workspace when this is set so the user understands the disable.
    @Published private(set) var partialData: Bool = false
    /// proposalId → queued command id so cards can follow approve/reject through recentCommands.
    @Published private(set) var proposalCommandIds: [String: String] = [:]
    /// proposalId → submit-time failure shown on the card itself.
    @Published private(set) var proposalNotices: [String: (message: String, action: ProposalActionFeedback.ProposalAction)] = [:]

    let client: MobileAPIClient
    private var eventTask: Task<Void, Never>?
    private var reloadInFlight = false
    private var reloadPending = false
    private var loadGeneration = 0
    private var commandAttemptTracker = CommandAttemptTracker()

    private static let cacheKey = "cached_mobile_snapshot_data"
    private static let cacheTimestampKey = "cached_mobile_snapshot_saved_at"

    private static func loadCachedSnapshot() -> MobileSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(MobileSnapshot.self, from: data)
    }

    private static func loadCachedSnapshotSavedAt() -> Date? {
        let interval = UserDefaults.standard.double(forKey: cacheTimestampKey)
        guard interval > 0 else { return nil }
        return Date(timeIntervalSince1970: interval)
    }

    private static func saveCachedSnapshot(_ data: Data) {
        UserDefaults.standard.set(data, forKey: cacheKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: cacheTimestampKey)
    }

    init(client: MobileAPIClient, previewSnapshot: MobileSnapshot? = nil) {
        self.client = client
        let cached = previewSnapshot ?? Self.loadCachedSnapshot()
        snapshot = cached
        // 2026-09-23 MM (held-batch): seed partialData from the preview snapshot so tests can
        // assert the gating path without going through a real load().
        partialData = cached?.partialData ?? false
        isAuthenticated = cached != nil
        hasInitialized = previewSnapshot != nil
        if cached == nil {
            lastUpdatedAt = nil
        } else if previewSnapshot != nil {
            lastUpdatedAt = Date()
        } else {
            lastUpdatedAt = Self.loadCachedSnapshotSavedAt()
        }
    }

    var isInitialLoading: Bool {
        !hasInitialized && snapshot == nil
    }

    var hasActiveCommandWork: Bool {
        !busyOperations.isEmpty
    }

    func isBusy(_ operationID: String) -> Bool {
        busyOperations.contains(operationID)
    }

    func isAccountActive(_ account: ConnectedAccount) -> Bool {
        if let pendingAccountId {
            return account.id == pendingAccountId
        }
        return account.isActive == true
    }

    func displayedActiveAccount(in snapshot: MobileSnapshot) -> ConnectedAccount? {
        if let pendingAccountId,
           let pending = snapshot.connectedAccounts.first(where: { $0.id == pendingAccountId }) {
            return pending
        }
        return snapshot.readiness.activeConnectedAccount
            ?? snapshot.connectedAccounts.first(where: { $0.isActive == true })
    }

    /// Derive on-card approve/reject feedback: sending → queued/running → succeeded/failed.
    func proposalActionFeedback(proposalId: String) -> ProposalActionFeedback? {
        let approveOp = "proposal.approve:\(proposalId)"
        let rejectOp = "proposal.reject:\(proposalId)"
        if busyOperations.contains(approveOp) {
            return .sending(action: .approve)
        }
        if busyOperations.contains(rejectOp) {
            return .sending(action: .reject)
        }
        if let notice = proposalNotices[proposalId] {
            if let result = moneyActionResult, result.matches(notice.action, proposalId: proposalId) {
                return proposalFeedback(from: result, command: nil)
            }
            return .failed(action: notice.action, message: notice.message)
        }
        guard
            let commandID = proposalCommandIds[proposalId],
            let command = recentCommand(id: commandID)
        else {
            return nil
        }
        let action: ProposalActionFeedback.ProposalAction =
            command.commandType == "proposal.reject" ? .reject : .approve
        switch command.status {
        case "queued", "running":
            return .pending(action: action, status: command.status)
        case "failed":
            if let result = MoneyActionResult.classify(command: command) {
                return proposalFeedback(from: result, command: command)
            }
            let detail = command.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            let message = (detail?.isEmpty == false)
                ? detail!
                : "Command failed — check Activity for details."
            return .failed(action: action, message: message)
        case "succeeded":
            if action == .approve, command.result != nil,
               let result = MoneyActionResult.classify(command: command) {
                return proposalFeedback(from: result, command: command)
            }
            return .succeeded(action: action)
        default:
            return nil
        }
    }

    /// Folds every `recentCommands` entry that carries `commandID` through the same
    /// duplicate policy the tracker uses (`MobileCommand.foldDuplicate`).  A naive
    /// `first(where:)` could select the stale member of a duplicated id and show the card
    /// stuck in `queued` while `reconcile` already saw the terminal update.
    private func recentCommand(id commandID: String) -> MobileCommand? {
        guard let commands = snapshot?.recentCommands else { return nil }
        var folded: MobileCommand?
        for command in commands where command.id == commandID {
            guard let current = folded else {
                folded = command
                continue
            }
            folded = MobileCommand.foldDuplicate(existing: current, incoming: command)
        }
        return folded
    }

    private func proposalFeedback(
        from result: MoneyActionResult,
        command: MobileCommand?
    ) -> ProposalActionFeedback {
        let action: ProposalActionFeedback.ProposalAction = result.action == .reject ? .reject : .approve
        switch result.kind {
        case .success:
            if result.action == .approve, let status = command?.result?.status, !status.isEmpty {
                return .placementSettled(action: action, status: status, reasons: command?.result?.reasons)
            }
            return .succeeded(action: action)
        case .failed:
            return .failed(action: action, message: result.message)
        case .retryable:
            return .retryable(action: action, message: result.message)
        }
    }

    func dismissMoneyActionResult() {
        moneyActionResult = nil
    }

    /// XCTest seam and the reconcile path.  Sets the alert result for approve, reject, and cancel.
    func recordResolvedCommand(_ command: MobileCommand) {
        guard let result = MoneyActionResult.classify(command: command) else { return }
        let proposalId = proposalCommandIds.first(where: { $0.value == command.id })?.key
        moneyActionResult = result.scoped(to: proposalId)
    }

    /// XCTest seam.  Submit writes the same notice when an approve or reject fails.
    func stageProposalNotice(
        proposalId: String,
        action: ProposalActionFeedback.ProposalAction,
        message: String
    ) {
        proposalNotices[proposalId] = (message: message, action: action)
    }

    /// XCTest seam.  Marks an operation busy the way `submit` does before the broker returns.
    func armBusyOperation(_ operationID: String) {
        busyOperations.insert(operationID)
    }

    /// The account-switch cache wipe drops the attempt tracker, so reconcile can no
    /// longer see the activate command and its operation id stays busy forever.
    /// Re-seed that one attempt and let reconcile release it.
    func finishAccountSwitch(_ command: MobileCommand, operationID: String, payload: [String: Any]) {
        _ = commandAttemptTracker.idempotencyKey(
            operationID: operationID,
            commandType: command.commandType,
            payload: payload
        )
        commandAttemptTracker.track(command, operationID: operationID)
        busyOperations.insert(operationID)
        reconcileTrackedCommands([command])
    }

    func stagePendingAccountSwitch(_ accountId: String) {
        pendingAccountId = accountId
    }

    func isSnapshotStale(at now: Date = Date()) -> Bool {
        guard let lastUpdatedAt else { return snapshot != nil }
        return now.timeIntervalSince(lastUpdatedAt) > 180
    }

    /// When the snapshot is stale, do not trust cached `marketSession` from the server payload.
    func displayMarketSession(for snapshot: MobileSnapshot, at now: Date = Date()) -> String {
        guard isSnapshotStale(at: now) else { return snapshot.marketSession }
        return NYSEMarketSession.sessionKey(now: now) ?? snapshot.marketSession
    }

    func deriveRunState(for snapshot: MobileSnapshot, at now: Date = Date()) -> RunStateWord {
        deriveRunStateWord(
            snapshot: snapshot,
            useDeviceMarketSession: isSnapshotStale(at: now),
            now: now
        )
    }

    /// Capability discovery from the server-advertised control catalog
    /// (`snapshot.catalog.commands[].type`).  Two deliberate fallbacks:
    /// - No snapshot yet, no catalog field, or an empty `commands` array means the server did
    ///   not answer the question — assume supported, so an older server (or a payload that
    ///   drops the field) never silently disables working controls.
    /// - Protective commands are never gated on this (see `canSubmit`): a halt must not depend
    ///   on the catalog decoding correctly.
    func serverAdvertises(_ commandType: String) -> Bool {
        guard let catalog = snapshot?.catalog, catalog.describesCommands else { return true }
        return catalog.advertisedCommandTypes.contains(commandType)
    }

    func canSubmit(_ commandType: String, at now: Date = Date()) -> Bool {
        if Self.protectiveCommands.contains(commandType) {
            return true
        }
        // A command this deployment does not advertise would be rejected by the server's
        // `isMobileCommandType` check anyway — refuse it here instead of spending a round
        // trip to collect a 400.
        if !serverAdvertises(commandType) {
            return false
        }
        // Account switch is a pure active-pointer flip on the server (now also executes
        // immediately, outside the strategy.run_once queue). It must remain available when
        // portfolio/snapshot data is stale — that is exactly when users try to switch away
        // from a stuck/stale context. Requires any loaded snapshot so we still know accounts.
        if commandType == "account.activate" {
            return snapshot != nil
        }
        // Cancel is exempt for the same reason, more sharply: a flaky connection — which is what
        // a stale snapshot usually means — is exactly when someone reaches for the cancel button.
        // Safe to allow on a stale view because the SERVER re-validates: the mobile lane runs
        // `cancelWorkingOrder` with `requireWorkingOrder: true` and refuses with 404/409 when the
        // order is no longer working or is not in the selected account, so a stale tap collects an
        // honest error instead of cancelling the wrong thing.  Requires any loaded snapshot so we
        // still have an order row and an account number to send.
        if commandType == "order.cancel" {
            return snapshot != nil
        }
        // Owner Approve is the same class of exemption: a stale or failed snapshot is
        // exactly when a pending card looks stuck (Retry Red Team is a long LLM, then
        // `load()` can miss the 30s mobile timeout).  The server re-validates the
        // `proposed -> placing` claim and the halt / Exit-only / liquidating fence, so a
        // stale tap collects an honest error instead of placing the wrong order.
        // Requires any loaded snapshot so we still have a proposal id and account.
        //
        // 2026-09-23 MM (held-batch): PARTIAL DATA overrides that exemption.  When
        // `partialData == true`, at least one money-path collection element was dropped
        // during decode (a malformed position / order / pending proposal).  Approving a
        // visible card when a non-visible one might be pending is a CLASS of bug worse
        // than staleness, because the user has no UI affordance to know a card is missing.
        // Block until the next refresh lands a clean decode.  Read-only commands
        // (cancel, account switch, browse) keep working — only the destructive approval
        // path is gated.
        if commandType == "proposal.approve" {
            guard snapshot != nil else { return false }
            return !partialData
        }
        guard let snapshot, !isSnapshotStale(at: now) else { return false }
        if Self.readinessDependentCommands.contains(commandType) {
            return snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse
        }
        return true
    }

    func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        let shouldReportSessionExpiry = hasInitialized || isAuthenticated
        isRefreshing = true
        defer {
            if generation == loadGeneration {
                isRefreshing = false
                hasInitialized = true
            }
        }
        do {
            let (loadedSnapshot, rawData) = try await fetchSnapshotWithNetworkRetry(
                timeout: 45,
                generation: generation
            )
            guard generation == loadGeneration else { return }
            snapshot = loadedSnapshot
            Self.saveCachedSnapshot(rawData)
            lastUpdatedAt = Date()
            snapshotLoadFailed = false
            partialData = loadedSnapshot.partialData
            isAuthenticated = true
            error = nil
            if let pendingAccountId,
               loadedSnapshot.connectedAccounts.contains(where: { $0.id == pendingAccountId && $0.isActive == true })
                || loadedSnapshot.readiness.activeConnectedAccount?.id == pendingAccountId {
                self.pendingAccountId = nil
            }
            reconcileTrackedCommands(loadedSnapshot.recentCommands)
        } catch is CancellationError {
            return
        } catch let caught {
            guard generation == loadGeneration else { return }
            snapshotLoadFailed = true
            if snapshot == nil {
                applyAuthAwareError(caught, showUnauthorizedMessage: shouldReportSessionExpiry)
            } else if let apiError = caught as? MobileAPIError, case .unauthorized = apiError {
                applyAuthAwareError(caught, showUnauthorizedMessage: shouldReportSessionExpiry)
            } else {
                // Cached snapshot stays on screen; do not keep a prior transient error banner.
                error = nil
            }
        }
    }

    func startEvents() {
        eventTask?.cancel()
        eventTask = Task { [weak self, client] in
            var retryDelay: Double = 1.0
            while !Task.isCancelled {
                do {
                    // onConnect fires on stream establishment and every received line (incl.
                    // ": ping" heartbeats), so the indicator is truthful on a healthy idle stream.
                    try await client.events(onConnect: {
                        Task { @MainActor [weak self] in
                            self?.isStreamConnected = true
                        }
                    }, onEvent: {
                        Task { @MainActor [weak self] in
                            self?.isStreamConnected = true
                            self?.scheduleReload()
                        }
                    })
                    retryDelay = 1.0
                    if !Task.isCancelled {
                        self?.isStreamConnected = false
                    }
                } catch is CancellationError {
                    return
                } catch {
                    self?.isStreamConnected = false
                    // SSE sockets drop often (Cloudflare/QUIC resets, idle gaps). Reconnect
                    // quietly when we already have data; only surface 401/403 or a blank screen.
                    if let apiError = error as? MobileAPIError, case .unauthorized = apiError {
                        self?.applyAuthAwareError(apiError, preserveTransientMessage: false)
                    } else if self?.snapshot == nil {
                        self?.applyAuthAwareError(error, preserveTransientMessage: true)
                    }
                    if self?.isAuthenticated != true { return }
                    retryDelay = min(30.0, retryDelay * 1.5)
                    
                    // Polling fallback: if the stream drops, reload the snapshot
                    // while we wait for the backoff timer to reconnect.
                    Task { @MainActor [weak self] in
                        self?.scheduleReload()
                    }
                }

                let jitter = Double.random(in: 0.1...0.5)
                let delayNanoseconds = UInt64((retryDelay + jitter) * 1_000_000_000)
                do {
                    try await Task.sleep(nanoseconds: delayNanoseconds)
                } catch {
                    return
                }
            }
        }
    }

    func stopEvents() {
        eventTask?.cancel()
        eventTask = nil
        isStreamConnected = false
    }

    @discardableResult
    func submit(
        _ commandType: String,
        payload: [String: Any] = [:],
        operationID: String? = nil
    ) async -> Bool {
        let operationID = operationID ?? commandType
        guard !busyOperations.contains(operationID) else { return false }
        guard canSubmit(commandType) else {
            error = unavailableMessage(for: commandType)
            return false
        }
        let idempotencyKey = commandAttemptTracker.idempotencyKey(
            operationID: operationID,
            commandType: commandType,
            payload: payload
        )
        busyOperations.insert(operationID)
        if commandType == "account.activate", let accountId = payload["accountId"] as? String {
            stagePendingAccountSwitch(accountId)
        }
        let proposalId = payload["proposalId"] as? String
        let proposalAction: ProposalActionFeedback.ProposalAction? = {
            switch commandType {
            case "proposal.approve": return .approve
            case "proposal.reject": return .reject
            default: return nil
            }
        }()
        if let proposalId, proposalAction != nil {
            proposalNotices.removeValue(forKey: proposalId)
        }

        do {
            let command = try await client.submit(
                commandType: commandType,
                payload: payload,
                idempotencyKey: idempotencyKey
            )
            commandAttemptTracker.track(command, operationID: operationID)
            if let proposalId, proposalAction != nil {
                proposalCommandIds[proposalId] = command.id
            }
            // Stop / other immediate commands return terminal in the POST body, so
            // drop the spinner before the snapshot reload.  Account switch is the
            // exception: the Use row must stay busy until the new snapshot arrives,
            // otherwise the sheet looks dead and then snaps to the requested account.
            if commandType == "account.activate" {
                if command.didFail {
                    pendingAccountId = nil
                    reconcileTrackedCommands([command])
                } else {
                    clearAccountScopedCachesForAccountSwitch()
                    await load()
                    if let pending = pendingAccountId,
                       snapshot?.readiness.activeConnectedAccount?.id != pending,
                       snapshot?.connectedAccounts.first(where: { $0.id == pending })?.isActive != true {
                        error = "Switched accounts.  Waiting for the new portfolio to load."
                    }
                    finishAccountSwitch(command, operationID: operationID, payload: payload)
                }
            } else {
                if commandType.hasPrefix("proposal.") {
                    // Queue ACK is enough to leave "Sending…".  A slow snapshot
                    // reload must not lock the card on a 30s timeout.
                    busyOperations.remove(operationID)
                }
                reconcileTrackedCommands([command])
                await load()
                reconcileTrackedCommands([command])
            }
            if command.didFail, let proposalId, let proposalAction,
               MoneyActionResult.classify(command: command) == nil {
                let detail = command.error?.trimmingCharacters(in: .whitespacesAndNewlines)
                proposalNotices[proposalId] = (
                    message: (detail?.isEmpty == false)
                        ? detail!
                        : "The queued action was \(command.status).",
                    action: proposalAction
                )
            }
            return !command.didFail
        } catch is CancellationError {
            if commandType == "account.activate" { pendingAccountId = nil }
            busyOperations.remove(operationID)
            return false
        } catch let caught {
            if commandType == "account.activate" { pendingAccountId = nil }
            if shouldReleaseCommandAttempt(after: caught) {
                commandAttemptTracker.release(operationID: operationID)
            }
            // Network/decoding errors keep the idempotency key for an explicit retry, but they do
            // not leave the control visually locked when no command id was confirmed.
            busyOperations.remove(operationID)
            if let apiError = caught as? MobileAPIError, case .unauthorized = apiError {
                applyAuthAwareError(caught)
                return false
            }
            if let result = MoneyActionResult.classify(commandType: commandType, transportError: caught) {
                moneyActionResult = result.scoped(to: proposalId)
                if let proposalId, let proposalAction {
                    proposalNotices[proposalId] = (message: result.message, action: proposalAction)
                }
                return false
            }
            if let proposalId, let proposalAction {
                proposalNotices[proposalId] = (
                    message: caught.localizedDescription,
                    action: proposalAction
                )
            }
            applyAuthAwareError(caught)
            return false
        }
    }

    /// On-demand single-symbol quote for `SymbolInfoSheet`. Unlike `load()`, this does not touch
    /// `snapshot`/`error`/`isRefreshing` — the sheet owns its own loading/error state, and
    /// `client` is otherwise private to this store, so views reach it through this passthrough.
    func fetchSymbolQuote(_ symbol: String) async throws -> SymbolQuoteInfo {
        try await client.symbolQuote(symbol)
    }

    func fetchSymbolDesk(_ symbol: String) async throws -> SymbolDeskInfo {
        try await client.symbolDesk(symbol)
    }

    func fetchChatHistory() async throws -> [ChatTurn] {
        try await client.chatHistory()
    }

    func sendChat(message: String, model: String?, clientTurnId: String) async throws -> ChatReply {
        try await client.sendChat(message: message, model: model, clientTurnId: clientTurnId)
    }

    func clearChatHistory() async throws {
        try await client.clearChatHistory()
    }

    func fetchChatProviders() async throws -> [String: Bool] {
        try await client.chatProviders()
    }

    func fetchMarketScan() async throws -> MarketScanResponse {
        try await client.marketScan()
    }

    func fetchFullPolicy() async throws -> FullPolicy {
        try await client.fullPolicy()
    }

    func fetchSourceFeatures() async throws -> SourceFeaturesResponse {
        try await client.sourceFeatures()
    }

    func patchSourceFeatures(_ settings: [String: Any]) async throws -> SourceFeaturesResponse {
        try await client.patchSourceFeatures(settings)
    }

    func fetchLlmBudget() async throws -> LlmBudgetResponse {
        try await client.llmBudget()
    }

    func patchLlmBudget(_ body: [String: Any]) async throws -> LlmBudgetResponse {
        try await client.patchLlmBudget(body)
    }

    var needsAppConsent: Bool {
        snapshot?.readiness.requiresAppConsent == true
    }

    func acceptAppConsent() async {
        guard !isAcceptingConsent else { return }
        isAcceptingConsent = true
        defer { isAcceptingConsent = false }
        do {
            try await client.acceptAppConsent()
            error = nil
            await load()
        } catch {
            applyAuthAwareError(error)
        }
    }

    func acknowledgeNotifications(ids: [String]) async {
        let unique = Array(Set(ids.filter { !$0.isEmpty }))
        guard !unique.isEmpty else { return }
        do {
            _ = try await client.acknowledgeNotifications(ids: unique)
            error = nil
            await load()
        } catch {
            applyAuthAwareError(error)
        }
    }

    func loadAccountDeletionPreview() async {
        guard !isDeletingAccount else { return }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            deletionRequest = try await client.accountDeletionPreview()
            error = nil
        } catch {
            applyAuthAwareError(error)
        }
    }

    func clearAccountDeletionPreview() {
        deletionRequest = nil
    }

    func confirmAccountDeletion(typedIdentity: String, typedText: String) async -> URL? {
        guard deletionRequest != nil, !isDeletingAccount else { return nil }
        isDeletingAccount = true
        defer { isDeletingAccount = false }
        do {
            let result = try await client.confirmAccountDeletion(
                typedIdentity: typedIdentity,
                typedText: typedText
            )
            // The HTTP success is authoritative. Clear cookies and all in-memory account state
            // before inspecting optional receipt fields so response drift cannot preserve access.
            clearLocalSession()
            return client.resolvedURL(result.logoutUrl ?? "/logout")
        } catch {
            applyAuthAwareError(error)
            return nil
        }
    }

    func loginWithApple(identityToken: String, name: String?) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            _ = try await client.loginWithApple(identityToken: identityToken, name: name)
            isAuthenticated = true
            error = nil
            await load()
            if isAuthenticated {
                startEvents()
                await claimPushTokenForCurrentSession()
            }
        } catch {
            applyAuthAwareError(error)
            self.error = "Apple Sign-In failed: \(error.localizedDescription)"
        }
    }

    func loginWithWebAuthCode(_ code: String, verifier: String) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            try await client.exchangeWebAuthCode(code, verifier: verifier)
            await load()
            if isAuthenticated {
                startEvents()
                await claimPushTokenForCurrentSession()
            } else if error == nil {
                error = "Authentication failed after web sign-in.  Try again."
            }
        } catch {
            applyAuthAwareError(error)
            self.error = "Web sign-in could not be completed.  Try again."
        }
    }

    func dismissError() {
        error = nil
    }

    func dismissSuccess() {
        successMessage = nil
    }

    /// Re-register this device's APNs token under the session that just began.
    ///
    /// Registration is otherwise only attempted at cold start, for a session that was ALREADY
    /// restored — which leaves a real window on a shared device: when one owner's session expires
    /// (`clearLocalSession` drops only the local belief; it cannot send an authenticated delete,
    /// and the system token stays valid) and a DIFFERENT account signs in, the server row still
    /// belongs to the previous owner and still delivers their alerts to this phone until the next
    /// cold launch.  Registering here hands the token to the new session immediately — the server
    /// reassigns the row on conflict — and it is also what gets push working on a first sign-in
    /// without making the owner relaunch the app.  Never prompts: it re-asserts an existing grant
    /// only, and does nothing when notifications were never authorized.
    private func claimPushTokenForCurrentSession() async {
        await PushNotificationCoordinator.shared.registerIfAlreadyAuthorized()
    }

    /// Explicit sign-out.  The portfolio, snapshot cache, and URL cache drop immediately.
    /// Session cookies stay until the authenticated push delete finishes.
    func signOut() async {
        stopEvents()
        clearPresentedAccountState()
        busyOperations = []
        pendingAccountId = nil
        isRefreshing = false
        isAuthenticated = false
        hasInitialized = true
        removeAccountScopedPersistence()
        sessionEpoch &+= 1
        await PushNotificationCoordinator.shared.signOutAndForgetToken()
        clearSessionCookies()
    }

    func clearLocalSession() {
        clearAccountScopedUIState()
        clearPersistedSessionCredentials()
    }

    /// XCTest seam: bind a proposal card to a `recentCommands` row without a network submit.
    func bindProposalCommand(proposalId: String, commandId: String) {
        proposalCommandIds[proposalId] = commandId
    }

    /// Drops the previous account's caches and in-memory stores without ending the session.
    /// Cookies, the pending account id, and the in-flight switch spinner stay.
    func clearAccountScopedCachesForAccountSwitch() {
        clearPresentedAccountState()
        isRefreshing = true
        sessionEpoch &+= 1
        removeAccountScopedPersistence()
    }

    /// In-memory account state only — leaves cookies and the disk snapshot row intact so an
    /// authenticated push delete can still run after sign-out begins.  A session that merely
    /// expires also comes through here, and that path cannot send the delete.
    func clearAccountScopedUIState() {
        stopEvents()
        PushNotificationCoordinator.shared.forgetTokenLocally()
        clearPresentedAccountState()
        busyOperations = []
        pendingAccountId = nil
        isRefreshing = false
        isAuthenticated = false
        hasInitialized = true
    }

    private func clearPresentedAccountState() {
        loadGeneration &+= 1
        snapshot = nil
        lastUpdatedAt = nil
        snapshotLoadFailed = false
        partialData = false
        deletionRequest = nil
        proposalCommandIds = [:]
        proposalNotices = [:]
        commandAttemptTracker.removeAll()
        error = nil
        successMessage = nil
        moneyActionResult = nil
    }

    private func clearPersistedSessionCredentials() {
        clearSessionCookies()
        removeAccountScopedPersistence()
        sessionEpoch &+= 1
    }

    private func clearSessionCookies() {
        let cookieStorage = client.session.configuration.httpCookieStorage ?? HTTPCookieStorage.shared
        for cookie in cookieStorage.cookies ?? [] where client.ownsCookie(cookie) {
            cookieStorage.deleteCookie(cookie)
        }
    }

    /// UserDefaults snapshot plus every URL cache this client can read back.
    /// Device preferences (tab layout, Coach model) are not account data and stay.
    private func removeAccountScopedPersistence() {
        UserDefaults.standard.removeObject(forKey: Self.cacheKey)
        UserDefaults.standard.removeObject(forKey: Self.cacheTimestampKey)
        URLCache.shared.removeAllCachedResponses()
        client.session.configuration.urlCache?.removeAllCachedResponses()
    }

    private func scheduleReload() {
        guard !reloadInFlight else {
            reloadPending = true
            return
        }
        reloadInFlight = true
        Task { [weak self] in
            guard let self else { return }
            repeat {
                reloadPending = false
                await load()
            } while reloadPending && !Task.isCancelled
            reloadInFlight = false
        }
    }

    private func reconcileTrackedCommands(_ commands: [MobileCommand]) {
        let resolutions = commandAttemptTracker.reconcile(commands)
        for resolution in resolutions {
            busyOperations.remove(resolution.operationID)
            if let commandID = resolution.commandID,
               let command = foldedCommand(id: commandID, in: commands),
               MoneyActionResult.classify(command: command) != nil {
                recordResolvedCommand(command)
                continue
            }
            if resolution.status == "succeeded",
               resolution.operationID.hasPrefix(PolicyTightening.commandType) {
                successMessage = "Guardrails updated."
                continue
            }
            guard resolution.status == "failed" || resolution.status == "cancelled" else { continue }
            let detail = resolution.error?.trimmingCharacters(in: .whitespacesAndNewlines)
            error = detail?.isEmpty == false
                ? detail
                : "The queued action was \(resolution.status)."
        }
    }

    private func foldedCommand(id commandID: String, in commands: [MobileCommand]) -> MobileCommand? {
        var folded: MobileCommand?
        for command in commands where command.id == commandID {
            guard let current = folded else {
                folded = command
                continue
            }
            folded = MobileCommand.foldDuplicate(existing: current, incoming: command)
        }
        return folded
    }

    private func fetchSnapshotWithNetworkRetry(
        timeout: TimeInterval,
        generation: Int
    ) async throws -> (MobileSnapshot, Data) {
        let maxAttempts = 2
        for attempt in 0..<maxAttempts {
            do {
                return try await client.snapshotData(timeout: timeout)
            } catch let error as MobileAPIError {
                guard case .network = error else { throw error }
                if attempt >= maxAttempts - 1 { throw error }
                let backoffNs: UInt64 = attempt == 0 ? 1_500_000_000 : 3_000_000_000
                try await Task.sleep(nanoseconds: backoffNs)
                guard generation == loadGeneration else { throw CancellationError() }
            }
        }
        throw CancellationError()
    }

    private func applyAuthAwareError(
        _ caught: Error,
        preserveTransientMessage: Bool = true,
        showUnauthorizedMessage: Bool = true
    ) {
        if let apiError = caught as? MobileAPIError, case .unauthorized = apiError {
            clearLocalSession()
            error = showUnauthorizedMessage ? apiError.localizedDescription : nil
            return
        }
        if preserveTransientMessage {
            if MobileAPIError.isUserCancellation(caught) { return }
            if let apiError = caught as? MobileAPIError {
                guard let description = apiError.errorDescription else {
                    error = nil
                    return
                }
                error = description
            } else if let message = MobileAPIError.userFacingNetworkMessage(for: caught) {
                error = message
            } else {
                error = caught.localizedDescription
            }
        }
    }

    private func shouldReleaseCommandAttempt(after error: Error) -> Bool {
        guard let apiError = error as? MobileAPIError else { return false }
        switch apiError {
        case .serverError, .unauthorized, .scanQuotesUnavailable:
            return true
        case .network, .decoding:
            return false
        }
    }

    private func unavailableMessage(for commandType: String) -> String {
        if !serverAdvertises(commandType) {
            return "This version cannot run \(AppFormat.commandLabel(commandType)) yet."
        }
        if Self.readinessDependentCommands.contains(commandType),
           let snapshot,
           !snapshot.readiness.hasAccount || !snapshot.readiness.hasUniverse {
            return "Connect an account and configure a symbol universe before running the agent."
        }
        return "Pull to refresh, then try again.  Stop remains available."
    }

    private static let protectiveCommands: Set<String> = [
        "strategy.stop",
        "strategy.close_only",
        "strategy.liquidating",
        "proposal.reject"
    ]

    private static let readinessDependentCommands: Set<String> = [
        "strategy.run_once",
        "strategy.start"
    ]
}
