import SwiftUI

struct ProposalsView: View {
    @Environment(MobileStore.self) private var store

    @State private var confirmingProposal: PendingProposal?
    @State private var confirmationText = ""
    @State private var presentedSymbol: PresentedSymbol?
    /// Triage choices persist across launches (key convention: appLock.enabled.v1, mobileTabs.v1).
    @AppStorage("proposals.filter.v1") private var proposalFilter: ProposalTriageFilter = .all
    @AppStorage("proposals.sort.v1") private var proposalSort: ProposalSortOrder = .newest
    /// Set when a deep link named one proposal: that card is scrolled to and ringed.
    @Binding private var focusedProposalId: String?
    /// Session-only triage override for a deep-linked landing: shows .all WITHOUT touching the
    /// persisted `proposals.filter.v1` choice (Kody 68B7ma — a persisted write erased the user's
    /// saved selection across launches). Cleared as soon as the user picks a chip themselves.
    @State private var deepLinkFilterOverride: ProposalTriageFilter?

    init(focusedProposalId: Binding<String?> = .constant(nil)) {
        self._focusedProposalId = focusedProposalId
    }

    var body: some View {
        SnapshotScaffold(scrollTarget: focusedProposalId) { snapshot in
            ProposalQueueSummary(snapshot: snapshot)
                .cardSpansAllColumns()
                .onChange(of: focusedProposalId) { _, target in
                    if target != nil { deepLinkFilterOverride = .all }
                }
                .onChange(of: proposalFilter) { _, _ in
                    deepLinkFilterOverride = nil
                }
            if snapshot.pendingProposals.isEmpty {
                EmptyStateCard(
                    title: "No proposals waiting",
                    message: "New decisions will appear here after a strategy run.",
                    systemImage: "checkmark.seal"
                )
            } else {
                ProposalTriageBar(
                    filter: $proposalFilter,
                    sort: $proposalSort
                )
                .cardSpansAllColumns()
                let visible = sortedProposals(
                    snapshot.pendingProposals.filter { matchesProposalFilter($0, filter: deepLinkFilterOverride ?? proposalFilter) },
                    by: proposalSort
                )
                if visible.isEmpty {
                    EmptyStateCard(
                        title: "No Matching Proposals",
                        message: "No proposals match this filter.",
                        systemImage: "line.3.horizontal.decrease.circle"
                    )
                } else {
                    ForEach(visible) { proposal in
                        let feedback = store.proposalActionFeedback(proposalId: proposal.id)
                        ProposalCard(
                            proposal: proposal,
                            positions: snapshot.positions,
                            proposalExpiryMinutes: snapshot.policy.proposalExpiryMinutes,
                            feedback: feedback,
                            approveBusy: store.isBusy(approveOperationID(proposal)),
                            rejectBusy: store.isBusy(rejectOperationID(proposal)),
                            retryBusy: store.isBusy(retryOperationID(proposal)),
                            approveDisabled: !store.canSubmit("proposal.approve"),
                            rejectDisabled: !store.canSubmit("proposal.reject"),
                            retryDisabled: !store.canSubmit("proposal.retry_red_team"),
                            requiresTypedConfirmation: requiresLiveConfirmation(proposal, snapshot: snapshot),
                            openingInExitOnly: openingInExitOnly(proposal, snapshot: snapshot),
                            approve: { approve(proposal, snapshot: snapshot) },
                            reject: { reject(proposal) },
                            retryRedTeam: { retryRedTeam(proposal) },
                            presentedSymbol: $presentedSymbol
                        )
                        // Swipe is REJECT-only — approval always goes through the buttons
                        // (and, for live orders, the typed confirmation).  Same handler and
                        // ceremony as the on-card Reject button.
                        .swipeRevealAction(
                            title: "Reject",
                            systemImage: "xmark",
                            tint: AppPalette.negative,
                            isEnabled: store.canSubmit("proposal.reject")
                                && !store.isBusy(rejectOperationID(proposal))
                                && feedback?.isInFlight != true
                                && feedback?.isSettledSuccess != true
                        ) {
                            reject(proposal)
                        }
                        .id(proposal.id)
                        .overlay {
                            if focusedProposalId == proposal.id {
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(AppPalette.accent, lineWidth: 2)
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Proposals")
        .navigationBarTitleDisplayMode(.inline)
        // The only place the app asks for notification permission on its own.  This screen is
        // "things are waiting for your judgment" — the exact subject of a push — so the prompt
        // arrives with context, from a signed-in owner who has already seen the app.  It never
        // fires at cold start, and it asks once (the coordinator returns immediately unless the
        // system status is still notDetermined).
        .task {
            guard store.isAuthenticated else { return }
            await PushNotificationCoordinator.shared.requestAuthorizationOnAlertScreen()
        }
        .sheet(item: $presentedSymbol) { presented in
            SymbolInfoSheet(symbol: presented.symbol)
        }
        .alert(
            DeskCopy.proposalConfirmOrderTitle,
            isPresented: Binding(
                get: { confirmingProposal != nil },
                set: { isPresented in
                    if !isPresented { resetConfirmation() }
                }
            ),
            presenting: confirmingProposal
        ) { proposal in
            TextField(expectedConfirmation(for: proposal), text: $confirmationText)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button(DeskCopy.proposalApproveOrderButton, role: .destructive) {
                approveConfirmedLiveProposal(proposal)
            }
            .disabled(!confirmationMatches(proposal))
            Button("Cancel", role: .cancel) {
                resetConfirmation()
            }
        } message: { proposal in
            Text("Type exactly “\(expectedConfirmation(for: proposal))”.  This places the order through your connected account.")
        }
    }

    private func requiresLiveConfirmation(_ proposal: PendingProposal, snapshot: MobileSnapshot) -> Bool {
        proposal.executionMode == "broker/live" && (snapshot.policy.requireTypedConfirmation ?? true)
    }

    private func openingInExitOnly(_ proposal: PendingProposal, snapshot: MobileSnapshot) -> Bool {
        let state = snapshot.policy.systemState ?? snapshot.readiness.systemState
        let side = proposal.proposal.side.lowercased()
        return state == "close_only" && (side == "buy" || side == "short")
    }

    private func approve(_ proposal: PendingProposal, snapshot: MobileSnapshot) {
        if requiresLiveConfirmation(proposal, snapshot: snapshot) {
            AppHaptics.warning()
            confirmationText = ""
            confirmingProposal = proposal
        } else {
            AppHaptics.success()
            Task {
                await store.submit(
                    "proposal.approve",
                    payload: ["proposalId": proposal.id],
                    operationID: approveOperationID(proposal)
                )
            }
        }
    }

    private func reject(_ proposal: PendingProposal) {
        AppHaptics.light()
        Task {
            await store.submit(
                "proposal.reject",
                payload: ["proposalId": proposal.id],
                operationID: rejectOperationID(proposal)
            )
        }
    }

    private func retryRedTeam(_ proposal: PendingProposal) {
        AppHaptics.medium()
        Task {
            await store.submit(
                "proposal.retry_red_team",
                payload: ["proposalId": proposal.id],
                operationID: retryOperationID(proposal)
            )
        }
    }

    private func approveConfirmedLiveProposal(_ proposal: PendingProposal) {
        AppHaptics.heavy()
        let confirmation = LiveApprovalConfirmation(
            proposalId: proposal.id,
            accountNumber: proposal.accountNumber,
            estimatedNotional: proposal.estimatedNotional,
            typedText: confirmationText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        )
        resetConfirmation()
        Task {
            await store.submit(
                "proposal.approve",
                payload: [
                    "proposalId": proposal.id,
                    "liveConfirmation": confirmation.jsonObject
                ],
                operationID: approveOperationID(proposal)
            )
        }
    }

    private func approveOperationID(_ proposal: PendingProposal) -> String {
        "proposal.approve:\(proposal.id)"
    }

    private func rejectOperationID(_ proposal: PendingProposal) -> String {
        "proposal.reject:\(proposal.id)"
    }

    private func retryOperationID(_ proposal: PendingProposal) -> String {
        "proposal.retry_red_team:\(proposal.id)"
    }

    private func expectedConfirmation(for proposal: PendingProposal) -> String {
        liveApprovalConfirmationText(forSymbol: proposal.proposal.symbol)
    }

    private func confirmationMatches(_ proposal: PendingProposal) -> Bool {
        confirmationText.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == expectedConfirmation(for: proposal)
    }

    private func resetConfirmation() {
        confirmingProposal = nil
        confirmationText = ""
    }
}

/// Triage buckets for the pending queue.  Every row here is status "proposed" server-side
/// (listPendingProposals returns only that status), so the buckets split on the decision
/// receipts the card decodes: holds that need an owner call, Red Team rejections, and the
/// rest.  Buckets may overlap — a held Red rejection appears under both.
enum ProposalTriageFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case needsReview = "Needs Review"
    case redRejected = "Red Rejected"
    case ready = "Ready"

    var id: String { rawValue }
}

enum ProposalSortOrder: String, CaseIterable, Identifiable {
    case newest = "Newest"
    case oldest = "Oldest"
    case confidence = "Confidence"

    var id: String { rawValue }
}

func matchesProposalFilter(_ proposal: PendingProposal, filter: ProposalTriageFilter) -> Bool {
    let needsReview = (proposal.proposal.holdReason?.isEmpty == false)
        || !(proposal.proposal.humanReviewReasons ?? []).isEmpty
    let redRejected = proposal.proposal.redTeamVerdict?.rejected == true
        || proposal.proposal.redTeamVerdict?.verdict == "reject"
    switch filter {
    case .all: return true
    case .needsReview: return needsReview
    case .redRejected: return redRejected
    case .ready: return !needsReview && !redRejected
    }
}

/// Deterministic ordering: unreadable dates and missing scores sort last, ties break on id
/// so the queue never shuffles between renders.
func sortedProposals(_ proposals: [PendingProposal], by order: ProposalSortOrder) -> [PendingProposal] {
    // Parse every createdAt ONCE: the comparator used to re-parse ISO dates on each comparison,
    // allocating formatters inside ProposalISODate.parse for an O(n log n) re-parse cost.
    // uniquingKeysWith: duplicate ids must degrade to first-wins, never trap the queue render.
    let parsed = Dictionary(proposals.map { ($0.id, ProposalISODate.parse($0.createdAt)) }, uniquingKeysWith: { first, _ in first })
    return proposals.sorted { a, b in
        switch order {
        case .newest, .oldest:
            let da = parsed[a.id] ?? nil
            let db = parsed[b.id] ?? nil
            if let da, let db, da != db {
                return order == .newest ? da > db : da < db
            }
            if (da == nil) != (db == nil) { return da != nil }
            return a.id < b.id
        case .confidence:
            let ca = a.proposal.confidenceScore
            let cb = b.proposal.confidenceScore
            if let ca, let cb, ca != cb { return ca > cb }
            if (ca == nil) != (cb == nil) { return ca != nil }
            return a.id < b.id
        }
    }
}

/// One compact control row above the queue: filter chips (Activity's Alerts Center idiom)
/// plus a sort menu.  Choices persist via the parent's @AppStorage.
private struct ProposalTriageBar: View {
    @Binding var filter: ProposalTriageFilter
    @Binding var sort: ProposalSortOrder

    var body: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ProposalTriageFilter.allCases) { option in
                        Button {
                            filter = option
                        } label: {
                            Text(option.rawValue)
                                .font(.appCaption.weight(filter == option ? .bold : .semibold))
                                .padding(.horizontal, 12)
                                .frame(minHeight: 44)
                                .background(
                                    filter == option ? AppPalette.accent.opacity(0.14) : Color.clear,
                                    in: Capsule()
                                )
                                .foregroundStyle(filter == option ? AppPalette.accent : .secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(filter == option ? .isSelected : [])
                    }
                }
            }
            Menu {
                ForEach(ProposalSortOrder.allCases) { option in
                    Button {
                        sort = option
                    } label: {
                        Label(option.rawValue, systemImage: sort == option ? "checkmark" : "circle")
                    }
                }
            } label: {
                Label("Sort", systemImage: "arrow.up.arrow.down")
                    .font(.appCaption.weight(.semibold))
            }
            .accessibilityLabel("Sort Proposals")
        }
    }
}

private struct ProposalQueueSummary: View {
    let snapshot: MobileSnapshot

    var body: some View {
        AppCard {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .fill(AppPalette.accent.opacity(0.12))
                    Image(systemName: "checklist")
                        .foregroundStyle(AppPalette.accent)
                }
                .frame(width: 46, height: 46)

                VStack(alignment: .leading, spacing: 3) {
                    Text("\(snapshot.pendingProposals.count) Proposals for Review")
                        .font(.appHeadline)
                    Text(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority))
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct ProposalCard: View {
    let proposal: PendingProposal
    let positions: [Position]
    let proposalExpiryMinutes: Int?
    let feedback: ProposalActionFeedback?
    let approveBusy: Bool
    let rejectBusy: Bool
    let retryBusy: Bool
    let approveDisabled: Bool
    let rejectDisabled: Bool
    let retryDisabled: Bool
    let requiresTypedConfirmation: Bool
    let openingInExitOnly: Bool
    let approve: () -> Void
    let reject: () -> Void
    let retryRedTeam: () -> Void
    @Binding var presentedSymbol: PresentedSymbol?

    private var sideColor: Color {
        switch proposal.proposal.side.lowercased() {
        case "buy", "cover": return AppPalette.positive
        default: return AppPalette.negative
        }
    }

    private var actionInFlight: Bool {
        feedback?.isInFlight == true
    }

    private var actionSettled: Bool {
        feedback?.isSettledSuccess == true
    }

    var body: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 10) {
                    SymbolTapButton(
                        symbol: proposal.proposal.symbol.uppercased(),
                        logoSize: 32,
                        font: .title2.weight(.bold)
                    ) {
                        presentedSymbol = PresentedSymbol(symbol: proposal.proposal.symbol)
                    }
                    StatusPill(proposal.proposal.side.uppercased(), color: sideColor)
                    Spacer()
                    Text(AppFormat.money(proposal.estimatedNotional))
                        .font(.appHeadline)
                }

                HStack(spacing: 8) {
                    if proposal.executionMode == "broker/paper" {
                        StatusPill(
                            executionModeLabel,
                            color: AppPalette.accent.opacity(0.75),
                            systemImage: executionModeSystemImage
                        )
                    }
                    if let holdLabel = ProposalSafetyMath.holdReasonLabel(proposal.proposal.holdReason) {
                        StatusPill(holdLabel, color: AppPalette.warning, systemImage: "exclamationmark.circle")
                    }
                    if let confidence = proposal.proposal.confidenceScore {
                        StatusPill("\(Int(confidence.rounded()))% confidence", color: AppPalette.accent)
                    }
                    if let performance = proposal.performanceSinceProposalPct {
                        StatusPill(
                            AppFormat.percent(performance, signed: true),
                            color: performance >= 0 ? AppPalette.positive : AppPalette.negative
                        )
                    }
                }

                VStack(alignment: .leading, spacing: 7) {
                    DetailLine(label: "Order", value: orderDescription)
                    DetailLine(label: "Proposed", value: priceReview.proposedValue ?? "—")
                    DetailLine(label: "Now", value: priceReview.nowValue)
                    DetailLine(label: "Target", value: priceReview.targetValue)
                    if let delay = priceReview.delayValue {
                        DetailLine(label: "Delay", value: delay)
                    }
                    if priceReview.showsDelayedFallback {
                        StatusPill(
                            priceReview.delayedFallbackStamp,
                            color: AppPalette.warning,
                            systemImage: "clock.badge.exclamationmark"
                        )
                        Text(priceReview.delayedFallbackNote)
                            .font(.appCaption)
                            .foregroundStyle(AppPalette.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let stop = priceReview.stop, stop > 0 {
                        DetailLine(label: "Stop", value: AppFormat.money(stop))
                    }
                    if let note = noStopNote {
                        Label(note, systemImage: "exclamationmark.shield.fill")
                            .font(.appCaption)
                            .foregroundStyle(AppPalette.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ProposalRiskRewardLadder(review: priceReview)
                    if let value = exitPnlValue {
                        DetailLine(label: "Est. P/L if filled", value: value)
                    }
                    if let thesis = proposal.proposal.tradeThesisTag, !thesis.isEmpty {
                        DetailLine(label: "Thesis", value: thesis)
                    }
                    if let regime = proposal.proposal.entryMarketRegime, !regime.isEmpty {
                        DetailLine(label: "Regime", value: regime)
                    }
                    if let model = proposal.proposal.proposedByModel, !model.isEmpty {
                        DetailLine(label: "Proposed by", value: model)
                    }
                    DetailLine(label: "Created", value: AppFormat.dateTime(proposal.createdAt))
                    if let revalidated = proposal.lastRevalidatedAt {
                        DetailLine(label: "Checked", value: AppFormat.dateTime(revalidated))
                    }
                }

                if openingInExitOnly {
                    Text(DeskCopy.exitOnlyOwnerApproveNote)
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let rationale = proposal.proposal.greenTeamRationale ?? proposal.proposal.rationale,
                   !rationale.isEmpty {
                    Text(rationale)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let note = priceReview.missingTargetNote {
                    Label(note, systemImage: "target")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let note = proposal.revalidationNote, !note.isEmpty {
                    Label(note, systemImage: "arrow.triangle.2.circlepath")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }

                if let reasons = proposal.proposal.humanReviewReasons, !reasons.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Why your approval is required", systemImage: "exclamationmark.circle")
                            .font(.appCaption.weight(.semibold))
                            .foregroundStyle(AppPalette.warning)
                        ForEach(reasons.indices, id: \.self) { index in
                            let reason = reasons[index]
                            VStack(alignment: .leading, spacing: 2) {
                                if let title = reason.title, !title.isEmpty {
                                    Text(title)
                                        .font(.appCaption.weight(.semibold))
                                }
                                if let summary = reason.summary, !summary.isEmpty {
                                    Text(summary)
                                        .font(.appCaption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppPalette.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if let note = proposal.decision?.washSale?.note, !note.isEmpty {
                    Label(note, systemImage: "exclamationmark.triangle")
                        .font(.appCaption.weight(.semibold))
                        .foregroundStyle(AppPalette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let verdict = proposal.proposal.redTeamVerdict {
                    RedTeamReview(
                        verdict: verdict,
                        retryBusy: retryBusy,
                        retryDisabled: retryDisabled || actionInFlight,
                        retry: retryRedTeam
                    )
                }

                if let adjustments = proposal.proposal.dataAdjustments, !adjustments.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Data Adjustments")
                            .font(.appCaption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        ForEach(adjustments.indices, id: \.self) { index in
                            Text(adjustments[index])
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Divider()

                if let expiry = ProposalSafetyMath.expiryNote(
                    createdAt: proposal.createdAt,
                    expiryMinutes: proposalExpiryMinutes,
                    now: Date()
                ) {
                    Label(expiry, systemImage: "hourglass")
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                }

                if requiresTypedConfirmation {
                    Label(DeskCopy.proposalTypedConfirmHint, systemImage: "keyboard.badge.ellipsis")
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                }

                if let feedback {
                    ProposalActionFeedbackBanner(feedback: feedback)
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        rejectButton
                        approveButton
                    }
                    VStack(spacing: 10) {
                        rejectButton
                        approveButton
                    }
                }
            }
        }
    }

    private var executionModeLabel: String {
        proposal.executionMode == "broker/paper" ? DeskCopy.paperAccountWord : ""
    }

    private var executionModeSystemImage: String {
        "doc.text"
    }

    private var priceReview: ProposalPriceReview {
        ProposalPriceReview.from(proposal)
    }

    /// stopPlan "none" is a genuine no-stop choice and is never silent (web parity:
    /// approval-card.tsx "the LLM chose to carry NO stop-loss on this position").
    private var noStopNote: String? {
        guard proposal.proposal.stopPlan?.style?.lowercased() == "none" else { return nil }
        if let rationale = proposal.proposal.stopPlan?.rationale?
            .trimmingCharacters(in: .whitespacesAndNewlines), !rationale.isEmpty {
            return "No stop-loss on this position — the model chose to carry none (\"\(rationale)\")."
        }
        return "No stop-loss on this position — the model chose to carry none."
    }

    private var exitPnl: ExitPnlEstimate? {
        ProposalSafetyMath.exitEstimatedPnl(
            proposal: proposal.proposal,
            currentPrice: proposal.proposalCurrentPrice,
            positions: positions
        )
    }

    private var exitPnlValue: String? {
        guard let estimate = exitPnl else { return nil }
        let sign = estimate.pnl > 0 ? "+" : ""
        return "\(sign)\(AppFormat.money(estimate.pnl)) (\(AppFormat.percent(estimate.pnlPct, signed: true)))"
    }

    private var orderDescription: String {
        var pieces = [proposal.proposal.type.capitalized]
        if let quantity = proposal.proposal.quantity {
            pieces.append("\(AppFormat.number(quantity)) shares")
        }
        if let limitPrice = proposal.proposal.limitPrice {
            pieces.append("limit \(AppFormat.money(limitPrice))")
        }
        if let stopPrice = proposal.proposal.stopPrice {
            pieces.append("stop \(AppFormat.money(stopPrice))")
        }
        return pieces.joined(separator: " · ")
    }

    private var rejectTitle: String {
        if feedback?.action == .reject, actionInFlight {
            return "Rejecting…"
        }
        return "Reject"
    }

    private var approveTitle: String {
        if feedback?.action == .approve, actionInFlight {
            return "Approving…"
        }
        return requiresTypedConfirmation ? "Review & Approve" : "Approve"
    }

    private var rejectButton: some View {
        CommandButton(
            rejectTitle,
            systemImage: "xmark",
            isBusy: rejectBusy || (feedback?.action == .reject && actionInFlight),
            isDisabled: rejectDisabled || actionInFlight || actionSettled,
            role: .destructive,
            action: reject
        )
    }

    private var approveButton: some View {
        CommandButton(
            approveTitle,
            systemImage: "checkmark",
            isBusy: approveBusy || (feedback?.action == .approve && actionInFlight),
            isDisabled: approveDisabled || actionInFlight || actionSettled,
            prominent: true,
            action: approve
        )
    }
}

/// On-card strip for approve/reject lifecycle (sending → queued/running → success/fail).
private struct ProposalActionFeedbackBanner: View {
    let feedback: ProposalActionFeedback

    var body: some View {
        Label {
            Text(message)
                .font(.appCaption.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            if showsSpinner {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Image(systemName: systemImage)
            }
        }
        .foregroundStyle(color)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var showsSpinner: Bool {
        switch feedback {
        case .sending, .pending: return true
        case .failed, .retryable, .succeeded, .placementSettled: return false
        }
    }

    private var message: String {
        switch feedback {
        case .sending(let action):
            return action == .approve ? "Sending approve…" : "Sending reject…"
        case .pending(let action, let status):
            if action == .approve {
                return status == "running"
                    ? "Approve is working at the broker…"
                    : "Approve queued…"
            }
            let verb = action == .reject ? "Reject" : "Retry"
            return "\(verb) \(status)…"
        case .failed(_, let message):
            return message
        case .retryable(_, let message):
            return message
        case .succeeded(let action):
            return action == .approve ? "Approved — waiting for desk refresh." : "Rejected — waiting for desk refresh."
        case .placementSettled(let action, let status, let reasons):
            guard action == .approve else {
                return "Rejected — waiting for desk refresh."
            }
            return AppFormat.placementApproveMessage(status: status, reasons: reasons)
        }
    }

    private var systemImage: String {
        switch feedback {
        case .sending, .pending: return "arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.triangle.fill"
        case .retryable: return "arrow.clockwise"
        case .succeeded: return "checkmark.circle.fill"
        case .placementSettled(let action, let status, _):
            guard action == .approve else { return "checkmark.circle.fill" }
            return AppFormat.placementApproveSystemImage(status: status)
        }
    }

    private var color: Color {
        switch feedback {
        case .sending, .pending: return AppPalette.accent
        case .failed: return AppPalette.negative
        case .retryable: return AppPalette.warning
        case .succeeded: return AppPalette.positive
        case .placementSettled(let action, let status, _):
            guard action == .approve else { return AppPalette.positive }
            return AppFormat.placementApproveColor(status: status)
        }
    }
}

private struct RedTeamReview: View {
    let verdict: RedTeamVerdict
    let retryBusy: Bool
    let retryDisabled: Bool
    let retry: () -> Void

    private var canRetry: Bool {
        !verdict.available && verdict.failureKind != "not_configured"
    }

    private var title: String {
        guard verdict.available else {
            // Console parity: "Red Team failed (provider error)" — the failure kind is
            // decision-critical when no verdict exists (src/lib/red-team-routing.ts wording).
            if let failureKind = verdict.failureKind, !failureKind.isEmpty {
                return "Red Team failed (\(AppFormat.redTeamFailureKindLabel(failureKind)))"
            }
            return "Adversarial review unavailable"
        }
        switch verdict.verdict {
        case "approve-at-half": return "Red Team: approved at half size"
        case "reject": return "Red Team: rejected"
        default: return verdict.rejected ? "Red Team: rejected" : "Red Team: approved"
        }
    }

    private var color: Color {
        if !verdict.available { return AppPalette.warning }
        return verdict.rejected ? AppPalette.negative : AppPalette.positive
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: verdict.available ? "shield.checkered" : "exclamationmark.shield.fill")
                .font(.appSubheadline.weight(.semibold))
                .foregroundStyle(color)
            Text(verdict.reason)
                .font(.appCaption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let model = verdict.model, !model.isEmpty {
                Text("Reviewed by \(model)")
                    .font(.appCaption2)
                    .foregroundStyle(.secondary)
            }
            if verdict.humanOverrideApplied == true {
                StatusPill("Human override applied", color: AppPalette.warning, systemImage: "person.badge.shield.checkmark")
            }
            if canRetry {
                Button(retryBusy ? "Retrying Red Team…" : "Retry Red Team") {
                    retry()
                }
                .buttonStyle(.bordered)
                .disabled(retryDisabled || retryBusy)
            }
        }
        .padding(12)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct DetailLine: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.appCaption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .frame(minWidth: 58, alignment: .leading)
            Text(value)
                .font(.appSubheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}
