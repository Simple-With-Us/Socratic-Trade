# Model Classes, Rotation Selection And Catalog Refresh (2026-11-04, ST-4589)

## 1. Context And Objective

The owner reviewed the Model Stats view and asked for five things: stop rolling gpt-5.6-terra into other models (Terra is its own class; OpenAI has four classes), fix the effort defaults for MiniMax and Muse contributor models, remove Llama and add the two Muse Wonder contributor models, move every provider to its latest variants and show what each `-latest` alias resolves to, and let users choose which models each team (Green and Red) rotates between.

## 2. Changes Made

**Model Stats view.**  Each model's numbers are now strictly its own.  Before, a model with fewer than 3 live calls had its predecessor's calls, cost and tokens added into its own count, and the inheritance chained (Astra Pro inherited from Astra, which had already inherited from Sol and Terra), so "live n=39" on gpt-5.6-sol was mostly Terra.  Now a predecessor's figures appear only as a labelled estimate ("est. from X"), taken from the predecessor's own numbers, and only from an older generation of the same class.  A model's own realized results and veto results always show when it has any.  The catalog `lineage` field is the model class and is shown as "class: Label".  Llama rows are dropped.  Alias rows show "currently -> <served model>" from the newest `llm_usage.served_model`, or "expected -> <native id>" when nothing is recorded yet.  The 2026-07-13 GPT-5.6 benchmark file is now imported.

**Rotation selection.**  `TradingPolicy` gains optional `llmRotationModels` and `redTeamRotationModels`.  When a seat is set to rotate, a Rotation Models checklist (grouped by provider, with Select All and Clear) appears under it.  Rotation picks only from the ticked models that pass the existing eligibility filter (credentials, availability, cooldown).  Nothing ticked keeps today's behaviour.  An explicitly ticked cost-excluded model (Opus, Fable, Wonder) is honoured; Select All does not tick those.  Failover tries the ticked models first, then the normal chain.  If no ticked model is eligible the seat falls back to the whole pool and the `model_rotation_pick` audit records `selectionFallback: true`.

**Catalog.**  OpenAI is now `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna` (classes Astra, Sol, Terra, Luna).  `gpt-6-astra-pro` (the same model as Astra in "pro" reasoning mode), `gpt-5.6-sol` and `gpt-5.6-luna` move to a retired list: they leave the picker, rotation and stats seeding, but a stored selection resolves to the same wire slug and price as before.  Nothing is migrated automatically.  Anthropic's native Haiku id moves to Haiku 5.5 (sent as an adaptive-thinking model with no custom temperature, which it rejects); Sonnet's native id stays on Sonnet 5 (see Decisions) while the OpenRouter alias resolves to the newest; Grok to 4.7; Kimi to K3.1 Pro; DeepSeek Flash to the `~deepseek/deepseek-flash-latest` alias (v4.1); Mistral Large to Large 4.  Added: `minimax-m3.1-flash`, `muse-wonder-1.0`, and the two Muse Code ids `muse-wonder-1.0-contributor` and `muse-wonder-full-1.0-contributor` behind a new `codeCliOnly` flag.  Muse classes are split (Spark, Wonder, Wonder Full, Glimmer).  Llama routing, labels and identity mapping are removed; historical Llama prices stay so old usage is still costed, and a stored Llama id now fails with a clear message and fails over.

**Reasoning effort.**  MiniMax M3.1 Flash defaults to max when no effort is sent, and this app sent none.  MiniMax M3.1 Flash and Muse models now get an explicit effort on the OpenRouter and native routes (default medium).  Muse contributor models are capped at xhigh.  MiniMax M3 still gets no effort because neither MiniMax nor OpenRouter documents one for it.  The Code CLI broker contract gains an optional `reasoningEffort` field, off by default behind `CODE_CLI_REASONING_EFFORT`.

**Unavailable models fail over.**  A model the user's route cannot serve (a Code CLI only model off that route, Glimmer on the Code CLI route, a Llama id) raises `LlmModelUnavailableError`; the Green and Red failover loops skip it instead of aborting the run.

**Timeouts.**  The AI strategy review gets 90 seconds when the model is reasoning (under Cloudflare's edge limit).  The background learning review gets 360 seconds with a single-flight guard per user.

**Fixed on the way.**  The DeepSeek JSON-mode check did not match the `~deepseek/` slug.  The budget downgrade map had arrows to more expensive or removed models.

Files touched:

- `src/lib/llm-model-catalog.ts`, `src/lib/model-stats.ts`, `src/lib/llm-served-model.ts` (new)
- `src/lib/model-rotation.ts`, `src/lib/model-rotation-selection.ts` (new), `src/lib/types.ts`
- `src/lib/llm-provider.ts`, `src/lib/llm-reasoning.ts`, `src/lib/llm-request.ts`, `src/lib/llm-call.ts`, `src/lib/code-cli.ts`, `src/lib/chat/llm.ts`
- `src/lib/strategy.ts`, `src/lib/red-team.ts`, `src/lib/strategy-tuning.ts`, `src/lib/learning-review.ts`
- `src/lib/model-reasoning-recommendations.ts`, `src/lib/model-identity.ts`, `src/lib/llm-stats.ts`, `src/lib/llm-usage.ts`, `src/lib/usage-budget.ts`
- `app/api/llm-usage/model-stats/route.ts`, `app/api/policy/route.ts`, `app/api/strategy/run/route.ts`, `app/api/keys/route.ts`, `app/api/chat/providers/route.ts`
- `app/console/components/model-stats-drawer.tsx`, `app/console/strategy/page.tsx`, `app/console/strategy/rotation-models.tsx` (new), `app/console/lib/models.ts`, `app/console/settings/learning-review.tsx`
- `docs/llm/code-cli-broker.md`, `docs/manager-model-options.md`, `STATUS.md`, `PLAN.md`, this note
- Tests under `test/`: catalog, model stats, served model, rotation, policy rotation models, reasoning, request bodies, provider routing, Code CLI routing and failover, usage budget, model identity

## 3. Decisions And Trade-Offs

- **Retired, not migrated.**  A stored `gpt-5.6-sol`, `gpt-5.6-luna` or `gpt-6-astra-pro` keeps running that exact model.  Auto-switching the model that trades was judged the owner's call.
- **Wonder contributor ids are Muse Code ids.**  Meta's Model API and OpenRouter do not serve them, so the Code CLI route is the only path.  No running Code CLI broker was found on the server, so these two models will not complete a call until a broker is live and accepts them.  They are kept out of rotation and failover unless the route is enabled and ready, and saving one as a fixed seat model is refused otherwise.
- **`reasoningEffort` to the broker is off by default.**  The broker's strictness could not be checked and a failed broker call has no API fallback.
- **Native Anthropic route and the 5.5 models.**  Anthropic's docs say Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 reject forced tool use, which is how the native Anthropic body in `src/lib/llm-call.ts` gets structured JSON.  Sonnet's native id therefore stays `claude-sonnet-5`, so an account with an Anthropic key and no OpenRouter key behaves as before.  Native Opus 5.5 and Fable 5.1 were already in that state before this change.  Moving the native path to structured outputs is a follow-up.  The stats view's "expected" line for Sonnet uses a separate `expectedLatestSlug` so it stays truthful for the OpenRouter alias.
- **Mistral Large 4 runs at high effort only**, the one level both Mistral and OpenRouter accept for it.  Mistral Medium 3.5 is deprecated upstream with no successor (retires 2027-04-30); the row stays.
- **Not changed:** the Gemini `/^google\//` check misses `~google/` ids the same way the DeepSeek one did, but it works in production today.  Kimi K3.1 Pro has no effort setting.  The iOS Coach list (`ios/SocraticTrade/DeskModels.swift`) uses alias ids and was not touched.
- **Unverified:** what each OpenRouter `~...-latest` alias resolves to is not published; the view shows the recorded served model once a call has been made.

## 4. Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Results are recorded on the pull request.  The Rotation Models checklist was not viewed in a browser.

## 5. Next Steps And Blockers

- Stand up (or locate) the Code CLI broker, confirm it accepts the Wonder contributor ids, then set `CODE_CLI_REASONING_EFFORT=true`.
- Owner: decide whether stored selections of retired models should move to their successors.
- Re-run the model benchmarks; the newest benchmark data is from July and covers none of the new ids.
- Fixed model arms per account would make model comparisons clean; rotation still confounds them (see `docs/reviews/2026-11-04-performance-and-learning-evaluation.md` on the learning-loop branch).

## 6. Zero-Code Findings

- Rotation, failover chains and the `__rotate__` sentinel already existed; only the selection was missing.
- The catalog `lineage` field was never read anywhere before this change.
- `llm_usage.served_model` was recorded on every call and read by nothing in the console.
