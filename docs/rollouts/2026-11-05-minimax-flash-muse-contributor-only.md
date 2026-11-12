# Catalog Correction: MiniMax M3.1 Flash Only, Muse Contributor Models Only (2026-11-05, ST-4589)

## 1. Context And Objective

The catalog refresh in #4999 (`docs/rollouts/2026-11-04-model-classes-rotation-catalog-refresh.md`) offered more models than the owner asked for.  The owner's correction: "no I don't want minimax-m3 and for muse I said only the 3 contributor models".  #4999 merged before the correction could be added to it, so this is a separate change.

## 2. Changes Made

- **MiniMax:** `minimax-m3` leaves the offered catalog.  `minimax-m3.1-flash` is the only MiniMax row.
- **Muse:** the offered rows are exactly `muse-spark-1.3-contributor`, `muse-wonder-1.0-contributor` and `muse-wonder-full-1.0-contributor`.  `muse-spark-1.3`, `muse-glimmer-30b` and `muse-wonder-1.0` leave the offered catalog.
- **Retired, not deleted.**  The four removed rows move to `RETIRED_LLM_MODEL_CATALOG`, the same way `gpt-5.6-sol` did: a seat's stored model keeps resolving to the same wire slug, route, price and effort handling.  They are out of the picker groups, the default rotation pool, implicit failover chains, stats seeding and recommendation chips.  Nothing is migrated.
- **Cost exclusions.**  `muse-wonder-1.0` is no longer an offered row, so it is no longer a cost-excluded, tickable rotation model.  Only Opus and Fable remain cost-excluded and tickable.  This supersedes the Rotation Selection paragraph of the 2026-11-04 note, which names Wonder.
- **Stored rotation ticks.**  A stored tick of a row that is no longer offered stays visible in the Rotation Models checklist under "No Longer Offered", where it can be unticked.  Rotation ignores it.
- **Budget downgrades.**  `minimax-m3` downgrades to `minimax-m3.1-flash`.  The three retired non-contributor Muse rows have no automatic downgrade.  An automatic downgrade never lands on a contributor row (a tier whose terms let Meta train on prompts and completions) unless the source model is itself a contributor row; a test enforces that across the whole map, along with "every downgrade target is an offered, strictly cheaper row".
- The picker offers 22 models.

Files touched:

- `src/lib/llm-model-catalog.ts`
- `src/lib/usage-budget.ts`
- `app/console/strategy/rotation-models.tsx`
- `app/api/keys/route.ts`
- `docs/manager-model-options.md`, `docs/llm/code-cli-broker.md`
- `test/llm-model-catalog.test.ts`, `test/model-rotation.test.ts`, `test/rotation-models-select-all.test.ts`, `test/rotation-models-stale-ticks.test.tsx` (new), `test/usage-budget.test.ts`
- `STATUS.md`, this note

## 3. Decisions And Trade-Offs

- The owner's message is read as "drop M3", so `minimax-m3.1-flash` stays.
- Retiring instead of deleting keeps any account that already selected one of the four rows running exactly what it selected.
- A first version of this change pointed the retired Muse rows' budget downgrade at `muse-spark-1.3-contributor`.  Review caught that an over-budget seat would be moved silently onto a train-on-your-prompts tier, so those arrows were removed.
- The 2026-11-04 rollout note and its `STATUS.md` entry are left as they merged; this note and a new `STATUS.md` entry carry the correction.
- The owner confirmed on 2026-11-05 that the Muse contributor models are working for them.  The 2026-11-04 note says no running Code CLI broker was found and that the Wonder contributor ids could not complete a call; that came from a search of this server only and was wrong about availability.  Where the broker runs and what its request contract accepts were not verified.

## 4. Verification State

```bash
npx vitest run <affected files>
npx tsc --noEmit
npx eslint <changed files>
```

Targeted suites pass and `npx tsc --noEmit` is clean.  The full `npm test` and `npm run build` ran on the parent change (#4999: 9,966 tests passed); CI runs them on this one.

## 5. Next Steps And Blockers

- Until this merges, production offers the four rows this change retires (#4999 is live).
- Confirm whether the Code CLI broker accepts the optional `reasoningEffort` field before setting `CODE_CLI_REASONING_EFFORT`; until then Code CLI calls carry no effort setting, as before.

## 6. Zero-Code Findings

- #4999 was enqueued under the owner's token seconds after a second `@kody start-review` comment, with no Kody review on record.  Which workflow enqueued it was not traced.
