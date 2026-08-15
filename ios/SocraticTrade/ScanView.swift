import SwiftUI

/// Interactive market scan table — GET `/api/scan`, same refresh the console Scan tab uses.
struct ScanView: View {
    @EnvironmentObject private var store: MobileStore

    @State private var scan: MarketScanResponse?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var query = ""
    @State private var presentedSymbol: PresentedSymbol?

    var body: some View {
        SnapshotScaffold { snapshot in
            header(snapshot: snapshot)
            filterField
            content
        }
        .navigationTitle("Scan")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
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
    }

    private var filtered: [ScanCandidate] {
        let rows = scan?.topCandidates ?? []
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !needle.isEmpty else { return rows }
        return rows.filter {
            $0.symbol.uppercased().contains(needle)
                || ($0.companyName?.uppercased().contains(needle) ?? false)
                || ($0.sector?.uppercased().contains(needle) ?? false)
        }
    }

    @ViewBuilder
    private func header(snapshot: MobileSnapshot) -> some View {
        AppCard {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeading(
                    "Market Scan",
                    subtitle: scan?.asOf.map { "as of \(AppFormat.dateTime($0))" } ?? "same interactive scan as the web desk"
                )
                Text("Ranked candidates for the current universe.  Watchlist add/remove uses the audited mobile command.  Nothing here places an order.")
                    .font(.appSubheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(filtered.count) names · \(snapshot.watchlist.count) watched")
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var filterField: some View {
        AppCard(padding: 12) {
            TextField("Filter ticker or sector", text: $query)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
        }
    }

    @ViewBuilder
    private var content: some View {
        if let error = loadError {
            InlineErrorBanner(
                message: error,
                retry: { Task { await load(force: true) } },
                dismiss: { loadError = nil }
            )
        }
        if isLoading && scan == nil {
            AppCard {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Refreshing the scan — this can take up to 20 seconds.")
                        .font(.appSubheadline)
                        .foregroundStyle(.secondary)
                }
            }
        } else if filtered.isEmpty {
            EmptyStateCard(
                title: query.isEmpty ? "No Candidates" : "No Matching Names",
                message: query.isEmpty
                    ? "The scan returned no ranked names.  Confirm the universe on Guardrails, then refresh."
                    : "Nothing in this scan matches that filter.",
                systemImage: "tablecells"
            )
        } else {
            ScanTableHeader()
            ForEach(filtered) { candidate in
                ScanRow(
                    candidate: candidate,
                    isWatched: store.snapshot?.watchlist.contains(where: { $0.symbol == candidate.symbol }) == true,
                    presentedSymbol: $presentedSymbol
                )
            }
        }
    }

    private func load(force: Bool) async {
        if !force, scan != nil { return }
        isLoading = true
        defer { isLoading = false }
        do {
            scan = try await store.fetchMarketScan()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct ScanTableHeader: View {
    var body: some View {
        HStack {
            Text("Name")
            Spacer()
            Text("Score")
                .frame(width: 52, alignment: .trailing)
            Text("Px")
                .frame(width: 64, alignment: .trailing)
            Text("Chg")
                .frame(width: 56, alignment: .trailing)
        }
        .font(.appCaption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .accessibilityHidden(true)
    }
}

private struct ScanRow: View {
    @EnvironmentObject private var store: MobileStore

    let candidate: ScanCandidate
    let isWatched: Bool
    @Binding var presentedSymbol: PresentedSymbol?

    private var watchOperation: String {
        "\(isWatched ? "watchlist.remove" : "watchlist.add"):\(candidate.symbol)"
    }

    var body: some View {
        AppCard(padding: 12) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        SymbolTapButton(symbol: candidate.symbol, logoSize: 22, font: .appHeadline) {
                            presentedSymbol = PresentedSymbol(symbol: candidate.symbol)
                        }
                        Button {
                            toggleWatch()
                        } label: {
                            Image(systemName: isWatched ? "star.fill" : "star")
                                .foregroundStyle(isWatched ? AppPalette.warning : .secondary)
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .disabled(store.isBusy(watchOperation) || !store.canSubmit(isWatched ? "watchlist.remove" : "watchlist.add"))
                        .accessibilityLabel(isWatched ? "Remove \(candidate.symbol) from Watchlist" : "Add \(candidate.symbol) to Watchlist")
                    }
                    if let companyName = candidate.companyName, !companyName.isEmpty {
                        Text(companyName)
                            .font(.appCaption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let sector = candidate.sector, !sector.isEmpty {
                        Text(sector.lowercased())
                            .font(.appCaption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(scoreLabel)
                        .font(.appHeadline)
                    Text(AppFormat.money(candidate.price))
                        .font(.appSubheadline)
                    Text(AppFormat.percent(candidate.intradayChangePct, signed: true))
                        .font(.appCaption)
                        .foregroundStyle(changeColor)
                }
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
