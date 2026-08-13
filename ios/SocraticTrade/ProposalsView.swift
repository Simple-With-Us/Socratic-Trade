import SwiftUI

struct ProposalsView: View {
    @EnvironmentObject private var store: MobileStore

    @State private var confirmingProposal: PendingProposal?
    @State private var confirmationText = ""
    @State private var presentedSymbol: PresentedSymbol?

    var body: some View {
        SnapshotScaffold { snapshot in
            ProposalQueueSummary(snapshot: snapshot)
            if snapshot.pendingProposals.isEmpty {
                EmptyStateCard(
                    title: "No proposals waiting",
                    message: "New owner decisions will appear here after a strategy run.",
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
                        approveDisabled: !store.canSubmit("proposal.approve"),
                        rejectDisabled: !store.canSubmit("proposal.reject"),
                        requiresTypedConfirmation: requiresLiveConfirmation(proposal, snapshot: snapshot),
                        approve: { approve(proposal, snapshot: snapshot) },
                        reject: { reject(proposal) },
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
                }
            }
        }
        .navigationTitle("Proposals")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $presentedSymbol) { presented in
            SymbolInfoSheet(symbol: presented.symbol)
        }
        .alert(
            "Confirm Live Order",
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
            Button("Approve Live Order", role: .destructive) {
                approveConfirmedLiveProposal(proposal)
            }
            .disabled(!confirmationMatches(proposal))
            Button("Cancel", role: .cancel) {
                resetConfirmation()
            }
        } message: { proposal in
            Text("Type exactly “\(expectedConfirmation(for: proposal))”.  The backend revalidates the proposal and confirmation before placing anything.")
        }
    }

    private func requiresLiveConfirmation(_ proposal: PendingProposal, snapshot: MobileSnapshot) -> Bool {
        proposal.executionMode == "broker/live" && (snapshot.policy.requireTypedConfirmation ?? true)
    }

    private func approve(_ proposal: PendingProposal, snapshot: MobileSnapshot) {
        if requiresLiveConfirmation(proposal, snapshot: snapshot) {
            confirmationText = ""
            confirmingProposal = proposal
        } else {
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
        Task {
            await store.submit(
                "proposal.reject",
                payload: ["proposalId": proposal.id],
                operationID: rejectOperationID(proposal)
            )
        }
    }

    private func approveConfirmedLiveProposal(_ proposal: PendingProposal) {
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
                    Text("\(snapshot.pendingProposals.count) awaiting review")
                        .font(.appHeadline)
                    Text("\(AppFormat.strategyAuthorityLabel(snapshot.readiness.strategyAuthority)) · backend validation remains final")
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
    let approveDisabled: Bool
    let rejectDisabled: Bool
    let requiresTypedConfirmation: Bool
    let approve: () -> Void
    let reject: () -> Void
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
                    StatusPill(
                        executionModeLabel,
                        color: executionModeColor,
                        systemImage: executionModeSystemImage
                    )
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
                    if let priceDrift = priceDriftDescription {
                        DetailLine(label: "Price", value: priceDrift)
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

                if let rationale = proposal.proposal.greenTeamRationale ?? proposal.proposal.rationale,
                   !rationale.isEmpty {
                    Text(rationale)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let note = proposal.revalidationNote, !note.isEmpty {
                    Label(note, systemImage: "arrow.triangle.2.circlepath")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                }

                if let verdict = proposal.proposal.redTeamVerdict {
                    RedTeamReview(verdict: verdict)
                }

                Divider()

                if requiresTypedConfirmation {
                    Label("Typed confirmation required for this live order", systemImage: "keyboard.badge.ellipsis")
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
        switch proposal.executionMode {
        case "broker/live": return "Live"
        case "broker/paper": return "Paper"
        default: return "Unknown"
        }
    }

    private var executionModeColor: Color {
        proposal.executionMode == "broker/live" ? AppPalette.negative : AppPalette.accent
    }

    private var executionModeSystemImage: String {
        proposal.executionMode == "broker/live" ? "dollarsign.circle.fill" : "questionmark.circle"
    }

    /// Decision-critical drift: reference price at proposal time vs the latest revalidated
    /// price, e.g. "$200.00 → $202.20 (+1.1%)".  Rendered only when both prices decoded.
    private var priceDriftDescription: String? {
        guard
            let reference = proposal.proposalReferencePrice,
            let current = proposal.proposalCurrentPrice,
            reference > 0
        else { return nil }
        let driftPct = (current - reference) / reference * 100
        return "\(AppFormat.money(reference)) → \(AppFormat.money(current)) (\(AppFormat.percent(driftPct, signed: true)))"
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
        case .failed, .succeeded: return false
        }
    }

    private var message: String {
        switch feedback {
        case .sending(let action):
            return action == .approve ? "Sending approve…" : "Sending reject…"
        case .pending(let action, let status):
            let verb = action == .approve ? "Approve" : "Reject"
            return "\(verb) \(status)…"
        case .failed(_, let message):
            return message
        case .succeeded(let action):
            return action == .approve ? "Approved — waiting for desk refresh." : "Rejected — waiting for desk refresh."
        }
    }

    private var systemImage: String {
        switch feedback {
        case .sending, .pending: return "arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.triangle.fill"
        case .succeeded: return "checkmark.circle.fill"
        }
    }

    private var color: Color {
        switch feedback {
        case .sending, .pending: return AppPalette.accent
        case .failed: return AppPalette.negative
        case .succeeded: return AppPalette.positive
        }
    }
}

private struct RedTeamReview: View {
    let verdict: RedTeamVerdict

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
