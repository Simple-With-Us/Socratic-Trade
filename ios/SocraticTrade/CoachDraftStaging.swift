import Foundation
import SwiftUI

/// ST-4687: bridge a Coach `ChatDraft` into the approval queue from iOS — the same
/// POST `/api/proposals/from-draft` the web assistant draft card uses
/// (app/console/assistant/draft-card.tsx).  The route itself stays authoritative: it re-runs the
/// full policy gate here and again at approval.  This file only (a) re-serializes the decoded
/// draft back into the snake_case shape `chatDraftToProposal` (src/lib/chat/promote-draft.ts)
/// parses, and (b) owns the Stage button so CoachView.swift keeps its diff to one line.

// MARK: - Pure serialization (pinned by CoachDraftStagingTests)

enum CoachDraftStaging {
    /// The `draft` field of the POST body, in the server's ChatDraft wire shape
    /// (src/lib/chat/types.ts).  Optional Swift fields fall back to the same defaults the
    /// server's own chat builder emits; `executed` is structurally always false — a phone
    /// draft has never traded.
    static func wirePayload(from draft: ChatDraft) -> [String: Any] {
        let limitUsd: Any = draft.limitUsd.map { $0 as NSNumber } ?? NSNull()
        return [
            "draft_id": draft.draftId,
            "symbol": draft.symbol,
            "side": draft.side,
            "qty": draft.quantity ?? 0,
            "order_type": draft.orderType ?? "market",
            "limit_usd": limitUsd,
            "rationale": draft.rationale ?? "",
            "account_label": draft.accountLabel ?? "",
            "is_real": draft.isReal ?? false,
            "blocked": draft.blocked ?? false,
            "warnings": draft.warnings,
            "executed": false
        ]
    }

    /// Maps the route's machine error codes to ordinary sentence-case copy.  The client's
    /// `serverMessage` surfaces the `error` field of the JSON body as `MobileAPIError.serverError`'s
    /// message, so the switch keys off those codes; anything unrecognized falls through to the
    /// localized description, which already carries the raw code.
    static func userFacingMessage(for error: Error) -> String {
        guard let apiError = error as? MobileAPIError,
              case .serverError(_, let message) = apiError,
              let code = message?.trimmingCharacters(in: .whitespacesAndNewlines),
              !code.isEmpty else {
            return error.localizedDescription
        }
        switch code {
        case "INVALID_SYMBOL":
            return "The draft has no usable ticker.\u{00A0} Ask Coach to name a symbol, then stage again."
        case "INVALID_QTY":
            return "The draft has no share quantity, so it cannot be staged."
        case "LIMIT_PRICE_REQUIRED":
            return "This limit draft is missing its limit price, so it cannot be staged."
        case "NO_ACCOUNT":
            return "Connect an account before staging a proposal."
        case "HALTED":
            return "Autonomy is stopped, so nothing was staged.\u{00A0} Start it from Home and try again."
        case "SYMBOL_NOT_ALLOWED":
            return "Your policy universe does not allow this symbol, so nothing was staged."
        case "ACCOUNT_FETCH_FAILED":
            return "The account could not be read.\u{00A0} Try staging again."
        case "POLICY_BLOCKED":
            return "Policy blocked this draft, so nothing was staged."
        default:
            if code.hasPrefix("UNSUPPORTED_SIDE") {
                return "Only buys and sells can be staged from a draft."
            }
            return error.localizedDescription
        }
    }
}

// MARK: - Stage button (used by CoachDraftCard)

struct CoachDraftStageButton: View {
    @Environment(MobileStore.self) private var store

    let draft: ChatDraft

    @State private var isStaging = false
    @State private var staged = false
    @State private var stageError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if staged {
                Label("Staged.\u{00A0} It waits in Proposals for approval.", systemImage: "checkmark.circle.fill")
                    .font(.appCaption)
                    .foregroundStyle(AppPalette.positive)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Button {
                    stage()
                } label: {
                    HStack(spacing: 7) {
                        if isStaging {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "tray.and.arrow.down")
                        }
                        Text("Stage as Proposal")
                            .fontWeight(.semibold)
                    }
                    .frame(minHeight: 44)
                }
                .buttonStyle(.bordered)
                .disabled(isStaging)
            }
            if let stageError {
                Text(stageError)
                    .font(.appCaption)
                    .foregroundStyle(AppPalette.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func stage() {
        guard !isStaging else { return }
        isStaging = true
        stageError = nil
        Task { @MainActor in
            do {
                let proposalId = try await store.stageDraftAsProposal(draft)
                if let proposalId, !proposalId.isEmpty {
                    staged = true
                    // The proposals badge should reflect the new row without waiting for SSE.
                    await store.load()
                } else {
                    stageError = "The draft was accepted without a proposal id.\u{00A0} It may already be staged."
                }
            } catch {
                stageError = CoachDraftStaging.userFacingMessage(for: error)
            }
            isStaging = false
        }
    }
}
