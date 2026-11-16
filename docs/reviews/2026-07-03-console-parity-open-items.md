# 2026-07-03 - Socratic Trade console parity/open-items audit

This is the current documented list of new-console areas that are either not fully
made, only partially ported from the legacy dashboard, or still need polish. It
is based on the 2026-07-03 old-vs-new pass plus owner feedback during the
Socratic Trade reframe.

## Fixed or materially improved in the current Codex branch

- `/old` route exists as a legacy dashboard escape hatch.
- Root `/` routes into `/console`; Robinhood OAuth returns to `/console/settings`.
- Legacy auth env values for `trading.jays.services` are canonicalized to
  `https://socratictrade.com` before Auth.js builds Google/GitHub redirects.
- Live thesis headline is reframed as a market thesis, with ticker-specific
  action shown as the current expression rather than the thesis itself.
- Home ticker references now open the shared right-side symbol drawer.
- Home evidence-card ticker references now open the shared right-side symbol
  drawer with the same candidate quote the card is rendering.
- Strategy Green/Red models use curated dropdowns instead of raw text boxes.
- Strategy and AI Review model controls now expose provider-specific
  reasoning/thinking options for OpenAI, Anthropic, Gemini, xAI, and Mistral.
- `/console/scan` matches the legacy dashboard's browser-local column behavior
  for the current console columns: visibility toggles, reorder controls, Reset,
  and saved visible-column order/state.
- Pinecone/Voyage health and RAG ingest state are surfaced in admin RAG/health
  responses instead of being hidden only in activity logs.
- User-scoped LLM usage is available outside admin; admins still see all users.
- The Coach page has been reframed around thesis critique, refocus, memory,
  evidence, framework improvement, and draft-to-Approvals workflows.
- Guardrail wording no longer uses visible `looser`/`tighter` labels; authority
  expansion/restriction is shown with lock/unlock language.
- The first absolute-vs-percent duplicate cap pairs now render as a mode switch:
  Max Per Order and Max In One Stock.
- Guardrails universe and autonomy controls now carry native titles for the
  checkbox/text/select/button controls that were previously bare.

## Still incomplete / needs follow-up

- `admin.socratictrade.com` is not implemented. Admin pages remain in-app routes;
  DNS/routing/middleware split still needs a dedicated admin host plan.
- Universal tooltips are not complete. Many console controls have `title` hints,
  and the Guardrails universe/autonomy controls have been swept, but this has
  not been proven across every button, setting, metric, table cell, and data point.
- Only two absolute-vs-percent setting pairs have been converted to polished
  mode switches. Remaining duplicated constraints need the same treatment where
  the pair is semantically either/or.
- The shared symbol drawer is restored across the documented console ticker
  surfaces: scan, Home action rows, Home evidence cards, proposals, orders,
  activity, outcomes, approvals, and watchlist. Legacy dashboard/admin surfaces
  remain separate from the console parity row.
- The market scan company-info popup/drawer behavior still needs live UI
  verification on desktop and mobile after the drawer migration.
- Admin/API connection health has broader placeholders now, but each provider
  lane still needs end-to-end failure injection to prove global failures email
  admins and user-key failures notify only that user.
- Pinecone quota investigation is explained and mitigated, but production should
  be observed after switching to `socratic-trade` to verify ingest budgets,
  dedupe, and 10-K/10-Q limits hold under real scheduler cadence.
- LLM usage labels are improved, but cost tables still need per-provider pricing
  coverage checks so unknown model IDs are not silently undercounted.
- Coach chat is still backed by the existing chat transcript/orchestrator. The UI
  is now reframed, but deeper first-class coaching primitives are still needed:
  attach a coach note to a specific decision from chat, promote a chat lesson into
  framework memory, and show which future run consumed that lesson.
- Live thesis remains derived from the latest stored Socratic decision/proposal.
  The display is no longer one ticker as the headline, but a deeper market-strategy
  object would be better: thesis statement, scope/universe, supporting evidence,
  disconfirming evidence, representative actions, invalidation triggers, and
  outcome scorecard.
- `/console/settings` still carries more of the old settings IA than the new
  Autonomy Desk mental model. It needs a second pass around account identity,
  authority, provider keys, notification channels, and admin links.
- Appearance/display preferences from the legacy dashboard are not fully ported.
- Admin/operator links are still less discoverable than they should be for the
  owner/operator workflow.
- Production deploy/routing for `socratictrade.com/old` and the canonical
  `/console` path must be verified after merge; local code alone is not proof.

## Design decision: Live Thesis

A single company to buy is not a thesis. The UI should treat a ticker proposal as
an expression of a broader market thesis. A good thesis is closer to: "quality
semiconductors are underpriced relative to near-term demand expansion" than
"buy NVDA." The current branch applies that distinction in the Home headline,
but the data model should eventually store the thesis as a richer market-strategy
record rather than deriving it from a proposal tag.
