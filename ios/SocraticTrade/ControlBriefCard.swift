import SwiftUI

/// One-glance summary from the server's `mobileBrief`.  Not yet placed in a screen: the
/// old Control list this was written for is now the tab shell in MobileControlView.
struct ControlBriefCard: View {
    let brief: MobileBrief

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(brief.headline).font(.headline)
            Text(brief.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 8) {
                ForEach(brief.items) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.label).font(.caption).foregroundStyle(.secondary)
                        Text(item.value).font(.subheadline.bold()).foregroundStyle(Self.color(for: item.tone))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
                }
            }
            ForEach(brief.nextActions, id: \.self) { action in
                Label(action, systemImage: "arrow.right.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    static func color(for tone: String?) -> Color {
        switch tone {
        case "danger": return .red
        case "warn": return .orange
        case "ok": return .green
        default: return .primary
        }
    }
}
