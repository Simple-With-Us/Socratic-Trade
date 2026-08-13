import SwiftUI

enum AppPalette {
    static let background = Color(uiColor: .systemGroupedBackground)
    static let card = Color(uiColor: .secondarySystemGroupedBackground)
    /// Brand teal — matches web `--brand-accent` (#12616f) and dark `--brand-accent-dark` (#58c7d3).
    static let accent = Color(uiColor: UIColor { traits in
        if traits.userInterfaceStyle == .dark {
            return UIColor(red: 0x58 / 255, green: 0xC7 / 255, blue: 0xD3 / 255, alpha: 1) // #58c7d3
        }
        return UIColor(red: 0x12 / 255, green: 0x61 / 255, blue: 0x6F / 255, alpha: 1) // #12616f
    })
    static let positive = Color.green
    static let warning = Color.orange
    static let negative = Color.red
}

enum AppFormat {
    /// Humanized mobile command types — mirrors PWA `commandLabel`. API ids stay dotted.
    private static let commandLabels: [String: String] = [
        "strategy.run_once": "Run Once",
        "strategy.start": "Start Agent",
        "strategy.stop": "Stop Agent",
        "strategy.close_only": "Close Only",
        "strategy.liquidating": "Wind Down",
        "proposal.approve": "Approve Proposal",
        "proposal.reject": "Reject Proposal",
        "account.activate": "Switch Account",
        "watchlist.add": "Add to Watchlist",
        "watchlist.remove": "Remove from Watchlist",
        "alert.create": "Create Alert",
        "alert.delete": "Delete Alert"
    ]

    /// Full money by default (`$99,812.34`). Compact uses lowercase suffixes (`$99.8k`, `$1.2m`)
    /// to match web compact style when used.
    static func money(_ value: Double?, compact: Bool = false) -> String {
        guard let value else { return "—" }
        if compact, abs(value) >= 1_000 {
            let magnitude: Double
            let suffix: String
            if abs(value) >= 1_000_000_000 {
                magnitude = 1_000_000_000
                suffix = "b"
            } else if abs(value) >= 1_000_000 {
                magnitude = 1_000_000
                suffix = "m"
            } else {
                magnitude = 1_000
                suffix = "k"
            }
            let sign = value < 0 ? "−" : ""
            let scaled = abs(value) / magnitude
            return "\(sign)$\(scaled.formatted(.number.precision(.fractionLength(0...1))))\(suffix)"
        }
        return value.formatted(
            .currency(code: "USD")
                .precision(.fractionLength(0...2))
        )
    }

    static func number(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.precision(.fractionLength(0...4)))
    }

    static func percent(_ value: Double?, signed: Bool = false) -> String {
        guard let value else { return "—" }
        let prefix = signed && value > 0 ? "+" : ""
        return "\(prefix)\(value.formatted(.number.precision(.fractionLength(1))))%"
    }

    static func dateTime(_ value: String?) -> String {
        guard let date = date(value) else { return "—" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    static func relative(_ value: String?) -> String {
        // Value/answer copy — sentence case, not a heading.
        guard let date = date(value) else { return "not scheduled" }
        return date.formatted(.relative(presentation: .named))
    }

    static func relative(_ date: Date?) -> String {
        guard let date else { return "never" }
        return date.formatted(.relative(presentation: .named))
    }

    /// Authority glossary: never show raw propose/decide — Ask-First / Autopilot (console parity).
    /// Title-ish for chips/status next to headings; settings *values* use `strategyAuthorityValue`.
    static func strategyAuthorityLabel(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "Ask-First"
        case "decide": return "Autopilot"
        case .none, .some(""): return "—"
        case .some(let raw): return raw.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Settings / LabeledContent *value* — not a heading (owner: "ask-first", "intraday").
    static func strategyAuthorityValue(_ value: String?) -> String {
        switch value?.lowercased() {
        case "propose": return "ask-first"
        case "decide": return "autopilot"
        case .none, .some(""): return "—"
        case .some(let raw): return raw.replacingOccurrences(of: "_", with: " ").lowercased()
        }
    }

    /// Policy horizon value for settings (e.g. "intraday"), not title case.
    static func policyHorizonValue(_ value: String?) -> String {
        guard let value, !value.isEmpty else { return "—" }
        return value.replacingOccurrences(of: "_", with: " ").lowercased()
    }

    /// Cadence value, e.g. "every 60 min" (not "Every 60 min").
    static func cadenceMinutesValue(_ minutes: Int?) -> String {
        guard let minutes else { return "manual" }
        return "every \(minutes) min"
    }

    /// Order / stop type slug → readable words (`stop_market` → `Stop Market`).
    static func orderTypeLabel(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "—" }
        return raw
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    /// Market session for status banner: "Market Closed", "Market Open", etc.
    static func marketSessionBannerLabel(_ session: String?) -> String {
        switch (session ?? "").lowercased() {
        case "regular", "open": return "Market Open"
        case "pre": return "Pre-Market"
        case "post": return "After Hours"
        case "closed": return "Market Closed"
        case "": return "Market Session"
        default:
            return (session ?? "")
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        }
    }

    /// Account environment annotation: live is unmarked (all money is real to the owner);
    /// paper is "Broker (paper)" with lowercase p.
    static func accountBrokerEnvironmentLine(broker: String, environment: String) -> String {
        let name = broker.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = name.isEmpty ? "Broker" : name.prefix(1).uppercased() + name.dropFirst().lowercased()
        if environment.lowercased() == "paper" {
            return "\(display) (paper)"
        }
        return String(display)
    }

    /// Red Team failure-kind slug → console wording (src/lib/red-team-routing.ts
    /// `describeRedTeamFailureKind`): "not configured", "provider error", …, else "unavailable".
    static func redTeamFailureKindLabel(_ failureKind: String?) -> String {
        switch failureKind {
        case "not_configured": return "not configured"
        case "timeout": return "timeout"
        case "provider_error": return "provider error"
        case "rate_limited": return "rate limited"
        case "malformed_response": return "malformed response"
        default: return "unavailable"
        }
    }

    /// AccountCapabilities.accountType slug → console wording (app/console/settings/brokers.tsx
    /// TAXATION_WORD style): never render raw snake_case slugs like "roth_ira" to the user.
    static func accountTypeWord(_ accountType: String) -> String {
        switch accountType {
        case "brokerage": return "brokerage"
        case "roth_ira": return "Roth IRA"
        case "traditional_ira": return "traditional IRA"
        case "crypto_exchange": return "crypto exchange"
        default: return accountType.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// Humanized command type for Activity / busy strips.
    static func commandLabel(_ commandType: String) -> String {
        if let known = commandLabels[commandType] { return known }
        return commandType
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    /// Central time, explicitly labeled — fleet convention for any user-facing timestamp that
    /// shows a timezone. Used by SymbolInfoSheet's quote-as-of line; other mobile timestamps
    /// intentionally stay device-local (unchanged, out of scope here).
    static func dateTimeCentral(_ value: String?) -> String {
        guard let date = date(value) else { return "—" }
        let central = TimeZone(identifier: "America/Chicago") ?? .current
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: central)) + " CT"
    }

    /// P/E display per the repo's P/E honesty convention (mirrors
    /// app/console/ui/drilldown-data.ts `peDisplay`): eps decides the no-ratio state first —
    /// negative/zero trailing earnings render "n/a" (a real, computed "no ratio" state, not
    /// missing data); a strictly positive ratio renders as a number; anything else means the
    /// data simply wasn't available.
    static func peRatioDisplay(peRatio: Double?, eps: Double?) -> String {
        if let eps, eps <= 0 { return "n/a" }
        if let peRatio, peRatio > 0 { return peRatio.formatted(.number.precision(.fractionLength(1))) }
        return "—"
    }

    private static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        if let parsed = ISO8601DateFormatter.withFractionalSeconds.date(from: value) {
            return parsed
        }
        return ISO8601DateFormatter.standard.date(from: value)
    }
}

private extension ISO8601DateFormatter {
    static let standard = ISO8601DateFormatter()

    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct AppCard<Content: View>: View {
    private let content: Content
    private let padding: CGFloat

    init(padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(padding)
            .background(AppPalette.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.primary.opacity(0.06), lineWidth: 1)
            }
    }
}

struct SectionHeading: View {
    let title: String
    let subtitle: String?

    init(_ title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.appTitle3.weight(.semibold))
            if let subtitle {
                Text(subtitle)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Where the optional metric detail sits relative to the large value.
enum MetricTileDetailPlacement: Sendable {
    /// Under the value (default).
    case below
    /// Same row, smaller type to the right of the value (e.g. Positions: "14" + "open holdings").
    case trailing
}

struct MetricTile: View {
    let title: String
    let value: String
    let detail: String?
    let detailPlacement: MetricTileDetailPlacement
    let tint: Color

    init(
        title: String,
        value: String,
        detail: String? = nil,
        detailPlacement: MetricTileDetailPlacement = .below,
        tint: Color = AppPalette.accent
    ) {
        self.title = title
        self.value = value
        self.detail = detail
        self.detailPlacement = detailPlacement
        self.tint = tint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.appCaption)
                .foregroundStyle(.secondary)
            if let detail, detailPlacement == .trailing {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(value)
                        .font(.appTitle3.weight(.semibold))
                        .foregroundStyle(tint)
                        .fixedSize(horizontal: true, vertical: true)
                    Text(detail)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
            } else {
                Text(value)
                    .font(.appTitle3.weight(.semibold))
                    .foregroundStyle(tint)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.appCaption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Company logo for a ticker (same open ticker-icons source as the web console).
/// Falls back to a 1–2 letter monogram when the image is missing or fails to load.
struct TickerLogo: View {
    let symbol: String
    var size: CGFloat = 22

    @State private var failed = false

    private var normalized: String {
        symbol.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "$", with: "")
            .uppercased()
    }

    private var monogram: String {
        let base = normalized.split { $0 == "." || $0 == "-" || $0 == "_" }.first.map(String.init) ?? normalized
        return String(base.prefix(2))
    }

    private var logoURL: URL? {
        guard !normalized.isEmpty else { return nil }
        // Parity with src/lib/ticker-logos.ts TICKER_LOGO_BASE_URL
        return URL(string: "https://raw.githubusercontent.com/davidepalazzo/ticker-logos/main/ticker_icons/\(normalized).png")
    }

    var body: some View {
        Group {
            if failed || logoURL == nil {
                monogramView
            } else if let logoURL {
                AsyncImage(url: logoURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                            .padding(2)
                    case .failure:
                        monogramView
                            .onAppear { failed = true }
                    case .empty:
                        ProgressView()
                            .controlSize(.mini)
                    @unknown default:
                        monogramView
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
        .onChange(of: normalized) { _, _ in failed = false }
    }

    private var monogramView: some View {
        Text(monogram)
            .font(.custom(AppFont.bold, size: max(9, size * 0.38)))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Identifiable wrapper for `.sheet(item:)` presentation of `SymbolInfoSheet` from any list row.
/// Each screen that shows symbols (Activity, Markets) owns one `@State private var
/// presentedSymbol: PresentedSymbol?` and threads it down as a `Binding` to `SymbolTapButton`.
struct PresentedSymbol: Identifiable, Equatable {
    let symbol: String
    var id: String { symbol }
}

/// Tappable ticker logo + symbol text that opens `SymbolInfoSheet` for `symbol` — the mobile
/// counterpart to the web console's `SymbolButton` (app/console/ui/symbol-drilldown.tsx). Wrap
/// wherever a row shows a symbol; pass `action` to set the screen's `presentedSymbol` state.
/// A real button (not a bare tap gesture), so it carries button accessibility traits for free —
/// only the accessible label needs to be supplied here.
struct SymbolTapButton: View {
    let symbol: String
    var logoSize: CGFloat = 26
    var font: Font = .headline
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                TickerLogo(symbol: symbol, size: logoSize)
                Text(symbol)
                    .font(font)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(symbol) company info")
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    let systemImage: String?

    init(_ text: String, color: Color, systemImage: String? = nil) {
        self.text = text
        self.color = color
        self.systemImage = systemImage
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(text)
        }
        .font(.appCaption.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(color.opacity(0.12), in: Capsule())
    }
}

struct EmptyStateCard: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        AppCard {
            VStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.appTitle2)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.appHeadline)
                Text(message)
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
        }
    }
}

struct InlineErrorBanner: View {
    let message: String
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        AppCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(AppPalette.warning)
                VStack(alignment: .leading, spacing: 8) {
                    Text(message)
                        .font(.appSubheadline)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Retry", action: retry)
                            .buttonStyle(.bordered)
                        Button("Dismiss", action: dismiss)
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }
}

struct SnapshotScaffold<Content: View>: View {
    @EnvironmentObject private var store: MobileStore

    let content: (MobileSnapshot) -> Content

    init(@ViewBuilder content: @escaping (MobileSnapshot) -> Content) {
        self.content = content
    }

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()

            ScrollView {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    LazyVStack(spacing: 14) {
                        if let snapshot = store.snapshot {
                            SnapshotStatusBanner(snapshot: snapshot, now: context.date)
                            if let error = store.error {
                                InlineErrorBanner(
                                    message: error,
                                    retry: refresh,
                                    dismiss: store.dismissError
                                )
                            }
                            content(snapshot)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
            .refreshable {
                await store.load()
            }

            if store.snapshot == nil {
                InitialSnapshotState()
            }
        }
    }

    private func refresh() {
        Task { await store.load() }
    }
}

private struct InitialSnapshotState: View {
    @EnvironmentObject private var store: MobileStore

    var body: some View {
        VStack(spacing: 16) {
            if store.isRefreshing || store.isInitialLoading {
                ProgressView()
                    .controlSize(.large)
                Text("Loading your trading workspace…")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "wifi.exclamationmark")
                    .font(.appLargeTitle)
                    .foregroundStyle(AppPalette.warning)
                Text("Couldn’t load your workspace")
                    .font(.appHeadline)
                Text(store.error ?? "Check your connection and try again.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Try Again") {
                    Task { await store.load() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(28)
    }
}

private struct SnapshotStatusBanner: View {
    @EnvironmentObject private var store: MobileStore

    let snapshot: MobileSnapshot
    let now: Date

    var body: some View {
        let stale = store.isSnapshotStale(at: now)
        HStack(spacing: 8) {
            StatusPill(
                stale ? "Stale" : "Updated",
                color: stale ? AppPalette.warning : AppPalette.positive,
                systemImage: stale ? "clock.badge.exclamationmark" : "checkmark.circle.fill"
            )
            Text("\(AppFormat.relative(store.lastUpdatedAt))")
                .font(.appCaption)
                .foregroundStyle(.secondary)
            Spacer()
            if store.isRefreshing {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Refreshing")
            } else {
                Image(systemName: store.isStreamConnected ? "dot.radiowaves.left.and.right" : "arrow.triangle.2.circlepath")
                    .foregroundStyle(store.isStreamConnected ? AppPalette.positive : .secondary)
                    .accessibilityLabel(store.isStreamConnected ? "Stream connected" : "Reconnecting")
            }
            // Keep the circlepath / radio glyph; label is "Market Closed" etc. on every tab.
            Text(AppFormat.marketSessionBannerLabel(snapshot.marketSession))
                .font(.appCaption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
    }
}

/// Presentation for the shared run-state vocabulary (tones mirror console deriveStateInfo:
/// running=pos, paused=muted, exit-only/winding-down=warn, stopped=neg).
extension RunStateWord {
    var pillColor: Color {
        switch self {
        case .running: return AppPalette.positive
        case .pausedMarketClosed: return .secondary
        case .exitOnly, .windingDown: return AppPalette.warning
        case .stopped: return AppPalette.negative
        }
    }

    var pillSystemImage: String {
        switch self {
        case .running: return "bolt.fill"
        case .pausedMarketClosed: return "moon.zzz.fill"
        case .exitOnly, .windingDown: return "arrow.down.right.circle"
        case .stopped: return "pause.fill"
        }
    }
}

/// Trailing swipe-reveal action for card rows inside ScrollView stacks (SwiftUI's
/// `.swipeActions` is List-only).  Swiping left reveals one action button; tapping it fires
/// `perform` and closes.  The gesture needs a mostly-horizontal drag, so vertical scrolling
/// keeps working.  This adds a faster path to EXISTING actions only — same handlers, same
/// ceremony — never a new kind of confirmation.
struct SwipeRevealAction: ViewModifier {
    let title: String
    let systemImage: String
    let tint: Color
    let isEnabled: Bool
    let perform: () -> Void

    @State private var offset: CGFloat = 0
    @State private var isOpen = false

    private let actionWidth: CGFloat = 88

    func body(content: Content) -> some View {
        content
            .offset(x: offset)
            .background(alignment: .trailing) {
                if offset < 0 {
                    Button(action: fire) {
                        VStack(spacing: 5) {
                            Image(systemName: systemImage)
                                .font(.appBody.weight(.semibold))
                            Text(title)
                                .font(.appCaption.weight(.semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(width: actionWidth)
                        .frame(maxHeight: .infinity)
                        .background(tint, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(title)
                }
            }
            // Plain .gesture (not highPriority): the ScrollView keeps winning vertical pans.
            .gesture(dragGesture, including: isEnabled ? .all : .subviews)
            .onTapGesture {
                if isOpen { close() }
            }
            .animation(.snappy(duration: 0.22), value: offset)
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 24, coordinateSpace: .local)
            .onChanged { value in
                guard isEnabled else { return }
                // Mostly-horizontal drags only, so the scroll view keeps vertical swipes.
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                let base = isOpen ? -actionWidth : 0
                offset = min(0, max(-actionWidth - 26, base + value.translation.width))
            }
            .onEnded { value in
                guard isEnabled else { return }
                if offset < -actionWidth * 0.55 {
                    offset = -actionWidth
                    isOpen = true
                } else {
                    close()
                }
            }
    }

    private func fire() {
        close()
        perform()
    }

    private func close() {
        offset = 0
        isOpen = false
    }
}

extension View {
    /// See `SwipeRevealAction`.
    func swipeRevealAction(
        title: String,
        systemImage: String,
        tint: Color,
        isEnabled: Bool = true,
        perform: @escaping () -> Void
    ) -> some View {
        modifier(SwipeRevealAction(
            title: title,
            systemImage: systemImage,
            tint: tint,
            isEnabled: isEnabled,
            perform: perform
        ))
    }
}

/// Horizontal wrap that sizes each child to its intrinsic width.
/// Used by watchlist chips so a logo + ticker + remove control is never
/// forced into a too-narrow equal-width grid cell (which wrapped `SPCX`
/// onto two lines).  Layout math is in `WrappingHStackLayout` so XCTest
/// can cover wrap vs. single-line without hosting SwiftUI.
struct WrappingHStack: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        return WrappingHStackLayout.place(
            widths: sizes.map(\.width),
            heights: sizes.map(\.height),
            containerWidth: proposal.width ?? .infinity,
            spacing: spacing,
            lineSpacing: lineSpacing
        ).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let result = WrappingHStackLayout.place(
            widths: sizes.map(\.width),
            heights: sizes.map(\.height),
            containerWidth: bounds.width,
            spacing: spacing,
            lineSpacing: lineSpacing
        )
        for index in subviews.indices {
            subviews[index].place(
                at: CGPoint(
                    x: bounds.minX + result.origins[index].x,
                    y: bounds.minY + result.origins[index].y
                ),
                proposal: ProposedViewSize(sizes[index])
            )
        }
    }
}

enum WrappingHStackLayout {
    struct Result: Equatable {
        var size: CGSize
        var origins: [CGPoint]
    }

    static func place(
        widths: [CGFloat],
        heights: [CGFloat],
        containerWidth: CGFloat,
        spacing: CGFloat,
        lineSpacing: CGFloat
    ) -> Result {
        precondition(widths.count == heights.count)
        guard !widths.isEmpty else {
            return Result(size: .zero, origins: [])
        }

        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var maxX: CGFloat = 0
        var origins: [CGPoint] = []
        origins.reserveCapacity(widths.count)

        for index in widths.indices {
            let width = widths[index]
            let height = heights[index]
            if x > 0 && x + width > containerWidth {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += width
            maxX = max(maxX, x)
            x += spacing
            lineHeight = max(lineHeight, height)
        }

        return Result(
            size: CGSize(width: maxX, height: y + lineHeight),
            origins: origins
        )
    }
}

struct CommandButton: View {
    let title: String
    let systemImage: String
    let isBusy: Bool
    let isDisabled: Bool
    let role: ButtonRole?
    let prominent: Bool
    let action: () -> Void

    init(
        _ title: String,
        systemImage: String,
        isBusy: Bool,
        isDisabled: Bool = false,
        role: ButtonRole? = nil,
        prominent: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isBusy = isBusy
        self.isDisabled = isDisabled
        self.role = role
        self.prominent = prominent
        self.action = action
    }

    @ViewBuilder
    var body: some View {
        if prominent {
            button
                .buttonStyle(.borderedProminent)
        } else {
            button
                .buttonStyle(.bordered)
        }
    }

    private var button: some View {
        Button(role: role, action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                }
                Text(title)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
        }
        .disabled(isBusy || isDisabled)
    }
}
