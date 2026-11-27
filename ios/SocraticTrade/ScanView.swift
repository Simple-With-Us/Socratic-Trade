import SwiftUI

/// Interactive market scan table — GET `/api/scan`, same refresh the console Scan tab uses.
struct ScanView: View {
    @Environment(MobileStore.self) private var store

    @State private var scan: MarketScanResponse?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var staleScanNote: String?
    @State private var priceAgeNote: String?
    @State private var didAttemptLiveRefresh = false
    @State private var query = ""
    @State private var sortOption: ScanSortOption = .ranked
    @State private var presentedSymbol: PresentedSymbol?

    var body: some View {
        SnapshotScaffold(hidesWorkspaceError: true) { snapshot in
            header(snapshot: snapshot)
                .cardSpansAllColumns()
            weeklyScreensCard(snapshot: snapshot)
                .cardSpansAllColumns()
            content
        }
        .navigationTitle("Scan")
        .navigationBarTitleDisplayMode(.inline)
        // ST-4687 (R2l): the plain in-card TextField became the system search field —
        // same placeholder copy, but it docks into the nav bar the ambient NavigationStack
        // already provides and keeps focus while rows scroll.
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter ticker or sector")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    ForEach(ScanSortOption.allCases) { option in
                        Button {
                            sortOption = option
                        } label: {
                            Label(option.label, systemImage: sortOption == option ? "checkmark" : "circle")
                        }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
                .accessibilityLabel("Sort Scan")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task { await load(force: true) }
                } label: {
                    if isLoading {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(isLoading)
                .accessibilityLabel("Refresh Scan")
            }
        }
        .sheet(item: $presentedSymbol) { presented in
            SymbolInfoSheet(symbol: presented.symbol)
        }
        .task { await load(force: false) }
        .onChange(of: store.snapshot?.latestScan?.generatedAt ?? store.snapshot?.latestScan?.asOf) { _, _ in
            seedFromSnapshotIfNeeded()
        }
    }

    private var scanSubtitle: String {
        if let delay = scan?.priceDelay, delay.label == "15-min delayed" {
            return "Prices are generally 15-min delayed."
        }
        return scan?.asOf.map { "as of \(AppFormat.dateTime($0))" } ?? "ranked names for this universe"
    }

    private var filtered: [ScanCandidate] {
        let rows = scan?.topCandidates ?? []
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let matched: [ScanCandidate]
        if needle.isEmpty {
            matched = rows
        } else {
            matched = rows.filter {
                $0.symbol.uppercased().contains(needle)
                    || ($0.companyName?.uppercased().contains(needle) ?? false)
                    || ($0.sector?.uppercased().contains(needle) ?? false)
            }
        }
        // Client-side over the rows already loaded; `.ranked` leaves the server's order alone.
        return ScanRowSorter.sort(matched, by: sortOption)
    }

    @ViewBuilder
    private func header(snapshot: MobileSnapshot) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeading(
                    "Market Scan",
                    subtitle: priceAgeNote ?? scanSubtitle
                )
                Text(DeskCopy.scanUniverseNote)
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(
                    DeskCopy.scanCountLine(
                        names: filtered.count,
                        scanned: scan?.scannedSymbols,
                        quotes: scan?.returnedQuotes,
                        watched: snapshot.watchlist.count
                    )
                )
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                if let staleScanNote {
                    Text(staleScanNote)
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(scan?.warnings ?? [], id: \.self) { warning in
                    Text(warning)
                        .font(.appCaption)
                        .foregroundStyle(AppPalette.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func weeklyScreensCard(snapshot: MobileSnapshot) -> some View {
        if let digest = snapshot.weeklyMarketDigest, digest.hasRows {
            AppCard {
                VStack(alignment: .leading, spacing: 8) {
                    SectionHeading("Weekly Screens", subtitle: DeskCopy.weeklyScreensNote)
                    Text(digest.status == "ready" ? "ready" : digest.status.replacingOccurrences(of: "_", with: " "))
                        .font(.appCaption)
                        .foregroundStyle(.secondary)
                    screenLine(title: "Value", names: digest.value, empty: DeskCopy.weeklyScreensValueEmpty) { name in
                        "\(AppFormat.percent(name.pctAbove52wLow)) · pe \(name.peRatio.map { $0.formatted(.number.precision(.fractionLength(0...1))) } ?? "—")"
                    }
                    screenLine(title: "Momentum", names: digest.momentum, empty: DeskCopy.weeklyScreensMomentumEmpty) { name in
                        "\(AppFormat.percent(name.return5d, signed: true)) · rsi \(name.rsi14.map { $0.formatted(.number.precision(.fractionLength(0))) } ?? "—")"
                    }
                    if !digest.overlap.isEmpty {
                        // ST-4687: `overlap` was decoded but never rendered — the names that hit
                        // both weekly screens, one sentence-case line like the web card's.
                        Text(WeeklyScreensCopy.overlapLine(digest.overlap))
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(digest.warnings.prefix(2), id: \.self) { warning in
                        Text(warning)
                            .font(.appCaption)
                            .foregroundStyle(AppPalette.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func screenLine(
        title: String,
        names: [WeeklyDigestName],
        empty: String,
        detail: @escaping (WeeklyDigestName) -> String
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.appSubheadline.weight(.semibold))
            if names.isEmpty {
                Text(empty)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(names.prefix(8)) { name in
                    HStack(spacing: 8) {
                        SymbolTapButton(symbol: name.symbol, logoSize: 18, font: .appSubheadline) {
                            presentedSymbol = PresentedSymbol(symbol: name.symbol)
                        }
                        Text(detail(name).lowercased())
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let error = loadError {
            InlineErrorBanner(
                message: DeskCopy.scanRefreshFailed(from: error),
                retry: { Task { await load(force: true) } },
                dismiss: { loadError = nil }
            )
        }
        if isLoading && scan == nil {
            AppCard {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(DeskCopy.scanLoadingNote)
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                }
            }
        } else if loadError != nil && filtered.isEmpty {
            // Failure banner + header counts/warnings already shown.  Do not
            // render "No Candidates" — that reads as an empty universe when
            // quotes were aborted (prod d0359642: 505 scanned, 0 quotes).
            EmptyView()
        } else if filtered.isEmpty {
            EmptyStateCard(
                title: DeskCopy.scanEmptyTitle(hasFilter: !query.isEmpty),
                message: DeskCopy.scanEmptyMessage(
                    scanned: scan?.scannedSymbols,
                    quotes: scan?.returnedQuotes,
                    hasFilter: !query.isEmpty
                ),
                systemImage: "tablecells"
            )
        } else {
            // No table header: these are cards, not table rows.  Score / price / change
            // stack vertically inside each card, so three fixed-width column headings
            // labelled nothing and sat at a different inset than the values they claimed.
            ForEach(filtered) { candidate in
                ScanRow(
                    candidate: candidate,
                    isWatched: store.snapshot?.watchlist.contains(where: { $0.symbol == candidate.symbol }) == true,
                    presentedSymbol: $presentedSymbol
                )
            }
        }
    }

    private func seedFromSnapshotIfNeeded() {
        guard let latest = store.snapshot?.latestScan, latest.hasUsableUniverse else { return }
        if scan == nil || scan?.hasUsableUniverse != true {
            scan = latest
        }
    }

    private func load(force: Bool) async {
        seedFromSnapshotIfNeeded()
        if !force, didAttemptLiveRefresh { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await store.fetchMarketScan()
            scan = response
            if response.refreshPending == true, let recoveryId = response.recoveryId, !recoveryId.isEmpty {
                priceAgeNote = DeskCopy.scanPriceAgeNote(pricesAsOf: response.pricesAsOf, refreshPending: true)
                staleScanNote = nil
                loadError = nil
                do {
                    let live = try await store.fetchMarketScan(recoveryId: recoveryId)
                    if live.keptSnapshot == true {
                        priceAgeNote = DeskCopy.scanPriceAgeNote(
                            pricesAsOf: response.pricesAsOf ?? live.pricesAsOf,
                            refreshPending: false
                        )
                    } else {
                        scan = live.keepingLastGood(from: response)
                        priceAgeNote = nil
                    }
                } catch {
                    priceAgeNote = DeskCopy.scanPriceAgeNote(pricesAsOf: response.pricesAsOf, refreshPending: false)
                }
                didAttemptLiveRefresh = true
            } else if response.stale == true {
                priceAgeNote = nil
                loadError = nil
                staleScanNote = DeskCopy.scanShowingStaleNote(
                    generatedAt: response.generatedAt ?? response.asOf,
                    staleReason: response.staleReason
                )
            } else {
                priceAgeNote = nil
                staleScanNote = nil
                loadError = nil
            }
            didAttemptLiveRefresh = true
        } catch let error as MobileAPIError {
            priceAgeNote = nil
            staleScanNote = nil
            if case .scanQuotesUnavailable(let failed) = error {
                scan = failed.keepingLastGood(from: scan)
            }
            loadError = DeskCopy.scanRefreshFailedBanner(
                reason: error.localizedDescription,
                lastGoodAt: scan?.lastGoodStamp
            )
            didAttemptLiveRefresh = true
        } catch {
            priceAgeNote = nil
            staleScanNote = nil
            loadError = DeskCopy.scanRefreshFailedBanner(
                reason: error.localizedDescription,
                lastGoodAt: scan?.lastGoodStamp
            )
            didAttemptLiveRefresh = true
        }
    }
}

private struct ScanRow: View {
    @Environment(MobileStore.self) private var store

    let candidate: ScanCandidate
    let isWatched: Bool
    @Binding var presentedSymbol: PresentedSymbol?

    private var watchOperation: String {
        "\(isWatched ? "watchlist.remove" : "watchlist.add"):\(candidate.symbol)"
    }

    private var industryLine: String? {
        let raw = [candidate.industry, candidate.sector]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return raw?.lowercased()
    }

    var body: some View {
        AppCard(padding: 12) {
            HStack(alignment: .top, spacing: 10) {
                Button {
                    presentedSymbol = PresentedSymbol(symbol: candidate.symbol)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                TickerLogo(symbol: candidate.symbol, size: 22)
                                Text(candidate.symbol)
                                    .font(.appHeadline)
                                    .foregroundStyle(Color.primary)
                            }
                            if let companyName = candidate.companyName, !companyName.isEmpty {
                                Text(companyName)
                                    .font(.appCaption.weight(.semibold))
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                            }
                            if let industryLine {
                                Text(industryLine)
                                    .font(.appCaption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                        VStack(alignment: .trailing, spacing: 4) {
                            Text(scoreLabel)
                                .font(.appHeadline)
                                .foregroundStyle(Color.primary)
                            Text(AppFormat.money(candidate.price))
                                .font(.appSubheadline)
                                .foregroundStyle(Color.primary)
                            Text(AppFormat.percent(candidate.intradayChangePct, signed: true))
                                .font(.appCaption)
                                .foregroundStyle(changeColor)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(candidate.symbol) company info")

                Button {
                    toggleWatch()
                } label: {
                    Image(systemName: isWatched ? "star.fill" : "star")
                        .font(.appBody)
                        .foregroundStyle(isWatched ? AppPalette.warning : .secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.isBusy(watchOperation) || !store.canSubmit(isWatched ? "watchlist.remove" : "watchlist.add"))
                .accessibilityLabel(isWatched ? "Remove \(candidate.symbol) from Watchlist" : "Add \(candidate.symbol) to Watchlist")
            }
        }
    }

    private var scoreLabel: String {
        guard let score = candidate.score else { return "—" }
        return score.formatted(.number.precision(.fractionLength(0...1)))
    }

    private var changeColor: Color {
        guard let change = candidate.intradayChangePct else { return .secondary }
        if change > 0 { return AppPalette.positive }
        if change < 0 { return AppPalette.negative }
        return .secondary
    }

    private func toggleWatch() {
        let type = isWatched ? "watchlist.remove" : "watchlist.add"
        Task {
            await store.submit(
                type,
                payload: ["symbol": candidate.symbol],
                operationID: watchOperation
            )
        }
    }
}

// MARK: - Scan sort + weekly copy helpers (ST-4687 / R2l — pure, XCTest-covered)

/// Client-side sort over the rows already loaded.  `.ranked` is the untouched server order —
/// the phone never re-ranks the universe, it only reorders what it was given.
enum ScanSortOption: String, CaseIterable, Identifiable {
    case ranked
    case price
    case symbol

    var id: String { rawValue }

    /// Menu option label — a control label, so Title Case per FLEET-UI-COPY.
    var label: String {
        switch self {
        case .ranked: return "Default"
        case .price: return "Price"
        case .symbol: return "Symbol"
        }
    }
}

enum ScanRowSorter {
    static func sort(_ rows: [ScanCandidate], by option: ScanSortOption) -> [ScanCandidate] {
        switch option {
        case .ranked:
            return rows
        case .price:
            // Highest price first.  A row with no quote sinks to the bottom, and the symbol
            // tie-break makes equal prices deterministic instead of relying on sort stability.
            return rows.sorted { a, b in
                let pa = a.price ?? .leastNonzeroMagnitude
                let pb = b.price ?? .leastNonzeroMagnitude
                if pa != pb { return pa > pb }
                return a.symbol < b.symbol
            }
        case .symbol:
            return rows.sorted { $0.symbol < $1.symbol }
        }
    }
}

enum WeeklyScreensCopy {
    /// One sentence-case line naming the symbols that hit both weekly screens — the iOS
    /// counterpart of the web card's "Overlap:" paragraph
    /// (app/console/components/weekly-digest-card.tsx).
    static func overlapLine(_ symbols: [String]) -> String {
        "Overlap: \(symbols.joined(separator: ", "))"
    }
}
