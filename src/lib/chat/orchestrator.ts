// Per-turn chat flow:
//   1. Append the user message to the transcript (redact-on-write) — skipped when the client's
//      clientTurnId is already recorded, so a Retry never duplicates the prompt in the transcript.
//   2. Ingest the message into salience memory (what to remember).
//   3. Assemble context (hard constraints first) into the system prompt.
//   4. Run the provider's tool loop — read-only / draft tools only, via an executeTool callback
//      that has NO execution capability (draft_order returns a ticket, never a fill).
//   5. Return { text, draft?, citations, usedMemories } — never executes a trade.
// Ported from reference/atlas-public-src/bff/orchestrator.mjs.

import { audit, findChatTurnByClientId, getPolicy, getUserSetting, listPendingProposals } from "../db";
import { getBrokerGateway } from "../broker";
import { getPerformanceSummary, getRegimeScorecard, getThesisScorecard } from "../performance";
import { fetchDailyOHLC } from "../history";
import { fetchYahooFinanceQuote } from "../yahoo-finance";
import { citationStalenessEnabled, defaultDedupeSimilarity, defaultMinScore, defaultRelevanceFloor, isStale, retrieveContextDetailed } from "../vector-db";
import type { RetrieveOptions } from "../vector-db";
import { createAlert as alertsCreateAlert, listAlerts as alertsListAlerts } from "../alerts";
import { getEnrichmentProvider } from "../data-providers";
import { getMarketSignals } from "../market-signals";
import { callRobinhoodMcpTool, robinhoodMcpDataEnabled } from "../robinhood";
import { getMcpAccessToken } from "../mcp-oauth";
import { addToWatchlist, listWatchlist as wlList } from "../watchlist";
import { canonicalTicker } from "../rag/chunk";
import { appendTurn, listTurns } from "../chat-history";
import { ingestMessage, retrieve } from "../memory/store";
import { extractLearnedCandidatesLLM } from "../memory/salience-llm";
import { ingestLearned, retrieveLearnedContext } from "../learned-context/store";
import { classifyIntent, getLLM } from "./llm";
import { buildSystem, DISCLAIMER, PROMPT_VERSION } from "./prompt";
import { buildTools, type ToolDeps } from "./tools";
import type { ChatDraft, ChatLLM, ChatQuote, ChatReply, ToolSchema } from "./types";

export function makeOrchestrator(deps: ToolDeps, llm?: ChatLLM) {
  const tools = buildTools();
  const toolSchemas: ToolSchema[] = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.input_schema
  }));

  return async function handleTurn(args: { userId: string; message: string; clientTurnId?: string }): Promise<ChatReply> {
    const { userId, message, clientTurnId } = args;
    // Per-user model: an injected llm (already user-scoped by the route) or one resolved for THIS
    // user — so the per-user key, operator failover, and usage attribution always apply.
    const model = llm ?? getLLM(userId);
    audit("chat.turn", { userId, message_len: message.length, prompt_version: PROMPT_VERSION }, userId);
    // Prior turns (redacted) for multi-turn context — fetched BEFORE appending the current message.
    const history = listTurns(userId, 10).map((t) => ({ role: t.role, text: t.text }));
    // Idempotent user-turn recording: a Retry reuses the same clientTurnId, so when that id is
    // already in the transcript we skip the duplicate append but STILL run the provider call —
    // the retry's whole point is getting the reply the failed attempt never produced.
    const alreadyRecorded = clientTurnId != null && findChatTurnByClientId(userId, clientTurnId) != null;
    if (!alreadyRecorded) appendTurn(userId, { role: "user", text: message, clientTurnId: clientTurnId ?? null });

    const mem = ingestMessage(userId, message);
    // Extract learned-context candidates from the message for both the write path (ingest) and
    // the read path (retrieve facts already in store to inject into the system prompt).
    // extractLearnedCandidatesLLM is regex (extractLearnedCandidates) unless LLM_SALIENCE_EXTRACTOR=on
    // AND a credential resolves for this user — falls back to regex on any LLM-path failure, and
    // validates any LLM-proposed symbol against the real known-ticker universe (see salience-llm.ts).
    const learnedCandidates = await extractLearnedCandidatesLLM(message, userId);
    // Fire-and-forget write path: the semantic classifier runs 3+ sequential LLM calls — awaiting
    // it on the hot path would add 1–3 s of latency to every chat turn. Errors are benign: advisory
    // writes, never critical. The chat hard-cap (risk-adjacent prose is DROPPED) holds inside
    // ingestLearned regardless.
    for (const candidate of learnedCandidates) {
      ingestLearned(userId, candidate, "chat").catch((e) => {
        console.warn("[orchestrator] learned-context ingest failed:", e);
      });
    }
    // Read path: inject already-stored facts for symbols mentioned in this message so the model
    // sees prior advisory context it (or the strategy loop) has learned.
    const learnedSymbols = learnedCandidates.map((c) => c.symbol).filter((s): s is string => s != null);
    const learnedFacts = learnedSymbols.length > 0 ? retrieveLearnedContext(userId, learnedSymbols) : [];
    const learnedContextSummary = learnedFacts.join("\n");
    const memories = retrieve(userId);
    const memorySummary = memories.map((m) => `- ${m.hard ? "[HARD] " : ""}${m.subject}: ${m.value}`).join("\n");

    // The only path to a tool — it has no execution capability.
    const executeTool = async (name: string, input: unknown) => {
      const tool = tools[name];
      if (!tool) return { error: "UNKNOWN_TOOL", name };
      audit("tool.call", { userId, tool: name }, userId);
      return tool.execute(input, { userId, deps });
    };

    const result = await model.run({
      system: buildSystem(memorySummary, learnedContextSummary),
      message,
      tools: toolSchemas,
      executeTool,
      context: { memorySummary },
      history
    });

    // Server-side disclaimer guarantee (provider-independent): the system prompt asks for it, but we
    // never rely on the model to remember it — append if missing so compliance holds on every provider.
    const text = result.text.includes(DISCLAIMER) ? result.text : `${result.text}\n\n${DISCLAIMER}`;

    // Extract a draft (if any) for the UI; the assistant never executes.
    const draftCall = result.toolCalls?.find((c) => c.name === "draft_order" && c.result && !c.result.error);
    const draft = (draftCall?.result as ChatDraft) ?? null;

    const usedModel = model.modelName;
    const reply: ChatReply = {
      text,
      draft,
      citations: result.citations ?? [],
      usedMemories: memories.map((m) => ({ subject: m.subject, value: m.value, hard: m.hard })),
      memory: { written: mem.written.length, held: mem.held.length },
      intent: classifyIntent(message).intent,
      promptVersion: PROMPT_VERSION,
      model: usedModel
    };
    appendTurn(userId, {
      role: "assistant",
      text: reply.text,
      citations: reply.citations.map((c) => c.chunk_id ?? c.source),
      intent: reply.intent,
      model: usedModel
    });
    audit("chat.reply", { userId, has_draft: !!draft, citations: reply.citations.length }, userId);
    return reply;
  };
}

/** Production tool wiring to the canonical private subsystems (broker quotes, RAG, alerts, watchlist). */
export function buildProductionDeps(): ToolDeps {
  return {
    async getQuote(symbol, userId): Promise<ChatQuote> {
      const fallback: ChatQuote = { symbol, price_usd: 0, as_of: "", source: "none" };
      try {
        const policy = getPolicy(userId);
        let price: number | undefined;
        let asOf: string | undefined;
        let source: string | undefined;
        // 1) Account-aware broker quote, when an account is selected. Its own try/catch so a broker
        // failure (auth, data plan, network) FALLS THROUGH to the market-data fallback below instead
        // of aborting the whole quote.
        if (policy.accountNumber) {
          try {
            const quotes = await getBrokerGateway(policy, userId).getEquityQuotes(policy.accountNumber, [symbol]);
            const q = quotes[symbol];
            if (q && typeof q.price === "number" && q.price > 0) {
              price = q.price;
              asOf = q.asOf;
              source = q.provider ?? "broker";
            }
          } catch {
            /* fall through to the keyless market-data fallback */
          }
        }
        // 2) Live market-data quote (Yahoo regularMarketPrice + its real timestamp). Preferred over the
        // daily-bar close so the "as of" reflects today's price, not the last completed daily bar
        // (which is often yesterday until the current session's bar posts).
        if (price == null) {
          const yq = await fetchYahooFinanceQuote(symbol);
          if (yq && yq.price > 0) {
            price = yq.price;
            asOf = yq.asOf;
            source = "yahoo-finance";
          }
        }
        // 3) Daily-close fallback (recent close) — last resort when no live quote is available. Works
        // with NO account selected too, so "what's X at" still gets answered instead of NO_QUOTE.
        if (price == null) {
          const bars = await fetchDailyOHLC(symbol, Date.now(), userId);
          const last = bars && bars.length ? bars[bars.length - 1] : undefined;
          if (last && typeof last.close === "number" && last.close > 0) {
            price = last.close;
            asOf = last.time != null ? String(last.time) : undefined;
            source = "yahoo-finance-delayed";
          }
        }
        if (price == null) return { ...fallback, error: "NO_QUOTE" };
        return { symbol, price_usd: price, as_of: asOf ?? new Date().toISOString(), source: source ?? "delayed" };
      } catch {
        return { ...fallback, error: "QUOTE_FAILED" };
      }
    },
    async searchKnowledge(args, userId) {
      const symbol = args.ticker ? canonicalTicker(args.ticker) : "";
      if (!symbol) return [];
      // Forward ALL retrieval options: as-of (point-in-time), the doc_type the intent classifier extracted
      // (previously dropped here), and the relevance floor. docType matching is casing-tolerant downstream.
      const options: RetrieveOptions = {
        ...(args.as_of ? { asOf: args.as_of } : {}),
        ...(args.doc_type ? { docType: [args.doc_type] } : {}),
        minScore: defaultMinScore(),
        // 2026-07-04 RAG quick-wins: wire the previously-dormant post-rerank relevance floor +
        // near-duplicate suppression (both existed since 2026-07-01 but no caller passed them).
        minRelevanceScore: defaultRelevanceFloor(),
        dedupeSimilarity: defaultDedupeSimilarity()
      };
      const chunks = await retrieveContextDetailed(args.query, symbol, args.k ?? 5, userId, options);
      // Real provenance — chunk_id is the actual vector id; as_of is the chunk's own date (not the query's).
      // R13 (2026-07-01 RAG backlog): additive doc_type/section/url provenance keys + an optional
      // advisory isStale label (RAG_CITATION_STALENESS, default off). Backend/payload only — no UI
      // consumes these yet; a parallel dashboard-redesign thread owns any citation rendering.
      const staleness = citationStalenessEnabled();
      return chunks.map((c) => ({
        chunk_id: c.id,
        text: c.text,
        source: c.source ?? "kb",
        as_of: c.as_of,
        score: c.score,
        url: c.url,
        doc_type: c.doc_type,
        section: c.section,
        ...(staleness ? { isStale: isStale(c.as_of, c.doc_type) } : {})
      }));
    },
    createAlert(userId, input) {
      const result = alertsCreateAlert(userId, input);
      if ("error" in result) return result;
      return { symbol: result.symbol, op: result.op, price: result.price };
    },
    watchlistAdd(userId, symbol) {
      try {
        return { ok: true, item: addToWatchlist(userId, symbol) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "WATCHLIST_FAILED" };
      }
    },
    async getPositions(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return [];
      try {
        return await getBrokerGateway(policy, userId).getEquityPositions(policy.accountNumber);
      } catch {
        return [];
      }
    },
    async getPortfolio(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      try {
        return await getBrokerGateway(policy, userId).getPortfolio(policy.accountNumber);
      } catch {
        return null;
      }
    },
    listWatchlist(userId) {
      return wlList(userId);
    },
    listAlerts(userId) {
      return alertsListAlerts(userId, "armed");
    },
    listOpenProposals(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return [];
      return listPendingProposals(policy.accountNumber, userId);
    },
    async getFundamentals(symbol, userId) {
      try {
        const provider = getEnrichmentProvider(userId);
        const map = await provider.enrich([symbol]);
        const res = map[symbol];
        if (!res) return { error: "NO_FUNDAMENTALS" };
        return res;
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async getMarketSignals(userId) {
      try {
        return await getMarketSignals(userId);
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async getPortfolioPnl(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      try {
        // Derive current prices from open positions (marketValue / quantity) so unrealized P&L is real,
        // without spending extra quote calls.
        const positions = await getBrokerGateway(policy, userId).getEquityPositions(policy.accountNumber);
        const currentPrices: Record<string, number> = {};
        for (const p of positions) {
          if (p.quantity !== 0 && Number.isFinite(p.marketValue) && Number.isFinite(p.quantity)) {
            currentPrices[p.symbol] = p.marketValue / p.quantity;
          }
        }
        const s = getPerformanceSummary(policy.accountNumber, currentPrices, userId);
        return {
          liveRealizedPnl: s.liveRealizedPnl,
          paperRealizedPnl: s.paperRealizedPnl,
          liveUnrealizedPnl: s.liveUnrealizedPnl,
          paperUnrealizedPnl: s.paperUnrealizedPnl,
          liveWinRate: s.liveWinRate,
          paperWinRate: s.paperWinRate
        };
      } catch {
        return null;
      }
    },
    getPerformanceSummary(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      const byThesis = getThesisScorecard(policy.accountNumber, undefined, {}, userId).map((r) => ({
        key: r.thesisTag,
        trades: r.trades,
        winRate: r.winRate,
        avgReturnPct: r.avgReturnPct,
        totalPnl: r.totalPnl
      }));
      const byRegime = getRegimeScorecard(policy.accountNumber, undefined, {}, userId).map((r) => ({
        key: r.regime,
        trades: r.trades,
        winRate: r.winRate,
        avgReturnPct: r.avgReturnPct,
        totalPnl: r.totalPnl
      }));
      return { byThesis, byRegime };
    },
    getReflection(userId) {
      return getUserSetting<string>(userId, "reflection_summary", "");
    },
    // Robinhood MCP-backed read-only research. Each returns a clear "not connected" result (never a
    // thrown error) when the adapter is off or the user has no stored token, so chat degrades to a
    // plain message instead of failing the turn. Purely discovery — none of these can place an order.
    async getEarningsCalendar(userId, args) {
      const notConnected = await robinhoodNotConnected(userId);
      if (notConnected) return notConnected;
      try {
        const raw = await callRobinhoodMcpTool(userId, "get_earnings_calendar", {
          ...(args.start_date ? { start_date: args.start_date } : {}),
          ...(args.days != null ? { days: args.days } : {}),
          ...(args.high_market_cap ? { filter: "high_market_cap" } : {})
        });
        return { earnings: raw };
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async getOptionChain(userId, underlyingSymbol) {
      const notConnected = await robinhoodNotConnected(userId);
      if (notConnected) return notConnected;
      try {
        const raw = await callRobinhoodMcpTool(userId, "get_option_chains", { underlying_symbol: underlyingSymbol });
        return { symbol: underlyingSymbol, chains: raw };
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async searchInstrument(userId, args) {
      const notConnected = await robinhoodNotConnected(userId);
      if (notConnected) return notConnected;
      try {
        const raw = await callRobinhoodMcpTool(userId, "search", {
          query: args.query,
          ...(args.asset_type ? { asset_type: args.asset_type } : {}),
          ...(args.limit != null ? { limit: args.limit } : {})
        });
        return { results: raw };
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    accountLabel: "Test (local)"
  };
}

// A "not connected" result (not a throw) when Robinhood MCP data is disabled or the user has no
// stored token — so the research tools return a plain message the model can relay to the user.
async function robinhoodNotConnected(userId: string): Promise<{ error: string; message: string } | null> {
  if (!robinhoodMcpDataEnabled()) {
    return { error: "NOT_CONNECTED", message: "Robinhood is not connected. Connect your Robinhood agentic account in Settings → Connections to enable this." };
  }
  const token = await getMcpAccessToken(userId);
  if (!token) {
    return { error: "NOT_CONNECTED", message: "Robinhood is not connected. Connect your Robinhood agentic account in Settings → Connections to enable this." };
  }
  return null;
}
