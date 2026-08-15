import SwiftUI

/// Settings knobs already exposed by GET/PATCH `/api/settings/source-features`.
struct DataSourcesSection: View {
    @EnvironmentObject private var store: MobileStore

    @State private var response: SourceFeaturesResponse?
    @State private var isLoading = false
    @State private var pendingIDs: Set<String> = []
    @State private var loadError: String?
    @State private var showAdvanced = false

    var body: some View {
        Group {
            if isLoading && response == nil {
                Section("Data Sources") {
                    HStack {
                        ProgressView()
                        Text("loading knobs the server already exposes")
                            .foregroundStyle(.secondary)
                    }
                }
            } else if let loadError, response == nil {
                Section("Data Sources") {
                    Text(loadError)
                        .foregroundStyle(AppPalette.negative)
                    Button("Retry") { Task { await load() } }
                }
            } else if let response {
                ForEach(SourceSettingGroupOrder.sortedKeys(from: visibleSettings), id: \.self) { group in
                    let rows = visibleSettings.filter { $0.group == group }
                    if !rows.isEmpty {
                        Section {
                            ForEach(rows) { row in
                                SourceSettingToggleRow(
                                    row: row,
                                    isBusy: pendingIDs.contains(row.id)
                                ) { value in
                                    Task { await patch(id: row.id, value: value) }
                                }
                            }
                        } header: {
                            Text(SourceSettingGroupOrder.title(for: group, catalog: response.groups))
                        } footer: {
                            footer(for: group, in: response)
                        }
                    }
                }
                Section {
                    Toggle("Show Advanced Knobs", isOn: $showAdvanced)
                } footer: {
                    Text("Advanced knobs are operator-facing.  Secrets stay in Infisical; these only change what the desk pulls.")
                }
            }
        }
        .task { await load() }
    }

    private var visibleSettings: [SourceSettingRow] {
        let rows = response?.settings ?? []
        let booleans = rows.filter { $0.type == "boolean" }
        return showAdvanced ? booleans : booleans.filter { !$0.advanced }
    }

    @ViewBuilder
    private func footer(for group: String, in response: SourceFeaturesResponse) -> some View {
        let blurb = response.groups[group]?.blurb
        if let blurb, !blurb.isEmpty {
            Text(blurb)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            response = try await store.fetchSourceFeatures()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func patch(id: String, value: Bool) async {
        pendingIDs.insert(id)
        defer { pendingIDs.remove(id) }
        do {
            response = try await store.patchSourceFeatures([id: value])
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct SourceSettingToggleRow: View {
    let row: SourceSettingRow
    let isBusy: Bool
    let onChange: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: Binding(
                get: { row.value.boolValue },
                set: { onChange($0) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.label)
                    if let source = row.source, !source.isEmpty {
                        Text(source.lowercased())
                            .font(.appCaption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .disabled(isBusy)
            if let description = row.description, !description.isEmpty {
                Text(description)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let caveat = row.caveat, !caveat.isEmpty {
                Text(caveat)
                    .font(.appCaption2)
                    .foregroundStyle(AppPalette.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }
}
