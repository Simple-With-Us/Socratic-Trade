import Foundation

// MARK: - Coach chat

struct ChatHistoryResponse: Decodable {
    let turns: [ChatTurn]
}

struct ChatTurn: Decodable, Identifiable, Equatable {
    let id: String
    let role: String
    let text: String
    let citations: [String]
    let intent: String?
    let model: String?
    let createdAt: String?

    var isUser: Bool { role.lowercased() == "user" }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, citations, intent, model, createdAt
    }

    init(
        id: String,
        role: String,
        text: String,
        citations: [String] = [],
        intent: String? = nil,
        model: String? = nil,
        createdAt: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.citations = citations
        self.intent = intent
        self.model = model
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        role = try values.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
        citations = try values.decodeIfPresent([String].self, forKey: .citations) ?? []
        intent = try values.decodeIfPresent(String.self, forKey: .intent)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct ChatReply: Decodable {
    let text: String
    let draft: ChatDraft?
    let citations: [ChatCitation]
    let intent: String?
    let model: String?
    let learningCapture: ChatLearningCapture?

    private enum CodingKeys: String, CodingKey {
        case text, draft, citations, intent, model, learningCapture, error, message
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if let error = try values.decodeIfPresent(String.self, forKey: .error),
           try values.decodeIfPresent(String.self, forKey: .text) == nil {
            throw DecodingError.dataCorruptedError(
                forKey: .text,
                in: values,
                debugDescription: error
            )
        }
        text = try values.decodeIfPresent(String.self, forKey: .text)
            ?? values.decodeIfPresent(String.self, forKey: .message)
            ?? ""
        draft = try values.decodeIfPresent(ChatDraft.self, forKey: .draft)
        citations = try values.decodeIfPresent([ChatCitation].self, forKey: .citations) ?? []
        intent = try values.decodeIfPresent(String.self, forKey: .intent)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        learningCapture = try values.decodeIfPresent(ChatLearningCapture.self, forKey: .learningCapture)
    }
}

struct ChatCitation: Decodable, Identifiable, Hashable {
    var id: String { [source, evidenceRef, url].compactMap { $0 }.joined(separator: "|") }

    let source: String
    let evidenceRef: String?
    let url: String?

    private enum CodingKeys: String, CodingKey {
        case source
        case evidenceRef = "evidence_ref"
        case evidenceRefCamel = "evidenceRef"
        case url
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "source"
        evidenceRef = try values.decodeIfPresent(String.self, forKey: .evidenceRef)
            ?? values.decodeIfPresent(String.self, forKey: .evidenceRefCamel)
        url = try values.decodeIfPresent(String.self, forKey: .url)
    }
}

struct ChatDraft: Decodable, Identifiable {
    var id: String { draftId }

    let draftId: String
    let symbol: String
    let side: String
    let quantity: Double?
    let orderType: String?
    let limitUsd: Double?
    let rationale: String?
    let accountLabel: String?
    let isReal: Bool?
    let blocked: Bool?
    let warnings: [String]

    private enum CodingKeys: String, CodingKey {
        case draftId = "draft_id"
        case symbol, side
        case qty
        case quantity
        case orderType = "order_type"
        case limitUsd = "limit_usd"
        case rationale
        case accountLabel = "account_label"
        case isReal = "is_real"
        case blocked
        case warnings
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        draftId = try values.decodeIfPresent(String.self, forKey: .draftId) ?? UUID().uuidString
        symbol = try values.decodeIfPresent(String.self, forKey: .symbol) ?? "—"
        side = try values.decodeIfPresent(String.self, forKey: .side) ?? ""
        quantity = try values.decodeIfPresent(Double.self, forKey: .qty)
            ?? values.decodeIfPresent(Double.self, forKey: .quantity)
        orderType = try values.decodeIfPresent(String.self, forKey: .orderType)
        limitUsd = try values.decodeIfPresent(Double.self, forKey: .limitUsd)
        rationale = try values.decodeIfPresent(String.self, forKey: .rationale)
        accountLabel = try values.decodeIfPresent(String.self, forKey: .accountLabel)
        isReal = try values.decodeIfPresent(Bool.self, forKey: .isReal)
        blocked = try values.decodeIfPresent(Bool.self, forKey: .blocked)
        warnings = try values.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }
}

struct ChatLearningCapture: Decodable {
    let kind: String?
    let receipt: String?
}

struct ChatProvidersResponse: Decodable {
    let providers: [String: Bool]
}

/// Curated Coach models — ids must match `app/ui/llm-model-catalog.ts` / `chatProviderForModel`.
enum CoachModelCatalog {
    struct Option: Identifiable, Equatable {
        let id: String
        let label: String
        let provider: String
        let detail: String
    }

    static let storageKey = "console.assistant.model"

    static let options: [Option] = [
        .init(id: "gpt-5.4-mini", label: "GPT Mini", provider: "openai", detail: "low-cost OpenAI"),
        .init(id: "gpt-5.6-terra", label: "GPT Terra", provider: "openai", detail: "balanced OpenAI"),
        .init(id: "claude-haiku-4.5", label: "Claude Haiku", provider: "anthropic", detail: "fast Claude"),
        .init(id: "claude-sonnet-5", label: "Claude Sonnet", provider: "anthropic", detail: "balanced Claude"),
        .init(id: "grok-4.5", label: "Grok", provider: "xai", detail: "default Grok"),
        .init(id: "gemini-flash-latest", label: "Gemini Flash", provider: "gemini", detail: "stable Flash"),
        .init(id: "mock", label: "Mock (offline)", provider: "mock", detail: "keyless offline path")
    ]

    static func provider(for model: String) -> String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed == "mock" { return "mock" }
        if trimmed.hasPrefix("claude") { return "anthropic" }
        if trimmed.hasPrefix("grok") { return "xai" }
        if trimmed.hasPrefix("gemini") { return "gemini" }
        if trimmed.hasPrefix("mistral") || trimmed.hasPrefix("codestral") { return "mistral" }
        if trimmed.hasPrefix("deepseek") { return "deepseek" }
        if trimmed.hasPrefix("kimi") || trimmed.hasPrefix("moonshot") { return "moonshot" }
        return "openai"
    }

    static func firstAvailable(providers: [String: Bool]) -> Option? {
        options.first { option in
            option.provider == "mock" || providers[option.provider] == true
        }
    }

    static func isAvailable(_ option: Option, providers: [String: Bool]) -> Bool {
        option.provider == "mock" || providers[option.provider] == true
    }
}

// MARK: - Scan

struct MarketScanResponse: Decodable {
    let topCandidates: [ScanCandidate]
    let asOf: String?
    let generatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case topCandidates
        case asOf
        case generatedAt
        case scannedAt
        case createdAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        topCandidates = try values.decodeIfPresent([ScanCandidate].self, forKey: .topCandidates) ?? []
        asOf = try values.decodeIfPresent(String.self, forKey: .asOf)
            ?? values.decodeIfPresent(String.self, forKey: .generatedAt)
            ?? values.decodeIfPresent(String.self, forKey: .scannedAt)
            ?? values.decodeIfPresent(String.self, forKey: .createdAt)
        generatedAt = try values.decodeIfPresent(String.self, forKey: .generatedAt)
    }
}

struct ScanCandidate: Decodable, Identifiable {
    var id: String { symbol }

    let symbol: String
    let companyName: String?
    let price: Double?
    let score: Double?
    let intradayChangePct: Double?
    let sector: String?
    let volume: Double?
    let bid: Double?
    let ask: Double?

    private enum CodingKeys: String, CodingKey {
        case symbol, companyName, price, score, intradayChangePct, sector, volume, bid, ask
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        symbol = try values.decodeIfPresent(String.self, forKey: .symbol) ?? "—"
        companyName = try values.decodeIfPresent(String.self, forKey: .companyName)
        price = try values.decodeIfPresent(Double.self, forKey: .price)
        score = try values.decodeIfPresent(Double.self, forKey: .score)
        intradayChangePct = try values.decodeIfPresent(Double.self, forKey: .intradayChangePct)
        sector = try values.decodeIfPresent(String.self, forKey: .sector)
        volume = try values.decodeIfPresent(Double.self, forKey: .volume)
        bid = try values.decodeIfPresent(Double.self, forKey: .bid)
        ask = try values.decodeIfPresent(Double.self, forKey: .ask)
    }
}

// MARK: - Full policy (GET /api/policy)

struct FullPolicy: Decodable {
    let systemState: String?
    let strategyAuthority: String?
    let holdingHorizon: String?
    let runCadenceMinutes: Int?
    let runDuringExtendedHours: Bool?
    let maxOrderNotional: Double?
    let maxOrderPctOfNav: Double?
    let maxDailyNotional: Double?
    let maxDailyPctOfNav: Double?
    let maxDailyOrders: Int?
    let requireTypedConfirmation: Bool?
    let includedIndices: [String]?
    let additionalSymbols: [String]?
    let blocklist: [String]?
    let llmModel: String?
    let redTeamLlmModel: String?
    let sellToFundBuy: String?
    let socraticOverrideMode: String?
    let stopLossPct: Double?
    let trailingStopPct: Double?
    let shortStopLossPct: Double?
    let taxSettings: PolicyTaxSettings?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        systemState = try values.decodeIfPresent(String.self, forKey: .systemState)
        strategyAuthority = try values.decodeIfPresent(String.self, forKey: .strategyAuthority)
        holdingHorizon = try values.decodeIfPresent(String.self, forKey: .holdingHorizon)
        runCadenceMinutes = try values.decodeIfPresent(Int.self, forKey: .runCadenceMinutes)
        runDuringExtendedHours = try values.decodeIfPresent(Bool.self, forKey: .runDuringExtendedHours)
        maxOrderNotional = try values.decodeIfPresent(Double.self, forKey: .maxOrderNotional)
        maxOrderPctOfNav = try values.decodeIfPresent(Double.self, forKey: .maxOrderPctOfNav)
        maxDailyNotional = try values.decodeIfPresent(Double.self, forKey: .maxDailyNotional)
        maxDailyPctOfNav = try values.decodeIfPresent(Double.self, forKey: .maxDailyPctOfNav)
        maxDailyOrders = try values.decodeIfPresent(Int.self, forKey: .maxDailyOrders)
        requireTypedConfirmation = try values.decodeIfPresent(Bool.self, forKey: .requireTypedConfirmation)
        includedIndices = try values.decodeIfPresent([String].self, forKey: .includedIndices)
        additionalSymbols = try values.decodeIfPresent([String].self, forKey: .additionalSymbols)
        blocklist = try values.decodeIfPresent([String].self, forKey: .blocklist)
        llmModel = try values.decodeIfPresent(String.self, forKey: .llmModel)
        redTeamLlmModel = try values.decodeIfPresent(String.self, forKey: .redTeamLlmModel)
        sellToFundBuy = try values.decodeIfPresent(String.self, forKey: .sellToFundBuy)
        socraticOverrideMode = try values.decodeIfPresent(String.self, forKey: .socraticOverrideMode)
        stopLossPct = try values.decodeIfPresent(Double.self, forKey: .stopLossPct)
        trailingStopPct = try values.decodeIfPresent(Double.self, forKey: .trailingStopPct)
        shortStopLossPct = try values.decodeIfPresent(Double.self, forKey: .shortStopLossPct)
        taxSettings = try values.decodeIfPresent(PolicyTaxSettings.self, forKey: .taxSettings)
    }

    private enum CodingKeys: String, CodingKey {
        case systemState, strategyAuthority, holdingHorizon, runCadenceMinutes
        case runDuringExtendedHours, maxOrderNotional, maxOrderPctOfNav
        case maxDailyNotional, maxDailyPctOfNav, maxDailyOrders
        case requireTypedConfirmation, includedIndices, additionalSymbols, blocklist
        case llmModel, redTeamLlmModel, sellToFundBuy, socraticOverrideMode
        case stopLossPct, trailingStopPct, shortStopLossPct, taxSettings
    }
}

struct PolicyTaxSettings: Decodable {
    let taxationType: String?
    let washSaleGuard: Bool?
    let washSaleHandling: String?
    let shortTermRatePct: Double?
    let longTermRatePct: Double?
}

// MARK: - Data sources

struct SourceFeaturesPatchAck: Decodable {
    let ok: Bool?
}

struct SourceFeaturesResponse: Decodable {
    let settings: [SourceSettingRow]
    let groups: [String: SourceSettingGroupInfo]

    private enum CodingKeys: String, CodingKey {
        case settings, groups
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        settings = try values.decodeIfPresent([SourceSettingRow].self, forKey: .settings) ?? []
        groups = try values.decodeIfPresent([String: SourceSettingGroupInfo].self, forKey: .groups) ?? [:]
    }
}

struct SourceSettingGroupInfo: Decodable {
    let title: String
    let blurb: String?
}

struct SourceSettingRow: Decodable, Identifiable {
    let id: String
    let group: String
    let label: String
    let description: String?
    let type: String
    let advanced: Bool
    let caveat: String?
    let source: String?
    let value: SourceSettingValue

    private enum CodingKeys: String, CodingKey {
        case id, group, label, description, type, advanced, caveat, source, value
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        group = try values.decodeIfPresent(String.self, forKey: .group) ?? "other"
        label = try values.decodeIfPresent(String.self, forKey: .label) ?? id
        description = try values.decodeIfPresent(String.self, forKey: .description)
        type = try values.decodeIfPresent(String.self, forKey: .type) ?? "string"
        advanced = try values.decodeIfPresent(Bool.self, forKey: .advanced) ?? false
        caveat = try values.decodeIfPresent(String.self, forKey: .caveat)
        source = try values.decodeIfPresent(String.self, forKey: .source)
        value = try values.decodeIfPresent(SourceSettingValue.self, forKey: .value) ?? .none
    }
}

enum SourceSettingValue: Decodable, Equatable {
    case bool(Bool)
    case number(Double)
    case string(String)
    case none

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .none
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Int.self) {
            self = .number(Double(value))
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            self = .none
        }
    }

    var boolValue: Bool {
        if case .bool(let value) = self { return value }
        return false
    }

    var displayValue: String {
        switch self {
        case .bool(let value): return value ? "on" : "off"
        case .number(let value): return value.formatted(.number.precision(.fractionLength(0...2)))
        case .string(let value): return value.isEmpty ? "—" : value
        case .none: return "—"
        }
    }
}

enum SourceSettingGroupOrder {
    static let known = ["fmp", "sec", "web_sources", "rag", "transcripts", "enrichment"]

    static func title(for group: String, catalog: [String: SourceSettingGroupInfo]) -> String {
        if let title = catalog[group]?.title, !title.isEmpty { return title }
        switch group {
        case "fmp": return "Financial Modeling Prep"
        case "sec": return "SEC EDGAR & Filings"
        case "web_sources": return "Web Sources"
        case "rag": return "RAG / Retrieval"
        case "transcripts": return "Earnings Transcripts"
        case "enrichment": return "Enrichment Cascade"
        default: return group.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func sortedKeys(from settings: [SourceSettingRow]) -> [String] {
        let present = Array(Set(settings.map(\.group)))
        let known = known.filter(present.contains)
        let extra = present.filter { !known.contains($0) }.sorted()
        return known + extra
    }
}

// MARK: - Shared display helpers

enum DeskCopy {
    /// Authority is Autopilot / Ask-First.  Run state is Running / Paused / Stopped.
    /// Never blend the two — Autopilot can be paused when the market is closed.
    static func authorityVersusRunState(
        authority: String?,
        runState: RunStateWord
    ) -> String {
        let authorityWord = AppFormat.strategyAuthorityLabel(authority)
        switch runState {
        case .running:
            return "\(authorityWord) is the decision style.  Run state is Running — scheduled cycles are live."
        case .pausedMarketClosed:
            return "\(authorityWord) is the decision style.  Run state is Paused · market closed — scheduled cycles wait for the next regular session."
        case .exitOnly:
            return "\(authorityWord) is the decision style.  Run state is Exit-only — new buys are blocked."
        case .windingDown:
            return "\(authorityWord) is the decision style.  Run state is Winding down — only sells are submitted."
        case .stopped:
            return "\(authorityWord) is the decision style.  Run state is Stopped — the agent is not scheduling cycles."
        }
    }

    static func joinedList(_ values: [String]?) -> String {
        let trimmed = (values ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return trimmed.isEmpty ? "none" : trimmed.joined(separator: ", ")
    }

    static func yesNo(_ value: Bool?) -> String {
        guard let value else { return "—" }
        return value ? "yes" : "no"
    }

    static func percentPoints(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(value.formatted(.number.precision(.fractionLength(0...2))))%"
    }
}
