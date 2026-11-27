import XCTest
@testable import SocraticTrade

/// ST-4687 (P11b): the Coach Stage button POSTs the draft back to
/// `app/api/proposals/from-draft/route.ts`, which parses `chatDraftToProposal`
/// (src/lib/chat/promote-draft.ts) against the snake_case ChatDraft interface
/// (src/lib/chat/types.ts).  `ChatDraft` here is Decodable-only, so the test builds one from
/// the same JSON shape the server sends, re-serializes it, and pins the wire keys.  Pure — no
/// network, no view, no clock.
final class CoachDraftStagingTests: XCTestCase {
    private func decodedDraft(json: String) throws -> ChatDraft {
        try JSONDecoder().decode(ChatDraft.self, from: Data(json.utf8))
    }

    private var sampleDraftJSON: String {
        """
        {
          "draft_id": "d-42",
          "symbol": "AAPL",
          "side": "buy",
          "qty": 25,
          "order_type": "limit",
          "limit_usd": 211.55,
          "rationale": "Reclaim of the 20d average.",
          "account_label": "Alpaca (paper)",
          "is_real": false,
          "blocked": false,
          "warnings": ["thin book"],
          "executed": false
        }
        """
    }

    func testWirePayloadPinsTheServerKeys() throws {
        let draft = try decodedDraft(json: sampleDraftJSON)
        let payload = CoachDraftStaging.wirePayload(from: draft)

        XCTAssertEqual(Set(payload.keys), Set([
            "draft_id", "symbol", "side", "qty", "order_type", "limit_usd",
            "rationale", "account_label", "is_real", "blocked", "warnings", "executed"
        ]))
        XCTAssertEqual(payload["draft_id"] as? String, "d-42")
        XCTAssertEqual(payload["symbol"] as? String, "AAPL")
        XCTAssertEqual(payload["side"] as? String, "buy")
        XCTAssertEqual(payload["qty"] as? Double, 25)
        XCTAssertEqual(payload["order_type"] as? String, "limit")
        XCTAssertEqual(payload["limit_usd"] as? Double, 211.55)
        XCTAssertEqual(payload["rationale"] as? String, "Reclaim of the 20d average.")
        XCTAssertEqual(payload["account_label"] as? String, "Alpaca (paper)")
        XCTAssertEqual(payload["is_real"] as? Bool, false)
        XCTAssertEqual(payload["blocked"] as? Bool, false)
        XCTAssertEqual(payload["warnings"] as? [String], ["thin book"])
        XCTAssertEqual(payload["executed"] as? Bool, false)
    }

    func testOptionalFieldsGetTheServerDefaultsNotNulls() throws {
        // A draft with only the required keys must still serialize: the server's mapper reads
        // qty / order_type / rationale / warnings, and a missing limit_usd on a market order
        // stays NSNull — JSONSerialization would reject a raw nil and the route treats a
        // missing limit on a MARKET draft as fine, so NSNull mirrors the web card's body.
        let draft = try decodedDraft(json: #"{"draft_id":"d-7","symbol":"MSFT","side":"sell"}"#)
        let payload = CoachDraftStaging.wirePayload(from: draft)
        XCTAssertEqual(payload["qty"] as? Double, 0)
        XCTAssertEqual(payload["order_type"] as? String, "market")
        XCTAssertEqual(payload["rationale"] as? String, "")
        XCTAssertEqual(payload["account_label"] as? String, "")
        XCTAssertEqual(payload["warnings"] as? [String], [])
        XCTAssertTrue(payload["limit_usd"] is NSNull)
    }

    func testSerializedPayloadIsJSONSerializable() throws {
        let draft = try decodedDraft(json: sampleDraftJSON)
        let payload = CoachDraftStaging.wirePayload(from: draft)
        // JSONSerialization refuses Swift Optional values; the helper must hand it NSNumber /
        // NSString / NSNull only.
        let data = try JSONSerialization.data(withJSONObject: ["draft": payload, "dryRun": false])
        let roundTrip = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let draftBack = roundTrip?["draft"] as? [String: Any]
        XCTAssertEqual(draftBack?["draft_id"] as? String, "d-42")
        XCTAssertEqual(draftBack?["limit_usd"] as? Double, 211.55)
        XCTAssertEqual(draftBack?["executed"] as? Bool, false)
    }

    // MARK: - Server error codes → ordinary copy

    private func serverError(_ message: String) -> Error {
        MobileAPIError.serverError(statusCode: 409, message: message)
    }

    func testKnownErrorCodesGetHumanCopy() {
        XCTAssertTrue(CoachDraftStaging.userFacingMessage(for: serverError("HALTED")).contains("stopped"))
        XCTAssertTrue(CoachDraftStaging.userFacingMessage(for: serverError("NO_ACCOUNT")).contains("account"))
        XCTAssertTrue(CoachDraftStaging.userFacingMessage(for: serverError("INVALID_QTY")).contains("quantity"))
        XCTAssertTrue(
            CoachDraftStaging.userFacingMessage(for: serverError("UNSUPPORTED_SIDE:short"))
                .contains("buys and sells")
        )
        // The codes must never leak into the UI string verbatim.
        for code in ["HALTED", "NO_ACCOUNT", "INVALID_QTY", "INVALID_SYMBOL", "SYMBOL_NOT_ALLOWED", "POLICY_BLOCKED"] {
            XCTAssertFalse(CoachDraftStaging.userFacingMessage(for: serverError(code)).contains(code))
        }
    }

    func testUnknownErrorsFallThroughToTheLocalizedDescription() {
        let message = CoachDraftStaging.userFacingMessage(for: serverError("SOMETHING_NEW"))
        // MobileAPIError.serverError's errorDescription carries the raw message when it is not a
        // known code — the fallback must surface it rather than claim success.
        XCTAssertTrue(message.contains("SOMETHING_NEW"))
    }
}
