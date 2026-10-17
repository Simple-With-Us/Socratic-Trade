import SwiftUI

struct ProposalsView: View {
    @EnvironmentObject private var store: MobileStore

    @State private var confirmingProposal: PendingProposal?
    @State private var confirmationText = ""
    @State private var presentedSymbol: PresentedSymbol?
    /// Set when a deep link named one proposal: that card is scrolled to and ringed.
    @Binding private var focusedProposalId: String?

    init(focusedProposalId: Binding<String?> = .constant(nil)) {
        self._focusedProposalId = focusedProposalId
    }

    var body: some View {
        SnapshotScaffold(scrollTarget: focusedProposalId) { snapshot in
            ProposalQueueSummary(snapshot: snapshot)
                .cardSpansAllColumns()
            if snapshot.pendingProposals.isEmpty {
                EmptyStateCard(
                    title: "No proposals waiting",
                    message: "New decisions will appear here after a strategy run.",
                    systemImage: "checkmark.seal"
                )
            } else {
                ForEach(snapshot.pendingProposals) { proposal in
                    let feedback = store.proposalActionFeedback(proposalId: proposal.id)
                    ProposalCard(
                        proposal: proposal,
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

                if let verdict = proposal.proposal.redTeamVerdict {
                    RedTeamReview(
                        verdict: verdict,
                        retryBusy: retryBusy,
                        retryDisabled: retryDisabled || actionInFlight,
                        retry: retryRedTeam
                    )
                }

                Divider()

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
                .frame(width: 58, alignment: .leading)
            Text(value)
                .font(.appSubheadline)
            Spacer(minLength: 0)
        }
    }
}
