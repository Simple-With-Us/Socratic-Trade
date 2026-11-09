# 2026-07-09 — Settings auto-save everywhere (MONET)

## Summary

Owner-directed: "changes to delivery channels and all other settings everywhere should
automatically be saved just like they are for the data sharing section unless they require
special confirmation or review." Generalized the Data-sharing card's persist-on-change pattern
into a shared primitive and applied it across the settings surfaces that still used an explicit
Save/Apply button — while leaving the confirmation/review-gated settings exactly as they were.

## The shared foundation (built + verified live by the session lead)

- **`app/console/lib/useAutoSave.tsx`** (new) — `useAutoSave()` returns `{ status, saving, save }`.
  `save(run, opts?)` runs an async persistence call (`() => savePolicy({...}).then(refresh)`)
  SERIALIZED behind any in-flight write (the policy endpoint is read-merge-write; serialized
  writes never race on stale state), tracks a burst-aware status (`idle→saving→saved→idle`, and
  never overwrites a visible error with a sibling field's later success), and on failure calls
  `opts.onError` (field revert) + the standard "Not saved" toast. `opts.successToast` for the rare
  high-signal discrete action.
- **`app/console/ui/save-status.tsx`** (new) — inline `<SaveStatus status=…>` ("Saving… / Saved /
  Couldn't save", aria-live), rendered as each card's `action` in place of the Save/Discard
  buttons. Renders nothing when idle.

## Decisions (session lead; owner delegated "difficult choices")

- **Trigger:** toggles/selects/checkboxes save on change; text/number inputs save on **blur**
  (never per keystroke — RawNumInput updates local state per keystroke, persists on blur).
- **Optimistic + revert:** sticky local overlay for instant feedback; a server 400 reverts just
  that field (mirrors sharing.tsx's write-then-read).
- **Feedback:** one `<SaveStatus>` per card, not a success toast per field (avoids toast-spam on a
  15-field page); errors always toast.
- **Concurrency:** serialized per-card queue (not sharing.tsx's single global `busy`, which would
  block the whole page).
- **Guardrails page stays review-and-commit** — it *is* the "review" the owner carved out (its own
  design philosophy is "you review and commit a change," and loosening on a LIVE account already
  needs a typed CONFIRM). Not converted.

## Converted to auto-save

- `settings/page.tsx`: **Event notifications** (event checkboxes on change; webhook URL on blur),
  **Tax treatment** (account-type/wash-sale/IRA-handling/net-of-tax on change; short/long rates on
  blur), **Market-scan shape** (both numeric fields on blur). (Advanced-action-confirmation, boot
  behavior, and appearance already auto-saved.)
- `settings/delivery.tsx`: **Delivery channels** — each channel toggle on change (with a
  high-signal on/off toast), each target field (email / webhook / phone / push target) on blur with
  validation-revert. "Send test" simplified — no longer persists-first, since channels stay saved.
- `settings/models.tsx`: **Strategist / Reviewer** model selects on change (null-clear preserved;
  no-default invariant untouched). Coach select already localStorage-on-change.
- `strategy/page.tsx`: **Proposer / Reviewer / reasoning-effort** selects on change (reasoning-effort
  renormalization bundled into the model-save PUT, matching the old Save button — prevents a stale
  (model, effort) combo the server would reject); **strategy prompt** on blur; **all 8 scoring
  weights** on blur (one minimal `scoringWeights.<key>` patch each).

## Excluded — unchanged (special confirmation or review)

Guardrails review-and-commit + its live-loosening typed CONFIRM; autonomy → Autopilot typed
confirm; the AI-review Generate/Apply flow + its live typed confirm; preset "Apply to account";
`requireTypedConfirmation` master switch (already one-click, and making the owner confirm to
*reduce* confirmation would invert the philosophy); broker connect/disconnect/activate + Alpaca
key entry; API-key add/replace/remove; account deletion ritual; the learned-context approval queue;
run-state / kill switch.

## Verification

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npm test` + `npm run build` (gate).
- **Driven live** (seeded demo DB) across every control type, each confirmed persisted across a
  full reload: Event-notifications checkbox; Tax account-type select (→ roth_ira); Market-scan
  candidate-limit (→ 48, blur); Delivery push channel toggle (→ on); Strategy scoring weight
  (→ 1.7, blur, the money-path card). Zero "Save" buttons remain on any converted card; excluded
  cards (brokers, API keys, AI review, account deletion) keep their explicit flows.
  (Test note: React delegates `onBlur` via `focusout` — a synthetic `blur` event does not trigger
  it; drive blur-saves with `focusout`.)

## Owner flags (soft calls I made — easy to reverse if you disagree)

1. **Strategy prompt + scoring weights now auto-save on blur.** They have no confirmation gate
   today (just a Save button), and you said "everywhere," so I converted them — but they are the
   trading brain's core inputs. If you'd rather the *prompt* keep an explicit Save, it's a one-line
   revert.
2. **Guardrails left as review-and-commit** (see Decisions). If you want guardrails to auto-save
   too (at least tightening / on paper accounts), say so and I'll extend the pattern there behind
   the existing live-loosening typed confirm.

## Files

`app/console/lib/useAutoSave.tsx` (new), `app/console/ui/save-status.tsx` (new),
`app/console/settings/page.tsx`, `app/console/settings/delivery.tsx`,
`app/console/settings/models.tsx`, `app/console/strategy/page.tsx`, `STATUS.md`,
`docs/EFFORT-LOG.md`, this note.

## Follow-ups

- Pre-existing custom-model-id text-entry quirk on the strategy page (field unmounts after one edit
  because `custom` is derived from the select sentinel) — preserved as-is, out of scope; worth its
  own ticket if custom model ids matter.
