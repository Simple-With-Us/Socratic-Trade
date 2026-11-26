import Foundation

/// The symbol sheet's Set Alert form, kept out of the view so the validation rules are
/// XCTest-coverable without hosting SwiftUI.
///
/// The server's `alert.create` command takes exactly `{ symbol, op, price, note? }` and
/// normalizes `op` with `normalizeAlertOp` ("<" / ">" plus word aliases) — this draft only
/// ever sends the two canonical operators, and refuses to build a payload for a price the
/// server would reject (`finiteNumber(..., { min: 0.01 })`).
struct PriceAlertDraft: Equatable {
    enum Direction: String, CaseIterable, Identifiable {
        case above
        case below

        var id: String { rawValue }

        /// Server wire value (`PriceAlertOp`).
        var op: String {
            switch self {
            case .above: return ">"
            case .below: return "<"
            }
        }

        var title: String {
            switch self {
            case .above: return "Above"
            case .below: return "Below"
            }
        }

        /// Sentence-case phrase used in the confirmation line.
        var phrase: String {
            switch self {
            case .above: return "rises above"
            case .below: return "falls below"
            }
        }
    }

    var symbol: String
    var direction: Direction = .above
    var priceText: String = ""
    var note: String = ""

    /// Server-side ceiling on the note (`asOptionalString(payload, "note", 500)`).
    static let noteLimit = 500
    /// Server-side minimum (`finiteNumber(payload, "price", { min: 0.01 })`).
    static let minimumPrice = 0.01

    /// Trimmed, uppercased symbol — the same shape `normalizeSymbol` produces.
    var normalizedSymbol: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    /// Parsed price, or nil when the text is not a usable number.  Accepts a leading "$"
    /// and thousands separators because the field is prefilled from a formatted quote.
    var price: Double? {
        let cleaned = priceText
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
        guard !cleaned.isEmpty, let value = Double(cleaned), value.isFinite else { return nil }
        return value
    }

    /// Why the form cannot submit yet, or nil when it can.  One sentence, shown under the
    /// field — never a blocking alert.
    var validationMessage: String? {
        guard !normalizedSymbol.isEmpty else { return "Enter a symbol." }
        guard let price else { return "Enter a price." }
        guard price >= Self.minimumPrice else {
            return "Enter a price of at least \(AppFormat.money(Self.minimumPrice))."
        }
        return nil
    }

    var canSubmit: Bool { validationMessage == nil }

    /// `alert.create` payload, or nil when the form is invalid.
    func payload() -> [String: Any]? {
        guard let price else { return nil }
        var body: [String: Any] = [
            "symbol": normalizedSymbol,
            "op": direction.op,
            "price": price
        ]
        let trimmedNote = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.noteLimit))
        if !trimmedNote.isEmpty {
            body["note"] = trimmedNote
        }
        return body
    }

    /// One-line receipt for the toast after a successful create.
    var confirmationLine: String {
        "\(normalizedSymbol) \(direction.phrase) \(AppFormat.money(price))."
    }
}