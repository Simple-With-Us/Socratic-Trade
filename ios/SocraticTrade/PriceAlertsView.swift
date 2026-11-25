import Foundation
import SwiftUI

/// Price alerts for one symbol — the iOS counterpart of the web Watchlist page's Price Alerts
/// card (app/console/watchlist/page.tsx).  The list reads `snapshot.alerts`, which the backend
/// already ships on every workspace snapshot; creating and deleting go through the existing
/// `alert.create` / `alert.delete` mobile commands, so the phone never evaluates the trigger.
/// Alerts fire server-side, notify once, and never re-arm by themselves.

// MARK: - Direction model (the only wire vocabulary the trigger understands)

/// Above / below.  Codable round-trips the raw values; `op` maps to what the server
/// normalizes (`normalizeAlertOp` in src/lib/alerts.ts accepts both aliases and symbols).
enum PriceAlertDirection: String, Codable, CaseIterable, Identifiable {
    case above
    case below

    var id: String { rawValue }

    /// The stored/sent op token.
    var op: String {
        switch self {
        case .above: return ">"
        case .below: return "<"
        }
    }

    /// Picker option label — a control label, so Title Case.
    var label: String {
        switch self {
        case .above: return "Above"
        case .below: return "Below"
        }
    }

    /// Maps a stored/sent op token back to the direction; nil for anything else.
    static func from(op raw: String) -> PriceAlertDirection? {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case ">", "above", "over", "gt", "greater": return .above
        case "<", "below", "under", "lt", "less": return .below
        default: return nil
        }
    }
}

// MARK: - Pure form validation (XCTest covers this without hosting SwiftUI)

enum PriceAlertFormError: Equatable {
    case missingSymbol
    case invalidPrice
}

enum PriceAlertForm {
    static func normalizedSymbol(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    /// Parses a typed price.  Accepts stray `$` / thousands separators; rejects anything
    /// non-finite or not strictly positive (the server additionally floors it at $0.01).
    static func price(from raw: String) -> Double? {
        let cleaned = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
        guard let value = Double(cleaned), value.isFinite, value > 0 else { return nil }
        return value
    }

    static func validate(symbol: String, priceText: String) -> PriceAlertFormError? {
        if normalizedSymbol(symbol).isEmpty { return .missingSymbol }
        if price(from: priceText) == nil { return .invalidPrice }
        return nil
    }

    /// The `alert.create` payload shape `parseMobileCommand` (src/lib/mobile-api.ts) expects.
    static func payload(
        symbol: String,
        direction: PriceAlertDirection,
        price: Double,
        note: String
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "symbol": normalizedSymbol(symbol),
            "op": direction.op,
            "price": price
        ]
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedNote.isEmpty {
            payload["note"] = trimmedNote
        }
        return payload
    }
}

// MARK: - Alerts section (entry point inside SymbolInfoSheet)

struct PriceAlertsCard: View {
    @Environment(MobileStore.self) private var store

    let symbol: String

    @State private var isCreating = false

    private var normalized: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    private var alerts: [PriceAlert] {
        (store.snapshot?.alerts ?? [])
            .filter { $0.symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == normalized }
            // Armed rows first, newest first inside each group — mirrors the web card's sort.
            .sorted { a, b in
                if (a.status == "armed") != (b.status == "armed") { return a.status == "armed" }
                return (a.createdAt ?? "") > (b.createdAt ?? "")
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeading("Price Alerts")
            AppCard {
                VStack(alignment: .leading, spacing: 10) {
                    if alerts.isEmpty {
                        Text("No alerts on \(normalized) yet.")
                            .font(.appSubheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(alerts) { alert in
                            PriceAlertRow(alert: alert)
                        }
                    }
                    Button {
                        isCreating = true
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: "plus.circle")
                            Text("Add Alert")
                                .fontWeight(.semibold)
                        }
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.canSubmit("alert.create"))
                    Text("The server checks alerts on its own schedule.\u{00A0} A trigger notifies once and does not re-arm.")
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .sheet(isPresented: $isCreating) {
            PriceAlertCreateSheet(defaultSymbol: normalized)
        }
    }
}

private struct PriceAlertRow: View {
    @Environment(MobileStore.self) private var store

    let alert: PriceAlert

    private var deleteOperationID: String { "alert.delete:\(alert.id)" }

    private var directionWord: String {
        // Values are sentence case per FLEET-UI-COPY; an unrecognized stored op falls through
        // to the raw token rather than silently claiming a direction the trigger never had.
        PriceAlertDirection.from(op: alert.op)?.rawValue ?? alert.op
    }

    private var statusPill: some View {
        Group {
            if alert.status == "armed" {
                StatusPill("armed", color: AppPalette.accent)
            } else if alert.status == "triggered" {
                if let triggeredPrice = alert.triggeredPrice {
                    StatusPill("triggered at \(AppFormat.money(triggeredPrice))", color: AppPalette.positive)
                } else {
                    StatusPill("triggered", color: AppPalette.positive)
                }
            } else {
                StatusPill(alert.status.replacingOccurrences(of: "_", with: " ").lowercased(), color: .secondary)
            }
        }
    }

    var body: some View {
        AppCard(padding: 12) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(directionWord)
                            .font(.appSubheadline.weight(.semibold))
                            .foregroundStyle(Color.primary)
                        Text(AppFormat.money(alert.price))
                            .font(.appSubheadline.monospacedDigit())
                            .foregroundStyle(Color.primary)
                    }
                    HStack(spacing: 6) {
                        statusPill
                        if let triggeredAt = alert.triggeredAt {
                            Text(AppFormat.relative(triggeredAt))
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                        } else if let createdAt = alert.createdAt {
                            Text(AppFormat.relative(createdAt))
                                .font(.appCaption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let note = alert.note, !note.isEmpty {
                        Text(note)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                Button {
                    deleteAlert()
                } label: {
                    Group {
                        if store.isBusy(deleteOperationID) {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "trash")
                        }
                    }
                    .font(.appBody)
                    .foregroundStyle(AppPalette.negative)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.isBusy(deleteOperationID) || !store.canSubmit("alert.delete"))
                .accessibilityLabel("Delete \(alert.symbol) \(directionWord) \(AppFormat.money(alert.price)) alert")
            }
        }
        .swipeRevealAction(
            title: "Delete",
            systemImage: "trash",
            tint: AppPalette.negative,
            isEnabled: store.canSubmit("alert.delete") && !store.isBusy(deleteOperationID)
        ) {
            deleteAlert()
        }
    }

    private func deleteAlert() {
        Task {
            await store.submit(
                "alert.delete",
                payload: ["alertId": alert.id],
                operationID: deleteOperationID
            )
        }
    }
}

// MARK: - Create sheet

private struct PriceAlertCreateSheet: View {
    @Environment(MobileStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var symbol: String
    @State private var direction: PriceAlertDirection = .above
    @State private var priceText: String = ""
    @State private var noteText: String = ""
    @State private var formError: String?

    init(defaultSymbol: String) {
        _symbol = State(initialValue: defaultSymbol)
    }

    private var operationID: String { "alert.create:\(PriceAlertForm.normalizedSymbol(symbol))" }

    private var isValid: Bool {
        PriceAlertForm.validate(symbol: symbol, priceText: priceText) == nil
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Ticker")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                    TextField("AAPL", text: $symbol)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Direction")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                    Picker("Direction", selection: $direction) {
                        ForEach(PriceAlertDirection.allCases) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text("Above fires when the price rises past the level; below fires when it falls past it.")
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Price $")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                    TextField("0.00", text: $priceText)
                        .keyboardType(.decimalPad)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Note (optional)")
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                    TextField("Why this level matters", text: $noteText)
                        .textInputAutocapitalization(.sentences)
                }
                if let formError {
                    Text(formError)
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Button {
                    createAlert()
                } label: {
                    Text(store.isBusy(operationID) ? "Saving…" : "Add Alert")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isValid || store.isBusy(operationID) || !store.canSubmit("alert.create"))
            }
            .padding(24)
            .background(AppPalette.background.ignoresSafeArea())
            .navigationTitle("New Alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func createAlert() {
        guard let error = PriceAlertForm.validate(symbol: symbol, priceText: priceText) else {
            submit()
            return
        }
        switch error {
        case .missingSymbol:
            formError = "Enter a ticker first."
        case .invalidPrice:
            formError = "Enter a price above zero."
        }
    }

    private func submit() {
        formError = nil
        let payload = PriceAlertForm.payload(
            symbol: symbol,
            direction: direction,
            price: PriceAlertForm.price(from: priceText) ?? 0,
            note: noteText
        )
        Task {
            let ok = await store.submit("alert.create", payload: payload, operationID: operationID)
            if ok {
                dismiss()
            } else {
                formError = "Alert not created.\u{00A0} Check the ticker and price, then try again."
            }
        }
    }
}
