import SwiftUI

/// Full policy surface: read the current rulebook, then edit authority and caps.
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
                taxCard(fullPolicy.taxSettings, snapshot: snapshot)
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
        let runState = store.deriveRunState(for: snapshot)
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
                SectionHeading("Current Policy", subtitle: "this account's current rules")
                policyRow("Horizon", AppFormat.policyHorizonValue(snapshot.policy.holdingHorizon))
                policyRow("Cadence", AppFormat.cadenceMinutesValue(snapshot.policy.runCadenceMinutes))
                policyRow("Extended Hours", DeskCopy.yesNo(snapshot.policy.runDuringExtendedHours))
                // "Max Order" read as an order COUNT next to "Daily Orders"; "Daily Cap"
                // collided with the daily order cap, the daily loss stop, and the daily
                // drawdown stop.  Web's longer labels say which cap this is.
                policyRow("Max Per Order", AppFormat.money(snapshot.policy.maxOrderNotional))
                policyRow("Max Order % NAV", DeskCopy.percentPoints(snapshot.policy.maxOrderPctOfNav))
                policyRow("Max Spend Per Day", AppFormat.money(snapshot.policy.maxDailyNotional))
                policyRow("Daily Cap % NAV", DeskCopy.percentPoints(snapshot.policy.maxDailyPctOfNav))
                // "Opening" is load-bearing: protective exits never count against this cap.
                policyRow("Max Opening Orders Per Day", snapshot.policy.maxDailyOrders.map(String.init) ?? "—")
                policyRow("Typed Confirm", DeskCopy.yesNo(snapshot.policy.requireTypedConfirmation))
            }
        }
    }

    private func universeCard(_ snapshot: MobileSnapshot) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Universe")
                policyRow("Indices", DeskCopy.joinedIndexList(snapshot.policy.includedIndices))
                // These names are EXEMPT from the universe floor, not merely appended —
                // "Extra Symbols" undersold that.  Web: "Always include (symbols)".
                policyRow("Always Include (Symbols)", DeskCopy.joinedList(snapshot.policy.additionalSymbols))
                policyRow("Blocklist", DeskCopy.joinedList(snapshot.policy.blocklist))
            }
        }
    }

    private func extraPolicyCard(_ policy: FullPolicy) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeading("Stops and Models")
                policyRow("Green Team", DeskCopy.modelSeatValue(policy.llmModel, fallbacks: policy.llmFallbackModels ?? []))
                policyRow("Red Team", DeskCopy.modelSeatValue(policy.redTeamLlmModel, fallbacks: policy.llmFallbackModels ?? []))
                // "(Base %)" because ATR stops are on by default — this is only the
                // fallback distance, and no ATR row sits next to it to say so.
                policyRow("Stop-Loss (Base %)", DeskCopy.percentPoints(policy.stopLossPct))
                policyRow("Trailing Stop", DeskCopy.percentPoints(policy.trailingStopPct))
                // "Short Stop" collided with broker-held short buy-stops, which are resting
                // ORDERS.  This row is a stop DISTANCE.
                policyRow("Short Stop-Loss", DeskCopy.percentPoints(policy.shortStopLossPct))
                policyRow("Sell to Fund Buys", DeskCopy.sellToFundValue(policy.sellToFundBuy))
                policyRow("Override Mode", DeskCopy.socraticOverrideValue(policy.socraticOverrideMode))
            }
        }
    }

    @ViewBuilder
    private func taxCard(_ tax: PolicyTaxSettings?, snapshot: MobileSnapshot) -> some View {
        if let tax {
            let accountTaxation = snapshot.readiness.activeConnectedAccount?.taxationType
            let capabilityType = snapshot.readiness.activeConnectedAccount?.capabilities?.accountType
            let taxation = DeskCopy.resolvedTaxationType(
                accountTaxation: accountTaxation,
                capabilityType: capabilityType,
                policyTaxation: tax.taxationType
            )
            let isIra = DeskCopy.isIraAccount(
                accountTaxation: accountTaxation,
                capabilityType: capabilityType,
                policyTaxation: tax.taxationType
            )
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeading("Tax Settings", subtitle: "estimates only — not tax advice")
                    policyRow("Account Type", AppFormat.accountTypeWord(taxation ?? ""))
                    if isIra {
                        let rows = DeskCopy.iraWashSaleRows(handling: tax.iraWashSaleHandling)
                        policyRow("Same-Account Wash Sale", rows.sameAccount)
                        policyRow("Cross-Account Replacement", rows.crossAccount)
                        if let floor = tax.washSaleMinLossUsd {
                            policyRow("Wash-Sale Minimum Loss", String(format: "$%.0f", floor))
                        } else {
                            policyRow("Wash-Sale Minimum Loss", "optional")
                        }
                        Text("Same-account wash sales do not apply in an IRA.  Cross-account replacement buys are ignored, Auto (weighed), or blocked.  Minimum loss is optional — blank means every loss.")
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        policyRow("Wash-Sale Guard", DeskCopy.yesNo(tax.washSaleGuard))
                        policyRow("Wash-Sale Handling", (tax.washSaleHandling ?? "—").replacingOccurrences(of: "_", with: " ").lowercased())
                    }
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
                    "Edit Guardrails",
                    subtitle: "Ask-First, Autopilot, and caps"
                )
                GuardrailTighteningControls()
                Text("Ask-First and Autopilot both live here.  Caps can go up or down, including the % of NAV cap when that is the one that binds.")
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

/// Card-friendly edit controls (the Form `GuardrailTighteningSection` stays in Settings).
private struct GuardrailTighteningControls: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        if store.serverAdvertises(PolicyTightening.commandType) {
            VStack(alignment: .leading, spacing: 10) {
                GuardrailEditRows()
            }
        } else {
            Text("Policy changes are not available on this version.")
                .font(.appSubheadline)
                .foregroundStyle(.secondary)
        }
    }
}
