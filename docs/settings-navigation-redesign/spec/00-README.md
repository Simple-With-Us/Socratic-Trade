# Implementation Spec — index, reading order & editor's resolutions

This folder is the **implementation-ready spec** for the settings & navigation redesign. It fleshes out
the canonical design in [`../../settings-navigation-redesign.md`](../../settings-navigation-redesign.md) (v2)
into buildable detail: every screen, every field, the data model, the API changes, the front-end
decomposition, the PR-by-PR delivery plan, copy, onboarding, and accessibility.

**Status:** owner-approved direction (2026-07-01); all 7 open questions resolved (see below). This is the
build reference; code follows PR #1 of `08-delivery-plan`. Produced by a 16-agent workflow, then
consistency-checked by an editor pass ([`00-reconciliation-report.md`](./00-reconciliation-report.md)).

## Reading order

Read the canonical `../../settings-navigation-redesign.md` (v2) first, then:

| Order | File | Layer | What it defines |
|------:|------|-------|-----------------|
| 1 | [`05-scoping-and-safety-model.md`](./05-scoping-and-safety-model.md) | substrate | Three entities, three-tier resolution, view/execution decouple, scheduler fan-out, autonomy-reset |
| 2 | [`06-data-model-and-api-changes.md`](./06-data-model-and-api-changes.md) | substrate | Migrations, arming columns, coercion removal, wash-sale provenance return type, mobile setter re-point |
| 3 | [`07-frontend-architecture-and-decomposition.md`](./07-frontend-architecture-and-decomposition.md) | substrate | How the 7,015-line `dashboard-client.tsx` is strangler-figged into a `(shell)` route group |
| 4 | [`01-global-frame.md`](./01-global-frame.md) | surface | The persistent three-zone chrome: switcher, badges, Run-once, STOP, `ShellScope`, autonomy-reset chrome |
| 5 | [`02-destinations-dashboard-approvals-scan.md`](./02-destinations-dashboard-approvals-scan.md) | surface | Dashboard (+Fleet), Approvals (HITL queue), Scan |
| 6 | [`03-destinations-strategy-guardrails-results-assistant.md`](./03-destinations-strategy-guardrails-results-assistant.md) | surface | Strategy (one home), Guardrails (Essentials+Advanced), Results, Assistant overlay |
| 7 | [`04-settings-field-reference.md`](./04-settings-field-reference.md) | surface | The exhaustive per-field catalog (every field → new home, scope, control, default, friction) |
| 8 | [`09-copy-deck.md`](./09-copy-deck.md) | copy | Every user-facing string + confirm-phrase constants (single source of truth) |
| 9 | [`10-onboarding-modes-and-first-run.md`](./10-onboarding-modes-and-first-run.md) | flow | Zero-account flow, Test auto-provision, Test→Paper→Live + Propose→Decide rituals, mobile parity |
| 10 | [`11-accessibility-responsive-mobile.md`](./11-accessibility-responsive-mobile.md) | a11y | Keyboard/focus, non-color safety cues, Live-red viewport, responsive collapse, Appearance settings |
| 11 | [`08-delivery-plan-prs-and-tests.md`](./08-delivery-plan-prs-and-tests.md) | order | The execution spine: ordered PR#1–#14, the P2 firewall gate, do-not-break checklist, per-PR tests |

Grounding references (authoritative code facts extracted this session) live in
[`grounding/`](./grounding/): the full policy-field catalog, dashboard-client structure, API/schema
inventory, and onboarding/mobile surface.

**One-line rule:** `05/06/07` = substrate · `01–04` = surfaces · `09/10/11` = copy/flows/a11y · `08` = the order you build them in.

## Owner decisions log (2026-07-01) — the 7 open questions, resolved

1. **Market-scan breadth (`marketScanCandidateLimit`/`marketScanOutlierReserve`)** → stays **user-global** (relabel "applies to all your accounts"); the user funds the shared keys/data feeding scans.
2. **Autonomy-reset-on-restart** → **required, default ON.** On restart, every account's autonomy drops to its safe floor (Propose-only) until re-armed. *(See R2 — a boot primitive already exists; net-new work is scoped there.)*
3. **Fleet emergency STOP scope** → **Live + Paper; Test excluded** (Live listed first, per-account confirmed-halted echo).
4. **Route-encoding** → adopt the thin `/a/:accountId` seed param; **server-side write-time `accountId` validation is the real safety boundary.**
5. **Vocabulary** → adopt in full: Dashboard · Approvals · Scan · Strategy · Guardrails · Results; **Preset** (was Strategy Profile), **Results** (was Review), **Alerts** family (was Notifications).
6. **Mobile/PWA** → full account-scope parity **specified now**, implemented later (switcher + STOP + scoped context survive on phone).
7. **Single-account stale id** → **auto-resolves to the sole account** (don't fail closed); multi-account keeps fail-closed.

## Editor's resolutions (decisive calls on the open items the reconciliation pass flagged)

These close the remaining conflicts/gaps in `00-reconciliation-report.md`. They are authoritative; the
individual section files are correct except where noted here.

- **R1 — "Max position size" Essentials control (Gap #4/C4).** The Guardrails Essentials control is **"Max order size" wired to `maxOrderNotional`** (a single-order cap; the field exists and is enforced). A true per-symbol *position* cap remains the separate **Exposure → per-symbol cap %** control. The Essentials label is **"Max order size"** and its consequence-preview copy is order-level ("this caps any single order at $X"). `04` is authoritative; `03`'s copy must match.
- **R2 — Autonomy-reset wording (C1).** The boot-reconcile **primitive already exists** (`reconcileAutonomyOnBoot()`, `scheduler.ts:66-97`), currently a **per-user** `autoResumeOnBoot` flag that defaults to reset and iterates every account. The net-new work is: (i) make reset **default-ON and not accidentally overridable**, (ii) migrate the opt-in from **per-user → per-account**, (iii) add `armed_boot_epoch` (`06` migration v9) as the anchor, (iv) surface post-reset state in chrome (`01`). The global `AUTONOMY_RESUME_ON_BOOT` env override is **deprecated** in favor of per-account opt-in. Do **not** duplicate `scheduler.ts` logic — extend it. `06`=schema, `05`=fan-out, `01`=chrome.
- **R3 — Wash-sale anchors & functions (C3/Gap #8).** Correct anchors: inner **`getWashSaleLockedSymbolsForUser` (`tax.ts:104`)** and wrapper **`getUserWashSaleLockedSymbols` (`tax.ts:115`)**; the Test→"paper" leak is in the **wrapper at `tax.ts:117`**. Both currently return `Set<string>`. The provenance return-type change threads through **both** functions; the **Test filter lives at the wrapper (`:117`)**; make the new type **break `.has()` at `policy.ts:321` at compile time**. Consumers to update: `policy.ts:321`, `strategy.ts:219`, `strategy.ts:1552`. The design doc's `tax.ts:99` anchor is stale.
- **R4 — Fleet STOP (C8/Open Q3).** **Live + Paper halted, Test excluded**, Live listed first, per-account confirmed-halted echo. Open Q3 is closed; the "all-Paper multi-account" worry is resolved (two Papers → both halt; auto-resolve is single-account only).
- **R5 — Admin route disposition (Gap #1).** Keep `app/admin/{connections,llm-usage,rag-coverage,transcript}` as **deep-link targets rendered inside the shell** (role-gated). **Settings → Admin** is the consolidated entry point that links to them. **No route deletion** — lowest-risk; the routes already exist and work.
- **R6 — `/strategy` → `/how-it-works` (Gap #2).** Rename the route; add a redirect from the old path; **both are gated by `LANDING_PAGE_ENABLED`** (when disabled, both 404, preserving today's behavior).
- **R7 — Strategy Studio modal fate (Gap #6).** Contents move inline into the Strategy destination; the modal container JSX is **flag-retained (dead-but-flagged) for one release** for rollback (same pattern as the TuningCard merge), then removed in a follow-up cleanup PR.
- **R8 — localStorage shim trigger (Gap #10).** The one-time tab-key migration shim runs **flag-independently, once, idempotently**, and keeps a **one-release read-fallback** to the old keys. It is **not** gated by `NAV_V2`, so flag-off users are never stranded.

## Tracked refinements (finalize during their owning PR — not blockers)

From `00-reconciliation-report.md` §3, these are implementation details to nail during the relevant PR,
not design decisions: complete the `ShellScope` response schema (`01`); define the SSE `alert` event
contract (`01`); write the `down()`/rollback bodies for migrations v9–v11 (`06`, guarded by
`PRAGMA table_info`, documenting SQLite column-drop irreversibility); land the `Modal` focus-trap fix
(`app/ui/overlays.tsx`) as a prerequisite PR before switcher/STOP-in-overlay; specify `density` design
tokens and `prefers-contrast`/`forced-colors` handling (`11`). Each is called out in its section.
