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
                        Text("Loading data sources…")
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
                                if row.type == "number" {
                                    SourceSettingNumberRow(
                                        row: row,
                                        isBusy: pendingIDs.contains(row.id)
                                    ) { value in
                                        Task { await patchNumber(id: row.id, value: value) }
                                    }
                                } else {
                                    SourceSettingToggleRow(
                                        row: row,
                                        isBusy: pendingIDs.contains(row.id)
                                    ) { value in
                                        Task { await patch(id: row.id, value: value) }
                                    }
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
                    Toggle("Show Advanced Options", isOn: $showAdvanced)
                } footer: {
                    Text("Advanced rows stay hidden until you turn this on.  These settings only change which data your account uses.")
                }
            }
        }
        .task { await load() }
    }

    private var visibleSettings: [SourceSettingRow] {
        let rows = response?.settings ?? []
        let supported = rows.filter { $0.type == "boolean" || $0.type == "number" }
        return showAdvanced ? supported : supported.filter { !$0.advanced }
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

    private func patchNumber(id: String, value: Double) async {
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

private struct SourceSettingNumberRow: View {
    let row: SourceSettingRow
    let isBusy: Bool
    let onChange: (Double) -> Void
    @State private var text: String
    @FocusState private var isFocused: Bool

    init(row: SourceSettingRow, isBusy: Bool, onChange: @escaping (Double) -> Void) {
        self.row = row
        self.isBusy = isBusy
        self.onChange = onChange
        _text = State(initialValue: NumberFieldEditor.display(row.value.numberValue))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent(row.label) {
                TextField("value", text: $text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .disabled(isBusy)
                    .focused($isFocused)
                    // `.onSubmit` was the ONLY save path, and `.decimalPad` has no Return
                    // key, so it could never fire from the on-screen keyboard — every typed
                    // number was discarded on tap-away with no PATCH and no message.  Blur
                    // is the real commit point now.  `.onSubmit` stays for the hardware
                    // keyboard and Catalyst, where Return genuinely does submit.
                    .onSubmit { commit() }
                    .onChange(of: isFocused) { _, focused in
                        if !focused { commit() }
                    }
            }
            if let description = row.description, !description.isEmpty {
                Text(description)
                    .font(.appCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        // `init` seeds `text` once, and this row is reused across refreshes because the
        // ForEach keys on `row.id` — so @State survives and the initialiser does NOT run
        // again.  Without this the field kept showing a stale local edit after the server
        // value moved or a PATCH was rejected.  Guarded on focus so an in-flight refresh
        // cannot overwrite what the owner is in the middle of typing.
        .onChange(of: row.value) { _, value in
            guard !isFocused else { return }
            text = NumberFieldEditor.display(value.numberValue)
        }
    }

    private func commit() {
        switch NumberFieldEditor.decide(
            text: text,
            serverValue: row.value.numberValue,
            allowsEmpty: false
        ) {
        case .patch(.some(let value)):
            onChange(value)
        case .patch(.none), .unchanged, .revert:
            // Nothing to send.  Re-render from the stored value either way, so a rejected
            // entry visibly snaps back to what is actually saved instead of sitting there
            // looking accepted, and "5.0" normalises to "5".
            text = NumberFieldEditor.display(row.value.numberValue)
        }
    }
}
