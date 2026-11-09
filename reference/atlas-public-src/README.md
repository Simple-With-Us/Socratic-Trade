# Atlas public-repo source archive (`jaywedgeworth22/public`)

Provenance snapshot of the **Atlas BFF** chat-assistant MVP that lived in the public
`jaywedgeworth22/public` repo (default branch `gh-pages`, tip `3ad7508`). That repo was a
parallel experiment; its useful work is being folded into this canonical private repo and the
public repo is being retired. This directory preserves **100%** of it so nothing is lost.

## What's here

- **`atlas-public.bundle`** — a complete `git bundle` of the *entire* public repo: all 9 branches
  + all PR refs + full history. Restore any time with:
  ```bash
  git clone reference/atlas-public-src/atlas-public.bundle /tmp/atlas-restored
  # or inspect a branch:  git -C /tmp/atlas-restored log --all --oneline
  ```
- **`bff/`, `evals/`, `specs/`** — the specific source files worth porting, extracted for easy
  reading (the bundle is the authoritative copy).

## Salvage decision (from the 2026-06-20 multi-agent inventory)

Already ported / superseded in this repo (NOT copied — see `docs/atlas-integration-map.md`):
watchlist, price alerts, orders/blotter, accounts/brokers, infra (auth/config/persistence/audit/
market-data/types), the vanilla-JS web frontend, and all docs (byte-identical in `docs/atlas/`).

**Useful — being ported to TypeScript** (this is the active port plan):

| Preserved source | Capability not yet in private repo | Target (private) | Effort |
|---|---|---|---|
| `bff/orchestrator.mjs`, `bff/llm/{client,prompt}.mjs`, `bff/tools/index.mjs` | LLM tool-loop + draft-card + versioned safety prompt (no chat surface exists) | `src/lib/chat/*` + `app/api/chat/route.ts` | M |
| `bff/rag/chunk.mjs` (+ `store.mjs` for ref) | Structure-aware chunking + `as_of` point-in-time filter + hybrid/RRF | `src/lib/rag/chunk.ts` + wire into `src/lib/vector-db.ts` | M |
| `bff/memory/{salience,store}.mjs` | Salience-gated per-user constraint/preference memory (Deep-Dive-12) | `src/lib/memory/*` + table + `app/api/memory/route.ts` | M |
| `bff/history/store.mjs` | Redact-on-write transcript store (no transcript persistence exists) | `src/lib/history.ts` + table + extend `telemetry-sanitize.ts` | S |
| `evals/{golden,run}.mjs` | Adversarial "LLM never executes a trade" eval gate | `test/atlas-golden-eval.test.ts` | S |
| `bff/notify/{index,prefs}.mjs` + `notify.test.mjs` | Multi-channel alert delivery (push/webhook/email/SMS) — only in-app today | `src/lib/notify*.ts` + `app/api/notifications/*` + scheduler wiring | M |
| `specs/agentic-account-naming.md` | Broker-aware account display-name standard | design ref / future UI | doc |
| `specs/atlas-to-agentic-merge-checklist.md` | Authoritative Atlas→Agentic portability checklist | design ref | doc |

The `bff/notify/*` and both `specs/*` files lived only on unmerged branches
(`claude/multi-expert-app-analysis-jm99bb`, `claude/account-naming-spec`,
`claude/atlas-merge-checklist`) — they are not on `gh-pages`, so the bundle is the only place they
otherwise survive. The other 5 non-`gh-pages` branches were fully-merged ancestors with no unique
content.
