import SwiftUI

/// Phone-side policy edits through the existing `policy.patch` mobile command
/// (`normalizePolicyPatch` → `applyPolicyPatch`).  Ask-First ↔ Autopilot and
/// raise / lower / switch-mode cap edits all live here — none of those are
/// website-only.  Tightening is one tap.  Loosening on a live account uses the
/// same typed-confirm ritual as the rest of the money-adjacent controls
/// (`AUTOPILOT` to return to Autopilot; `CONFIRM` to raise a cap or switch
/// which cap binds).  `expectedCurrent` still guards the queued write.
enum PolicyTightening {
    static let commandType = "policy.patch"

    /// `StrategyAuthority` wire values.  User-facing wording comes from
    /// `AppFormat.strategyAuthorityLabel` / `strategyAuthorityValue` (Autopilot / Ask-First).
    static let autopilot = "decide"
    static let askFirst = "propose"

    static let autopilotConfirmPhrase = "AUTOPILOT"
    static let loosenConfirmPhrase = "CONFIRM"

    /// Server floor shared by both notional caps (`min` of 1 in `numericFields`).
    static let minimumNotional: Double = 1
    /// `maxOrderNotional` server ceiling.  Daily notional has no max.
    static let maxOrderNotionalCeiling: Double = 100_000
    static let minimumPercent: Double = 0.01
    static let maximumPercent: Double = 100

    /// Offered reductions, strongest last so the menu reads from mildest to strictest.
    static let reductionFractions: [Double] = [0.75, 0.5, 0.25]
    static let raiseMultipliers: [Double] = [1.25, 1.5, 2]
    static let notionalPresets: [Double] = [500, 1_000, 2_500, 5_000, 10_000, 25_000]
    static let percentPresets: [Double] = [1, 2, 5, 10, 15, 20, 25, 50]

    static func normalizedAuthority(_ current: String?) -> String? {
        let normalized = current?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        switch normalized {
        case autopilot, askFirst: return normalized
        default: return nil
        }
    }

    /// The other authority value, or nil when the snapshot is not decide/propose.
    static func counterpartAuthority(current: String?) -> String? {
        switch normalizedAuthority(current) {
        case autopilot: return askFirst
        case askFirst: return autopilot
        default: return nil
        }
    }

    /// Ask-First → Autopilot is the loosening.  Autopilot is always the typed-phrase ritual.
    static func isLooseningAuthority(from current: String?, to next: String) -> Bool {
        normalizedAuthority(current) == askFirst && next == autopilot
    }

    static func needsAutopilotPhrase(to next: String) -> Bool {
        next == autopilot
    }

    /// Live + typed-confirm preference + a loosening.  Autopilot uses its own phrase even on paper.
    static func needsTypedConfirm(
        isLiveAccount: Bool,
        requireTypedConfirmation: Bool?,
        isLoosening: Bool
    ) -> Bool {
        guard isLoosening else { return false }
        guard isLiveAccount else { return false }
        return requireTypedConfirmation ?? true
    }

    /// The two opening caps this screen can raise, lower, or switch between dollars and % NAV.
    enum Cap: String, CaseIterable, Identifiable {
        case maxOrderNotional
        case maxDailyNotional

        var id: String { rawValue }

        /// Same words as the read-only rows in `GuardrailsView` — the edit control and the
        /// row it edits sit on ONE screen, so they cannot use different names.  "Max Order"
        /// read as an order COUNT next to "Max Opening Orders Per Day", and "Daily Cap"
        /// named none of the three daily caps (spend, order count, loss) it could mean.
        var title: String {
            switch self {
            case .maxOrderNotional: return "Max Per Order"
            case .maxDailyNotional: return "Max Spend Per Day"
            }
        }

        var menuTitle: String {
            switch self {
            case .maxOrderNotional: return "Edit Max Per Order"
            case .maxDailyNotional: return "Edit Max Spend Per Day"
            }
        }

        var percentField: String {
            switch self {
            case .maxOrderNotional: return "maxOrderPctOfNav"
            case .maxDailyNotional: return "maxDailyPctOfNav"
            }
        }

        func notionalCeiling() -> Double? {
            switch self {
            case .maxOrderNotional: return PolicyTightening.maxOrderNotionalCeiling
            case .maxDailyNotional: return nil
            }
        }

        func competingPercentCap(in policy: PolicySummary?) -> Double? {
            switch self {
            case .maxOrderNotional: return policy?.maxOrderPctOfNav
            case .maxDailyNotional: return policy?.maxDailyPctOfNav
            }
        }

        func currentValue(in policy: PolicySummary?) -> Double? {
            switch self {
            case .maxOrderNotional: return policy?.maxOrderNotional
            case .maxDailyNotional: return policy?.maxDailyNotional
            }
        }

        /// The cap that actually binds.  Percent wins when both are stored (server exclusive-caps).
        func bindingMode(in policy: PolicySummary?) -> CapMode? {
            if let percent = competingPercentCap(in: policy), percent.isFinite, percent > 0 {
                return .percentOfNav
            }
            if let notional = currentValue(in: policy), notional.isFinite, notional > 0 {
                return .notional
            }
            return nil
        }

        func bindingValue(in policy: PolicySummary?) -> Double? {
            switch bindingMode(in: policy) {
            case .percentOfNav: return competingPercentCap(in: policy)
            case .notional: return currentValue(in: policy)
            case .none: return nil
            }
        }

        func displayValue(in policy: PolicySummary?) -> String {
            switch bindingMode(in: policy) {
            case .percentOfNav:
                return "\(DeskCopy.percentPoints(competingPercentCap(in: policy))) of NAV"
            case .notional:
                return AppFormat.money(currentValue(in: policy))
            case .none:
                return "not set"
            }
        }
    }

    enum CapMode: String, Equatable {
        case notional
        case percentOfNav

        var fieldName: String {
            switch self {
            case .notional: return "notional"
            case .percentOfNav: return "percent"
            }
        }
    }

    struct CapOption: Equatable {
        let mode: CapMode
        let value: Double
        let isLoosening: Bool
        let switchesMode: Bool

        var menuLabel: String {
            switch mode {
            case .notional: return AppFormat.money(value)
            case .percentOfNav: return "\(DeskCopy.percentPoints(value)) of NAV"
            }
        }
    }

    /// A lower value for `current`, or nil when the reduction is not offerable.
    static func tightenedCap(current: Double?, competingPercentCap: Double?, fraction: Double) -> Double? {
        guard competingPercentCap == nil else { return nil }
        return scaledNotional(current: current, factor: fraction, raising: false)
    }

    static func tightenedCapOptions(current: Double?, competingPercentCap: Double?) -> [Double] {
        var seen: Set<Double> = []
        return reductionFractions.compactMap { fraction in
            guard let value = tightenedCap(
                current: current,
                competingPercentCap: competingPercentCap,
                fraction: fraction
            ) else { return nil }
            return seen.insert(value).inserted ? value : nil
        }
    }

    static func scaledNotional(current: Double?, factor: Double, raising: Bool) -> Double? {
        guard let current, current.isFinite, current >= minimumNotional else { return nil }
        guard factor > 0 else { return nil }
        if raising {
            guard factor > 1 else { return nil }
        } else {
            guard factor < 1 else { return nil }
        }
        let proposed = raising ? (current * factor).rounded(.up) : (current * factor).rounded(.down)
        guard proposed.isFinite, proposed >= minimumNotional else { return nil }
        if raising {
            return proposed > current ? proposed : nil
        }
        return proposed < current ? proposed : nil
    }

    /// Raise / lower / switch-mode options for the cap that currently binds.
    static func capOptions(for cap: Cap, in policy: PolicySummary?) -> [CapOption] {
        let mode = cap.bindingMode(in: policy)
        let current = cap.bindingValue(in: policy)
        var options: [CapOption] = []
        var seen: Set<String> = []

        func append(_ option: CapOption) {
            let key = "\(option.mode.rawValue):\(option.value)"
            guard seen.insert(key).inserted else { return }
            if option.mode == .notional, let ceiling = cap.notionalCeiling(), option.value > ceiling {
                return
            }
            if option.mode == .percentOfNav {
                guard option.value >= minimumPercent, option.value <= maximumPercent else { return }
            }
            options.append(option)
        }

        switch mode {
        case .notional:
            for fraction in reductionFractions {
                if let value = scaledNotional(current: current, factor: fraction, raising: false) {
                    append(CapOption(mode: .notional, value: value, isLoosening: false, switchesMode: false))
                }
            }
            for multiplier in raiseMultipliers {
                if var value = scaledNotional(current: current, factor: multiplier, raising: true) {
                    if let ceiling = cap.notionalCeiling() {
                        value = min(value, ceiling)
                    }
                    if let current, value > current {
                        append(CapOption(mode: .notional, value: value, isLoosening: true, switchesMode: false))
                    }
                }
            }
            for preset in percentPresets {
                append(CapOption(mode: .percentOfNav, value: preset, isLoosening: true, switchesMode: true))
            }
        case .percentOfNav:
            for preset in percentPresets {
                let loosening: Bool
                if let current {
                    if preset == current { continue }
                    loosening = preset > current
                } else {
                    loosening = false
                }
                append(CapOption(mode: .percentOfNav, value: preset, isLoosening: loosening, switchesMode: false))
            }
            for preset in notionalPresets {
                var value = preset
                if let ceiling = cap.notionalCeiling() {
                    value = min(value, ceiling)
                }
                append(CapOption(mode: .notional, value: value, isLoosening: true, switchesMode: true))
            }
        case .none:
            for preset in notionalPresets {
                append(CapOption(mode: .notional, value: preset, isLoosening: false, switchesMode: false))
            }
            for preset in percentPresets {
                append(CapOption(mode: .percentOfNav, value: preset, isLoosening: false, switchesMode: false))
            }
        }

        return options
    }

    /// Whether `value` is still a lowering of the notional cap as the policy reads right now.
    static func isStillATightening(_ cap: Cap, value: Double, in policy: PolicySummary?) -> Bool {
        guard cap.bindingMode(in: policy) == .notional else { return false }
        guard let current = cap.currentValue(in: policy), current.isFinite else { return false }
        return value.isFinite && value >= minimumNotional && value < current
    }

    /// Snapshot still matches the field this patch is based on.
    static func isStillExpected(
        _ cap: Cap,
        expectedMode: CapMode?,
        expectedValue: Double?,
        in policy: PolicySummary?
    ) -> Bool {
        let currentMode = cap.bindingMode(in: policy)
        if currentMode != expectedMode { return false }
        switch expectedMode {
        case .none:
            return currentMode == nil
        case .notional:
            guard let expectedValue, let current = cap.currentValue(in: policy) else { return false }
            return abs(current - expectedValue) < 0.000_1
        case .percentOfNav:
            guard let expectedValue, let current = cap.competingPercentCap(in: policy) else { return false }
            return abs(current - expectedValue) < 0.000_1
        }
    }

    static func parsedCustomValue(_ raw: String, mode: CapMode) -> Double? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "%", with: "")
        guard let value = Double(trimmed), value.isFinite else { return nil }
        switch mode {
        case .notional:
            let rounded = value.rounded(.down)
            return rounded >= minimumNotional ? rounded : nil
        case .percentOfNav:
            return value >= minimumPercent && value <= maximumPercent ? value : nil
        }
    }

    static func isLooseningCustom(
        _ cap: Cap,
        mode: CapMode,
        value: Double,
        in policy: PolicySummary?
    ) -> Bool {
        let currentMode = cap.bindingMode(in: policy)
        if currentMode == nil { return false }
        if currentMode != mode { return true }
        guard let current = cap.bindingValue(in: policy) else { return false }
        return value > current
    }

    static func authorityPayload(to next: String, current: String?) -> [String: Any] {
        var payload: [String: Any] = ["patch": ["strategyAuthority": next]]
        if let current = normalizedAuthority(current) {
            payload["expectedCurrent"] = ["strategyAuthority": current]
        }
        return payload
    }

    /// Legacy Ask-First payload (Autopilot → Ask-First).
    static func authorityPayload() -> [String: Any] {
        authorityPayload(to: askFirst, current: autopilot)
    }

    static func capPayload(_ cap: Cap, value: Double, current: Double?) -> [String: Any] {
        capPayload(cap, mode: .notional, value: value, expectedMode: current == nil ? nil : .notional, expectedValue: current)
    }

    static func capPayload(
        _ cap: Cap,
        mode: CapMode,
        value: Double,
        expectedMode: CapMode?,
        expectedValue: Double?
    ) -> [String: Any] {
        let field = mode == .notional ? cap.rawValue : cap.percentField
        var payload: [String: Any] = ["patch": [field: value]]
        if let expectedMode, let expectedValue, expectedValue.isFinite {
            let expectedField = expectedMode == .notional ? cap.rawValue : cap.percentField
            payload["expectedCurrent"] = [expectedField: expectedValue]
        }
        return payload
    }

    static func operationID(_ suffix: String) -> String {
        "\(commandType):\(suffix)"
    }
}

/// Settings-sheet section.  Same controls as Guardrails — both directions, both cap modes.
struct GuardrailTighteningSection: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        if store.serverAdvertises(PolicyTightening.commandType) {
            Section {
                GuardrailEditRows()
            } header: {
                Text("Edit Guardrails")
            } footer: {
                Text("Ask-First and Autopilot both live here, and caps can go up or down.  Returning to Autopilot or raising a cap on a live account asks you to type a confirmation.")
            }
        }
    }
}

/// Shared authority + cap rows for Settings and the Guardrails card.
struct GuardrailEditRows: View {
    @EnvironmentObject private var store: MobileStore

    @State private var pendingConfirm: PendingPolicyConfirm?
    @State private var typedConfirm = ""
    @State private var customCap: PendingCustomCap?
    @State private var customAmount = ""

    private var policy: PolicySummary? { store.snapshot?.policy }

    private var isLiveAccount: Bool {
        let environment = store.snapshot.flatMap { snapshot in
            snapshot.readiness.activeConnectedAccount?.environment
                ?? store.displayedActiveAccount(in: snapshot)?.environment
        }
        return AccountMetrics.usesLiveMetrics(environment: environment)
    }

    var body: some View {
        Group {
            authorityRow
            ForEach(PolicyTightening.Cap.allCases) { cap in
                capRow(cap)
            }
        }
        .alert(
            pendingConfirm?.title ?? "Confirm",
            isPresented: Binding(
                get: { pendingConfirm != nil },
                set: { if !$0 { pendingConfirm = nil; typedConfirm = "" } }
            ),
            presenting: pendingConfirm
        ) { pending in
            TextField(pending.phrase, text: $typedConfirm)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            Button("Confirm") {
                submitConfirmed(pending)
            }
            .disabled(
                typedConfirm.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() != pending.phrase
            )
            Button("Cancel", role: .cancel) {
                pendingConfirm = nil
                typedConfirm = ""
            }
        } message: { pending in
            Text("Type exactly “\(pending.phrase)”.  \(pending.message)")
        }
        .alert(
            customCap.map { "Set \($0.cap.title)" } ?? "Set Cap",
            isPresented: Binding(
                get: { customCap != nil },
                set: { if !$0 { customCap = nil; customAmount = "" } }
            )
        ) {
            TextField(customCap?.mode == .percentOfNav ? "Percent of NAV" : "Dollar amount", text: $customAmount)
                .keyboardType(.decimalPad)
            Button("Set") {
                submitCustomAmount()
            }
            Button("Cancel", role: .cancel) {
                customCap = nil
                customAmount = ""
            }
        } message: {
            Text(customCap?.mode == .percentOfNav
                 ? "Enter a percent of NAV between 0.01 and 100."
                 : "Enter a dollar amount of at least $1.")
        }
    }

    @ViewBuilder
    private var authorityRow: some View {
        let operationID = PolicyTightening.operationID("strategyAuthority")
        let current = policy?.strategyAuthority
        if let next = PolicyTightening.counterpartAuthority(current: current) {
            let title = next == PolicyTightening.askFirst ? "Switch to Ask-First" : "Turn on Autopilot"
            let systemImage = next == PolicyTightening.askFirst
                ? "person.badge.shield.checkmark"
                : "bolt.badge.automatic"
            Button {
                requestAuthority(to: next, operationID: operationID)
            } label: {
                HStack {
                    Label(title, systemImage: systemImage)
                    Spacer(minLength: 8)
                    if store.isBusy(operationID) {
                        ProgressView()
                    }
                }
            }
            .disabled(store.isBusy(operationID) || !store.canSubmit(PolicyTightening.commandType))
            .accessibilityHint(
                next == PolicyTightening.askFirst
                    ? "Switches from Autopilot to Ask-First"
                    : "Switches from Ask-First to Autopilot"
            )
        } else {
            LabeledContent(
                "Authority",
                value: AppFormat.strategyAuthorityValue(current)
            )
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func capRow(_ cap: PolicyTightening.Cap) -> some View {
        let options = PolicyTightening.capOptions(for: cap, in: policy)
        let operationID = PolicyTightening.operationID(cap.rawValue)

        if store.isBusy(operationID) {
            HStack {
                Text(cap.menuTitle)
                Spacer(minLength: 8)
                ProgressView()
            }
        } else {
            Menu {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Button(option.menuLabel) {
                        requestCap(cap, option: option, operationID: operationID)
                    }
                }
                Button("Enter Dollar Amount…") {
                    customAmount = ""
                    customCap = PendingCustomCap(cap: cap, mode: .notional)
                }
                Button("Enter Percent of NAV…") {
                    customAmount = ""
                    customCap = PendingCustomCap(cap: cap, mode: .percentOfNav)
                }
            } label: {
                HStack {
                    Text(cap.menuTitle)
                    Spacer(minLength: 8)
                    Text(cap.displayValue(in: policy))
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(!store.canSubmit(PolicyTightening.commandType))
            .accessibilityLabel("\(cap.menuTitle), currently \(cap.displayValue(in: policy))")
        }
    }

    private func requestAuthority(to next: String, operationID: String) {
        let current = policy?.strategyAuthority
        let payload = PolicyTightening.authorityPayload(to: next, current: current)
        if PolicyTightening.needsAutopilotPhrase(to: next) {
            pendingConfirm = PendingPolicyConfirm(
                title: "Turn on Autopilot",
                message: "Type \(PolicyTightening.autopilotConfirmPhrase) to let this account place orders without per-trade approval.",
                phrase: PolicyTightening.autopilotConfirmPhrase,
                payload: payload,
                operationID: operationID
            )
            typedConfirm = ""
            return
        }
        Task {
            await store.submit(PolicyTightening.commandType, payload: payload, operationID: operationID)
        }
    }

    private func requestCap(_ cap: PolicyTightening.Cap, option: PolicyTightening.CapOption, operationID: String) {
        let expectedMode = cap.bindingMode(in: policy)
        let expectedValue = cap.bindingValue(in: policy)
        guard PolicyTightening.isStillExpected(
            cap,
            expectedMode: expectedMode,
            expectedValue: expectedValue,
            in: policy
        ) else {
            store.error = "\(cap.title) changed while that menu was open.  Nothing was sent — reopen it to see the current limit."
            return
        }
        let payload = PolicyTightening.capPayload(
            cap,
            mode: option.mode,
            value: option.value,
            expectedMode: expectedMode,
            expectedValue: expectedValue
        )
        let needsPhrase = PolicyTightening.needsTypedConfirm(
            isLiveAccount: isLiveAccount,
            requireTypedConfirmation: policy?.requireTypedConfirmation,
            isLoosening: option.isLoosening
        )
        if needsPhrase {
            pendingConfirm = PendingPolicyConfirm(
                title: "Raise \(cap.title)",
                message: "Type \(PolicyTightening.loosenConfirmPhrase) to set this to \(option.menuLabel).",
                phrase: PolicyTightening.loosenConfirmPhrase,
                payload: payload,
                operationID: operationID
            )
            typedConfirm = ""
            return
        }
        Task {
            await store.submit(PolicyTightening.commandType, payload: payload, operationID: operationID)
        }
    }

    private func submitCustomAmount() {
        guard let customCap else { return }
        let operationID = PolicyTightening.operationID(customCap.cap.rawValue)
        guard let value = PolicyTightening.parsedCustomValue(customAmount, mode: customCap.mode) else {
            store.error = customCap.mode == .percentOfNav
                ? "Enter a percent of NAV between 0.01 and 100."
                : "Enter a dollar amount of at least $1."
            self.customCap = nil
            customAmount = ""
            return
        }
        let option = PolicyTightening.CapOption(
            mode: customCap.mode,
            value: value,
            isLoosening: PolicyTightening.isLooseningCustom(customCap.cap, mode: customCap.mode, value: value, in: policy),
            switchesMode: customCap.cap.bindingMode(in: policy) != customCap.mode
        )
        self.customCap = nil
        customAmount = ""
        requestCap(customCap.cap, option: option, operationID: operationID)
    }

    private func submitConfirmed(_ pending: PendingPolicyConfirm) {
        let typed = typedConfirm.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        typedConfirm = ""
        guard typed == pending.phrase else {
            store.error = "Type \(pending.phrase) to confirm."
            return
        }
        Task {
            await store.submit(
                PolicyTightening.commandType,
                payload: pending.payload,
                operationID: pending.operationID
            )
        }
    }
}

private struct PendingPolicyConfirm: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    let phrase: String
    let payload: [String: Any]
    let operationID: String
}

private struct PendingCustomCap: Identifiable {
    let id = UUID()
    let cap: PolicyTightening.Cap
    let mode: PolicyTightening.CapMode
}
