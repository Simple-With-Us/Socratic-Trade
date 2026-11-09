# Deep Dive 11 — Implementation: From Placeholder to MVP

> Expert deep-dive expanding §11 of the [Multi-Expert App Analysis](../multi-expert-app-analysis.md). The concrete path from the current stock GitHub Pages placeholder to a working MVP skeleton, for a team newer to this. Ordered high→low impact.

---

#### 11.1 From Placeholder to MVP: Scaffolding, Hosting & Secrets

The single most important architectural fact, which drives everything else: **GitHub Pages serves static files only — it cannot run server code, so it cannot hold a secret.** Any design that puts an LLM key, broker token, or market-data key in the browser is broken on day one. The fix is a server-side Backend-for-Frontend (BFF).

##### 11.1.1 The literal first commits (clear the placeholder, decide the layout)

1. **Delete the dead client code.** Remove the legacy `ga.js` `document.write` block, the `//html5shiv.googlecode.com/svn/trunk/html5.js` reference (the SVN host is long dead — a broken request on every load and a supply-chain footgun), and `javascripts/scale.fix.js`. Drop `user-scalable=no` from the viewport meta (an accessibility regression). Net viewport: `<meta name="viewport" content="width=device-width, initial-scale=1">`. If you want analytics later, add a privacy-respecting, async, consent-gated tag (GA4, Plausible, Fathom) — not the 2010-era `ga.js`.
2. **Replace placeholder content with a real holding page** (one commit): "We're building X — paper-trading only, not investment advice."
3. **Decide the repo layout now.** GitHub Pages can't run the BFF, so you're building two deployables. A **monorepo** is the right default:
   ```
   /apps/web      # frontend (Next.js / SvelteKit)
   /apps/bff      # backend-for-frontend (Node or FastAPI) — holds ALL secrets
   /packages/shared   # shared types: Quote, DraftOrder, ToolResult
   /infra         # IaC, Dockerfiles, CI workflows, migrations
   /evals         # prompt-eval fixtures + leakage tests
   .github/workflows/   README.md  .env.example  .gitignore
   ```
   Move the legacy Pages files into `/apps/web/legacy-landing/` or delete them; the **app does not deploy to Pages**.
4. **Add `.gitignore` and `.env.example` in the very first wave.** Commit `.env.example` with *names only*, never values. A secret committed in commit #2 lives in git history forever.
5. **Add `LICENSE`, a real `README` with run instructions, and CODEOWNERS.**

##### 11.1.2 Architecture skeleton (the BFF is the security boundary)

```
 Browser (public, untrusted)                Your server (trusted)              Third parties
┌──────────────────────────┐   HTTPS    ┌──────────────────────────────┐
│  Next.js / SvelteKit app │ ─────────► │  BFF (Node/FastAPI)          │ ──► LLM API (key here)
│  - chat UI               │  session   │  - auth / sessions           │ ──► Market-data API (key here)
│  - quote view            │   cookie   │  - holds ALL secrets         │ ──► Broker API (token here)
│  - DRAFT-ORDER card      │ ◄───────── │  - LLM orchestration + tools │ ──► Postgres + pgvector/Timescale
│    (human Confirm/Cancel)│   JSON     │  - execution boundary        │
└──────────────────────────┘            └──────────────────────────────┘
        NO secrets ever
```

Non-negotiable rules:
- **Secrets live only in the BFF's server environment.** Never sent to the browser, embedded in client JS, or exposed via a public env var. In Next.js this means plain `process.env.X` in route handlers — **never** `NEXT_PUBLIC_` (that prefix ships the value to the client bundle; same trap with `VITE_`/`PUBLIC_`).
- **The BFF mediates every LLM call.** The browser sends the message to *your* `/api/chat`; the BFF adds the system prompt, calls the model, runs tools, and streams back sanitized results. The client never talks to the model provider directly.
- **The BFF owns tool execution.** When the model wants a quote, the BFF calls the market-data API with the server-held key, validates output, returns structured data. Tools are an allow-list defined in code.
- **The execution boundary is human-confirmed and explicit.** The model *drafts* an order (data: symbol, side, qty, type, limit, est cost); placement happens only when the human clicks Confirm, hitting a *separate* BFF endpoint (`POST /api/orders/confirm`) carrying a server-issued draft id — not free-text from the model. The confirm endpoint re-validates the draft server-side, checks risk limits, and (in MVP) routes to a **paper-trading** broker only.
- **Stateless model, stateful BFF.** Session, auth, conversation history, draft-order registry live server-side (DB + signed httpOnly cookie).

Stack pick: **Next.js (App Router) with route handlers as the BFF** is lowest-friction (one framework, one deploy, secrets server-side by default). Choose a **separate FastAPI BFF** if your quant/ML code is Python (backtesting, pandas, model serving) — then frontend and BFF are two services wired by CORS + a shared types contract. SvelteKit is a fine lighter alternative.

##### 11.1.3 Hosting, secrets, and HTTPS (small-team-friendly)

- **Frontend (+ co-located BFF if Next/SvelteKit):** Vercel (best for Next; preview deploy per PR, per-environment env-var UI, automatic HTTPS), Netlify, or Cloudflare Pages + Workers (cheapest at scale).
- **BFF as a standalone service (Python/FastAPI, websockets, background jobs):** a container on Fly.io / Render / Railway (easiest "real server"; supports persistent connections + cron) or serverless (Lambda+API Gateway, Cloud Run — watch cold starts for streaming). For MVP, **one small always-on container ($5–10/mo)** is simpler than serverless cold-start tuning.
- **Database — three capabilities ideally in one Postgres:** relational tables, **pgvector** for RAG, **time-series** for quotes/bars. Supabase (managed Postgres + pgvector + auth/storage), Neon (serverless Postgres + pgvector + branching — a DB branch per PR pairs with preview deploys), or Timescale Cloud (Postgres + TimescaleDB + pgvector). Start with one instance doing all three; split out a dedicated time-series DB only when ingest volume forces it.
- **Secrets:** dev → a git-ignored `.env`; staging/prod → the host's encrypted env-var store or a vault (Doppler/Infisical/AWS Secrets Manager). Separate keys per environment and per third party; scope/least-privilege every token (broker token = paper account, read+trade only, no withdrawals).
- **HTTPS everywhere** (all managed hosts auto-provision TLS); session cookie `Secure; HttpOnly; SameSite=Lax`; lock CORS on the BFF to known origins (no `*`); rate-limit `/api/chat`.

##### 11.1.4 Build this vertical slice first

Resist building breadth before the spine works. The thinnest end-to-end slice — **"look up a quote, ask about it, draft an order, confirm it (on paper)":**

1. **Quote lookup.** UI ticker input → `GET /api/quote?symbol=AAPL` → BFF calls **one** market-data source with the server-held key → `{symbol, price, change, ts}` rendered. Proves: secrets-in-BFF, a real third-party tool call, structured data back.
2. **Assistant chat grounded in that one source.** `POST /api/chat` → BFF builds the prompt, exposes a single `get_quote` tool, lets the model call it, grounds the answer in the returned numbers (answer only from tool output; say so when data is missing). Stream the reply. Proves: LLM mediation, tool-calling, grounding.
3. **Draft-order card requiring human confirm.** "Buy 1 share" → model returns a *draft* (never an execution) → BFF persists it, returns a card (symbol, side, qty, est cost, account = **PAPER**, Confirm/Cancel) → Confirm → `POST /api/orders/confirm` with the draft id → BFF re-validates, places against a **paper** broker, writes an audit row, returns a fill. Proves: the human-in-the-loop execution boundary end to end.

When this slice runs in a *deployed* environment with real keys held only server-side and HTTPS on, your stack is validated. *Then* add breadth.

##### 11.1.5 The "one data source" rule

Pin the slice to one source on purpose — adding sources multiplies failure modes (conflicting prices, differing symbology, stale-vs-live) before the basic loop is proven. Get the grounding/citation behavior right (cites the tool result; "I don't have that" when the tool returns nothing), then generalize behind a common `MarketDataProvider` type in `/packages/shared`.

##### 11.1.6 Dev essentials (wire these in early)

- **CI on every PR:** install → typecheck (`tsc --noEmit`/`mypy`) → lint → unit tests → build; fail on red.
- **Prompt-eval gate:** a CI job runs `/evals` fixtures against a golden set, asserting correct tool selection, grounded answers, and **refusal to execute without confirmation**. Treat prompt changes like code changes.
- **Leakage gate:** a CI check that fails if a secret-shaped string or server-only env name can reach the client bundle (grep the built frontend; assert no `NEXT_PUBLIC_`/`PUBLIC_`/`VITE_` var holds a real secret).
- **Secrets scanning:** GitHub secret scanning + push protection, plus gitleaks/trufflehog as a pre-commit hook *and* CI step. Run a one-time historical scan now.
- **Error tracking & observability:** Sentry (frontend + BFF), structured logging with a request id propagated through each LLM/tool call. Log every LLM call (model, tokens, latency, cost) and every draft→confirm→execution event to an immutable audit table. Never log secrets or full PII.
- **Paper-trading-only by default — enforced, not documented:** a server-side `TRADING_MODE=paper` flag the confirm endpoint checks; live mode is gated behind an explicit, reviewed config change + a deliberate broker credential swap. Default local/preview/staging to paper. Show the "not investment advice / paper only" disclaimer in the UI.
- **Dependency hygiene:** Dependabot/Renovate; pin versions; vendor or pin anything third-party.

##### 11.1.7 Phased milestone checklist to MVP

- [ ] **Phase 0 — Clean & scaffold (days):** delete `ga.js`/`html5shiv`/`scale.fix.js`, fix viewport, replace placeholder with holding page; stand up the monorepo; add `.gitignore`/`.env.example`/README; enable secret scanning + push protection; "hello world" frontend + BFF running locally.
- [ ] **Phase 1 — CI & hosting spine (days):** CI green; deploy frontend + BFF to a staging URL with HTTPS; provision managed Postgres with pgvector; confirm a host-set secret reaches the BFF and **never** the client (run the leakage check).
- [ ] **Phase 2 — Vertical slice (1–2 weeks):** quote lookup → grounded chat over one source → draft-order card → human-confirmed **paper** execution → audit-logged fill; Sentry + structured logging live. The "stack works" milestone.
- [ ] **Phase 3 — Eval & safety gates (days, overlapping Phase 2):** stand up `/evals`; wire the prompt-eval + leakage gates into CI; add gitleaks + historical scan; enforce `TRADING_MODE=paper`; rate limiting + locked CORS on `/api/chat`.
- [ ] **Phase 4 — Auth & accounts (1 week):** real user auth (Supabase Auth / Auth.js / Clerk); per-user sessions (httpOnly secure cookie); per-user paper portfolios + order history in Postgres.
- [ ] **Phase 5 — Breadth & MVP polish (2–4 weeks):** second/third data source behind the shared provider type; portfolio & positions view; richer RAG over a grounded knowledge source; cost dashboards from the LLM-call log. **MVP = the vertical slice, generalized to a few sources and a logged-in user, fully on paper, with CI + eval/leakage/secret gates green.**

Going live to real money requires Phase 5 *plus* a separate, deliberate, reviewed switch off paper-trading — out of scope for the MVP skeleton.
