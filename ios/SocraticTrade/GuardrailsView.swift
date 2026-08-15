import SwiftUI

/// Full policy surface: read the current rulebook, then tighten only.
struct GuardrailsView: View {
    @EnvironmentObject private var store: MobileStore

    @State private var fullPolicy: FullPolicy?
    @State private var loadError: String?

    var body: some View {
        SnapshotScaffold { snapshot in
            authorityCard(snapshot)
            snapshotPolicyCard(snapshot)
            universeCard(snapshot)
            if let fullPolicy {
                extraPolicyCard(fullPolicy)
                taxCard(fullPolicy.taxSettings)
            }
            if let error = loadError {
                InlineErrorBanner(
                    message: error,
                    retry: { Task { await loadFullPolicy() } },
                    dismiss: { loadError = nil }
                )
            }
            tightenCard
        }
        .navigationTitle("Guardrails")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadFullPolicy() }
    }

    @ViewBuilder
    private func authorityCard(_ snapshot: MobileSnapshot) -> some View {
        let runState = deriveRunStateWord(snapshot: snapshot)
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Authority vs Run State")
                HStack(spacing: 8) {
                    StatusPill(
                        AppFormat.strategyAuthorityLabel(snapshot.policy.strategyAuthority),
                        color: AppPalette.accent,
                        systemImage: "person.badge.shield.checkmark"
                    )
                    StatusPill(
                        runState.rawValue,
                        color: runState.pillColor,
                        systemImage: runState.pillSystemImage
                    )
                }
                Text(DeskCopy.authorityVersusRunState(
                    authority: snapshot.policy.strategyAuthority,
                    runState: runState
                ))
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func snapshotPolicyCard(_ snapshot: MobileSnapshot) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Current Policy", subtitle: "values from the latest snapshot")
                policyRow("Horizon", AppFormat.policyHorizonValue(snapshot.policy.holdingHorizon))
                policyRow("Cadence", AppFormat.cadenceMinutesValue(snapshot.policy.runCadenceMinutes))
                policyRow("Extended Hours", DeskCopy.yesNo(snapshot.policy.runDuringExtendedHours))
                policyRow("Max Order", AppFormat.money(snapshot.policy.maxOrderNotional))
                policyRow("Max Order % NAV", DeskCopy.percentPoints(snapshot.policy.maxOrderPctOfNav))
                policyRow("Daily Cap", AppFormat.money(snapshot.policy.maxDailyNotional))
                policyRow("Daily Cap % NAV", DeskCopy.percentPoints(snapshot.policy.maxDailyPctOfNav))
                policyRow("Daily Orders", snapshot.policy.maxDailyOrders.map(String.init) ?? "—")
                policyRow("Typed Confirm", DeskCopy.yesNo(snapshot.policy.requireTypedConfirmation))
            }
        }
    }

    private func universeCard(_ snapshot: MobileSnapshot) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Universe")
                policyRow("Indices", DeskCopy.joinedList(snapshot.policy.includedIndices))
                policyRow("Extra Symbols", DeskCopy.joinedList(snapshot.policy.additionalSymbols))
                policyRow("Blocklist", DeskCopy.joinedList(snapshot.policy.blocklist))
                Text("Universe edits stay on the web Strategy page.  The phone can tighten risk, not widen the book.")
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func extraPolicyCard(_ policy: FullPolicy) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Full Rulebook", subtitle: "additional fields from /api/policy")
                policyRow("Green Team", policy.llmModel?.lowercased() ?? "—")
                policyRow("Red Team", policy.redTeamLlmModel?.lowercased() ?? "—")
                policyRow("Stop Loss", DeskCopy.percentPoints(policy.stopLossPct))
                policyRow("Trailing Stop", DeskCopy.percentPoints(policy.trailingStopPct))
                policyRow("Short Stop", DeskCopy.percentPoints(policy.shortStopLossPct))
                policyRow("Sell to Fund", (policy.sellToFundBuy ?? "off").replacingOccurrences(of: "_", with: " ").lowercased())
                policyRow("Override Mode", (policy.socraticOverrideMode ?? "off").lowercased())
            }
        }
    }

    @ViewBuilder
    private func taxCard(_ tax: PolicyTaxSettings?) -> some View {
        if let tax {
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeading("Tax Settings", subtitle: "estimates only — not tax advice")
                    policyRow("Account Type", AppFormat.accountTypeWord(tax.taxationType ?? ""))
                    policyRow("Wash-Sale Guard", DeskCopy.yesNo(tax.washSaleGuard))
                    policyRow("Wash-Sale Handling", (tax.washSaleHandling ?? "—").replacingOccurrences(of: "_", with: " ").lowercased())
                    policyRow("Short-Term Rate", DeskCopy.percentPoints(tax.shortTermRatePct))
                    policyRow("Long-Term Rate", DeskCopy.percentPoints(tax.longTermRatePct))
                }
            }
        }
    }

    private var tightenCard: some View {
        AppCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeading(
                    "Tighten Guardrails",
                    subtitle: "phone-safe reductions only"
                )
                GuardrailTighteningControls()
                Text("Returning to Autopilot or raising a cap is done in the web console.")
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func policyRow(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer(minLength: 12)
            Text(value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .font(.appSubheadline)
    }

    private func loadFullPolicy() async {
        do {
            fullPolicy = try await store.fetchFullPolicy()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// Card-friendly tightening controls (the Form `GuardrailTighteningSection` stays in Settings).
private struct GuardrailTighteningControls: View {
    @EnvironmentObject private var store: MobileStore

    private var policy: PolicySummary? { store.snapshot?.policy }

    var body: some View {
        if store.serverAdvertises(PolicyTightening.commandType) {
            VStack(alignment: .leading, spacing: 10) {
                authorityRow
                ForEach(PolicyTightening.Cap.allCases) { cap in
                    capRow(cap)
                }
            }
        } else {
            Text("This deployment does not advertise policy.patch.")
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var authorityRow: some View {
        let operationID = PolicyTightening.operationID("strategyAuthority")
        if PolicyTightening.tightenedAuthority(current: policy?.strategyAuthority) != nil {
            CommandButton(
                "Require Approval First",
                systemImage: "person.badge.shield.checkmark",
                isBusy: store.isBusy(operationID),
                isDisabled: store.isBusy(operationID) || !store.canSubmit(PolicyTightening.commandType)
            ) {
                Task {
                    await store.submit(
                        PolicyTightening.commandType,
                        payload: PolicyTightening.authorityPayload(),
                        operationID: operationID
                    )
                }
            }
        } else {
            policyLabeled("Authority", AppFormat.strategyAuthorityValue(policy?.strategyAuthority))
        }
    }

    @ViewBuilder
    private func capRow(_ cap: PolicyTightening.Cap) -> some View {
        let current = cap.currentValue(in: policy)
        let competing = cap.competingPercentCap(in: policy)
        let options = PolicyTightening.tightenedCapOptions(current: current, competingPercentCap: competing)
        let operationID = PolicyTightening.operationID(cap.rawValue)

        if store.isBusy(operationID) {
            HStack {
                Text(cap.menuTitle)
                Spacer()
                ProgressView()
            }
            .font(.appSubheadline)
        } else if options.isEmpty {
            policyLabeled(cap.title, unavailableValue(current: current, competingPercentCap: competing))
        } else {
            Menu {
                ForEach(options, id: \.self) { value in
                    Button(AppFormat.money(value)) {
                        submit(cap, value: value, operationID: operationID)
                    }
                }
            } label: {
                HStack {
                    Text(cap.menuTitle)
                        .foregroundStyle(.primary)
                    Spacer()
                    Text(AppFormat.money(current))
                        .foregroundStyle(.secondary)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.appCaption2)
                        .foregroundStyle(.tertiary)
                }
                .frame(minHeight: 44)
            }
            .disabled(!store.canSubmit(PolicyTightening.commandType))
        }
    }

    private func submit(_ cap: PolicyTightening.Cap, value: Double, operationID: String) {
        let policy = store.snapshot?.policy
        guard PolicyTightening.isStillATightening(cap, value: value, in: policy) else {
            store.error = "\(cap.title) changed while that menu was open.  Nothing was sent — reopen it to see the current limit."
            return
        }
        let payload = PolicyTightening.capPayload(cap, value: value, current: cap.currentValue(in: policy))
        Task {
            await store.submit(
                PolicyTightening.commandType,
                payload: payload,
                operationID: operationID
            )
        }
    }

    private func unavailableValue(current: Double?, competingPercentCap: Double?) -> String {
        if competingPercentCap != nil { return "set as % of NAV — console only" }
        if current == nil { return "not set — console only" }
        return "already at the floor"
    }

    private func policyLabeled(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .foregroundStyle(.secondary)
        }
        .font(.appSubheadline)
    }
}
