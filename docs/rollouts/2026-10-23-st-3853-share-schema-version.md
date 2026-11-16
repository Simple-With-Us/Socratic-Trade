# 2026-10-23 - ST-3853: share payload schemaVersion comes from the shared contract

## Context & Objective

`congress-trading-shared` v2.9.0 makes the share payload envelope version an optional field on
`SharePayloadSchema` and exports the contract values `SHARE_PAYLOAD_SCHEMA_VERSION` (= 1),
`SHARE_PAYLOAD_LEGACY_SCHEMA_VERSION`, `resolveSharePayloadSchemaVersion` and
`isSupportedSharePayloadSchemaVersion`.  Socratic-Trade (App B, the sender) was stamping a
locally-defined `= 1` constant, so the two repos could drift without either side noticing.  This
change makes the sender use the shared contract value so App A (Congress.Trade) and App B agree on
one number.

## Changes Made

The outbound share sender now stamps the version that the shared package defines, and the old
local constant survives only as a deprecated alias so existing imports keep compiling.

- `src/lib/congress-share.ts`
  - Added `SHARE_PAYLOAD_SCHEMA_VERSION` to the existing `@jaywedgeworth22/congress-trading-shared`
    import block.
  - The POST body on the App A import endpoint now stamps
    `schemaVersion: SHARE_PAYLOAD_SCHEMA_VERSION`.
  - `CONGRESS_SHARE_PAYLOAD_SCHEMA_VERSION` is now a deprecated alias
    (`= SHARE_PAYLOAD_SCHEMA_VERSION`) instead of a local `= 1` literal, with its doc comment
    updated to point at the shared package and at App A's `resolveSharePayloadSchemaVersion`.
- `test/congress-share.test.ts`
  - Added one focused test next to the existing body-shape test, asserting the POST body's
    `schemaVersion` equals the shared `SHARE_PAYLOAD_SCHEMA_VERSION` and that
    `isSupportedSharePayloadSchemaVersion(body)` is true.  It reuses that test's setup pattern
    exactly (token, base URL, fetch stub, `ctImportOkBody` receipt).
- `package.json` / `package-lock.json`
  - The `@jaywedgeworth22/congress-trading-shared` pin moved from v2.8.1 to v2.9.0
    (`github:Simple-With-Us/congress-trading-shared#v2.9.0`, upstream commit `72febd04`).
- `docs/congress-trade-share.md`
  - Added a short note that the sender stamps the shared `SHARE_PAYLOAD_SCHEMA_VERSION` since
    v2.9.0.
- `STATUS.md`
  - Added the ST-3853 line to the current section.

## Decisions & Trade-offs

- **The alias stays exported.**  `CONGRESS_SHARE_PAYLOAD_SCHEMA_VERSION` is marked deprecated but
  is not removed, because `test/congress-share.test.ts` (and any downstream consumer) imports it.
  Removing it would be a breaking change for no gain.
- **No behavior change in the sender.**  The shared constant is also `1`, so the wire value is
  unchanged; this is a contract-plumbing change only.
- **The tolerant reader is untouched.**  The inbound `schemaVersion?: string | number` fields and
  the legacy-tolerant parsing paths are left exactly as they were, so a payload without the field
  still resolves to the legacy version.
- **App A stays tolerant.**  Congress.Trade gets a paired PR that resolves the received version
  with `resolveSharePayloadSchemaVersion` and warns on unsupported versions without rejecting the
  payload, so a version bump cannot break the push.
- **UM is not bumped here.**  Usage-Monitor still pins v2.8.1.

## Verification State

Run on the GB-COMPILER box clone (Linux, Node 22), 2026-10-23:

- `npm run lint` - exit 0 (0 errors, 869 grandfathered warnings).
- `npx tsc --noEmit` - exit 0.
- `npm test` - 9763 passed, 51 skipped, 1 failed.  The one failure is
  `test/egress-guard.test.ts` "uses real DNS by default", which needs real DNS:  the box
  resolver answers `discord.com` with `198.18.0.1` (a benchmark-range proxy address), so the
  SSRF guard correctly refuses it.  It fails the same way with this change reverted and is
  unrelated to the share code.  `test/congress-share.test.ts` passes in full, including the new
  test.
- `npm run build` - exit 0.

## Next Steps & Blockers

- **Usage-Monitor still pins v2.8.1.**  The soft three-repo pin check
  (`scripts/check-shared-package-pin.mjs`, the ST / UM / CT triangle) will keep flagging a
  mismatch until UM is bumped to v2.9.0.  That check is intentionally advisory, not a required
  merge check, so it does not block this PR.
- Congress.Trade needs its paired PR (resolve the version, warn on unsupported versions, do not
  reject) for the contract to be closed on the receiving side.

## Zero-Code Findings

- The shared package ships a compiled `dist/` only (no `src/` in the installed artifact); the new
  exports are present in `dist/index.js` and typed in `dist/index.d.ts`, and
  `SHARE_PAYLOAD_SCHEMA_VERSION` is declared with the literal type `1`, so the deprecated alias
  keeps its previous literal type.
- `resolveSharePayloadSchemaVersion` falls back to `SHARE_PAYLOAD_LEGACY_SCHEMA_VERSION` when the
  field is absent, and `isSupportedSharePayloadSchemaVersion` accepts anything in
  `[SHARE_PAYLOAD_LEGACY_SCHEMA_VERSION, SHARE_PAYLOAD_SCHEMA_VERSION]` — both are currently `1`,
  so only the currently supported version passes.
