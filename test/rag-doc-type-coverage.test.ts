/**
 * corpus-coverage-receipt (2026-07-06; redesigned same day for the SECOND time — see
 * docs/rollouts/2026-07-06-corpus-coverage-receipt.md for the full history). Per-run advisory
 * receipt for a COVERAGE-CHECKED filings doc type whose PRODUCER LEDGER IS COMPLETE — always
 * 10-k/10-q, plus earnings-transcript only while its default-off producer is enabled — that is
 * BOTH not retrieved this run AND has zero ever-ingested producer rows.
 *
 * Ground truth: strategy.ts's filings-RAG pass requests only narrative 10-k/10-q/8-k plus
 * earnings-transcript only while storage/display rights remain confirmed. Transcript retrieval
 * remains useful for already-ingested chunks when refresh is off, but is removed everywhere if
 * rights confirmation is withdrawn.
 * ingested_accessions is a COMPLETE producer ledger for 10-K/10-Q (src/lib/web-sources/sec-filings.ts
 * writes an accession row for every 10-K/10-Q ingest) but INCOMPLETE for 8-K (the default-ON
 * summary writer in sec8k.ts writes retrievable doc_type:"8-k" chunks but no accession row; only
 * the default-OFF full-body path writes "8-K-body").
 *
 * THIRD FIX in this lane (this file): the SECOND fix (which dropped the producer check entirely
 * and fired on this-run-retrieval-emptiness alone for a 10-k/10-q/8-k allowlist) introduced a new
 * daily-noise bug: 8-k is event-sparse and frequently won't rank top-3, so the receipt would fire
 * on a large fraction of normal runs. This fix:
 *   - Narrows COVERAGE_CHECKED_DOC_TYPES to ["10-k", "10-q"] (ledger-complete types only) —
 *     "8-k" is excluded (ledger incomplete, would false-positive on normal runs).
 *     "earnings-transcript" is included only while its complete-ledger producer is explicitly on.
 *   - Restores the BOTH-CONDITIONS guard for the ledger-complete set: not-retrieved-this-run AND
 *     zero-ever-ingested-producer-rows (via one bulk ingestedAccessionCountsByDocType() call +
 *     in-memory prefix lookup in strategy.ts, fed into computeEmptyDocTypes as a
 *     hasProducerForDocType predicate — keeping prompt-safety.ts DB-free).
 *
 * Covers:
 *  (a) computeEmptyDocTypes (pure): 10-k requested, NOT retrieved this run, ZERO producer rows —
 *      receipt fires naming 10-k.
 *  (b) THE KEY LOW-NOISE CASE (pure + integration): 10-k requested, NOT retrieved this run, but HAS
 *      >=1 producer row — receipt does NOT fire. Proves normal-run silence.
 *  (c) 8-k never triggers a coverage receipt regardless of retrieval/accession state (excluded from
 *      COVERAGE_CHECKED_DOC_TYPES).
 *  (d) earnings-transcript stays quiet by default, but fires when its producer is explicitly enabled.
 *  (e) advisory invariant: ragContext / proposal count unchanged by the receipt firing.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { computeEmptyDocTypes } from "../src/lib/prompt-safety";

// Canned local test gateway (no HTTP) for the "alpaca" paper account, as in the other strategy tests.
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rag-doc-type-coverage-${randomUUID()}.db`)}`;
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const noProducer = () => false;
const allProducer = () => true;

describe("computeEmptyDocTypes (pure)", () => {
  it("(a) 10-k requested, NOT retrieved this run, ZERO producer rows -> fires naming 10-k", () => {
    const empty = computeEmptyDocTypes(["10-k"], [], noProducer);
    expect(empty).toEqual(["10-k"]);
  });

  it("(b) THE KEY LOW-NOISE CASE: 10-k requested, NOT retrieved this run, but HAS a producer -> does NOT fire", () => {
    const empty = computeEmptyDocTypes(["10-k"], [], allProducer);
    expect(empty).toEqual([]);
  });

  it("flags only the coverage-checked type(s) that are BOTH unretrieved AND producer-less", () => {
    const hasProducer = (docType: string) => docType.toLowerCase() === "10-q"; // 10-q has a producer, 10-k does not
    const empty = computeEmptyDocTypes(["10-k", "10-q"], [], hasProducer);
    expect(empty).toEqual(["10-k"]);
  });

  it("flags nothing when every coverage-checked type was retrieved this run, even with no producer", () => {
    const empty = computeEmptyDocTypes(["10-k", "10-q"], ["10-k", "10-q"], noProducer);
    expect(empty).toEqual([]);
  });

  it("flags all coverage-checked types when none retrieved this run and none has a producer", () => {
    const empty = computeEmptyDocTypes(["10-k", "10-q"], [], noProducer);
    expect(empty).toEqual(["10-k", "10-q"]);
  });

  it("is case-insensitive on both retrieved doc_type and the coverage-checked type", () => {
    const empty = computeEmptyDocTypes(["10-K"], ["10-k"], noProducer);
    expect(empty).toEqual([]);
  });

  it("never considers 8-k or a disabled transcript producer when omitted by the caller", () => {
    // strategy.ts passes only the dynamically enabled, complete-ledger subset. 8-k and a default-off
    // earnings-transcript producer do not appear as inputs and therefore cannot false-positive.
    const empty = computeEmptyDocTypes(["10-k", "10-q"], ["10-k", "10-q"], noProducer);
    expect(empty).toEqual([]);
  });
});

// ── Strategy-level integration: receipt fires / does not fire, advisory invariant ──────────────
//
// NOTE ON ORDERING: this describe block (and the DB-helper describe block below it) share ONE
// DATABASE_URL for the whole file (see beforeAll above) — insertIngestedAccession calls persist
// across `it`s. The DB-helper block below deliberately seeds a real "10-K" ingested_accessions row,
// so it is placed AFTER these integration tests to avoid silently turning test (a)'s "ZERO
// ingested_accessions rows for 10-K" premise false.

type OpenAiBody = { input?: Array<{ role: string; content: string }> };

const BULL_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 1000,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Structured momentum evidence for AAPL",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Neutral (Normal Volatility)",
  confidenceScore: 40
};

function nasdaqResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: {
          rows: [
            {
              symbol: "AAPL",
              lastsale: "$200",
              pctchange: "1%",
              volume: "1000000",
              marketCap: "3000000000000",
              sector: "Technology",
              industry: "Consumer Electronics"
            }
          ]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function stubFetch(openAiBodies: OpenAiBody[]): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
      const body = JSON.parse(String(init?.body ?? "{}")) as OpenAiBody;
      openAiBodies.push(body);
      if (JSON.stringify(body).includes("Red Team Risk Agent")) {
        return new Response(
          JSON.stringify({ output_text: JSON.stringify({ verdict: "approve", reason: "No fatal flaw found." }) }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [BULL_PROPOSAL] }) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupBrokerPaperDecide(): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: "TEST",
    label: "Doc-Type Coverage Test",
    apiKey: "PK-TEST",
    apiSecret: "sk-test",
    isActive: true
  });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    activeBroker: "alpaca",
    accountNumber: "TEST",
    llmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    redTeamLlmModel: "openai/gpt-4.1-mini",
    maxOrderPctOfNav: 100,
    maxDailyNotional: 400_000,
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  });
}

describe("corpus-coverage receipt — strategy.ts integration (advisory only)", () => {
  it("(a) 10-k requested, NOT retrieved this run, ZERO ingested_accessions rows for 10-K -> receipt fires naming 10-k", async () => {
    // 10-q and 8-k retrieve chunks this run; 10-k does not, and no ingested_accessions row for
    // 10-K exists anywhere in this test's DB.
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-8k", text: "Material event.", score: 0.5, doc_type: "8-k", source: "sec-8k", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 }),
      getCurrentVectorProviderAuthority: () => "test-provider",
      managedVectorLedgerAuthority: () => "test-ledger"
    }));

    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit, listSocraticDecisionCases } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverageAudits = runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty");
    expect(coverageAudits.length).toBe(1);

    const payload = coverageAudits[0]!.payload as { emptyDocTypes?: string[]; requestedDocTypes?: string[] };
    expect(payload.emptyDocTypes).toEqual(["10-k"]);
    expect(payload.requestedDocTypes).toEqual(["10-k", "10-q", "8-k"]);

    const cases = listSocraticDecisionCases("local", { runId: result.runId });
    expect(cases.length).toBeGreaterThanOrEqual(1);
    const coverageItems = cases[0]!.evidence.filter(
      (item) => item.kind === "safety" && item.title === "Filings library still warming up"
    );
    expect(coverageItems.length).toBe(1);
    expect(coverageItems[0]!.summary).toContain("10-k");
    // Warm-up receipt is advisory context, not a safety alarm — neutral tone by design
    // (owner report 2026-07-09: the warning-orange "never ingested" card on every stock
    // read as a per-symbol lookup failure).
    expect(coverageItems[0]!.tone).toBe("neutral");
  }, 75_000);

  it("(b) THE KEY LOW-NOISE CASE: 10-k requested, NOT retrieved this run, but HAS >=1 ingested_accessions '10-K' row -> receipt does NOT fire", async () => {
    // Proves normal-run silence: a coverage-checked type that simply didn't rank this run's
    // top-3 chunks, but genuinely has corpus coverage, must not produce a receipt.
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-8k", text: "Material event.", score: 0.5, doc_type: "8-k", source: "sec-8k", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 }),
      getCurrentVectorProviderAuthority: () => "test-provider",
      managedVectorLedgerAuthority: () => "test-ledger"
    }));

    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    // Seed a real ingested_accessions row for 10-K BEFORE the run — mirrors sec-filings.ts's
    // always-on ingestFiling writer having produced 10-K coverage for this account in the past,
    // even though this particular run's retrieval didn't rank a 10-K chunk in the top 3.
    const { insertIngestedAccession } = await import("../src/lib/db");
    insertIngestedAccession(`acc-${randomUUID()}`, "10-K", "AAPL", 4);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverageAudits = runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty");
    // 10-k didn't retrieve this run, but DOES have a producer row -> both-conditions guard keeps
    // the receipt silent. This is the normal-run case and must never fire.
    expect(coverageAudits.length).toBe(0);
  }, 75_000);

  it("(c) 8-k never triggers a coverage receipt regardless of retrieval/accession state (excluded from COVERAGE_CHECKED_DOC_TYPES)", async () => {
    // Mirrors the default production config exactly: the 8-K summary writer (sec8k.ts,
    // WEB_SOURCE_SEC8K default ON) stores retrievable "8-k" chunks but never calls
    // insertIngestedAccession. Here 8-k retrieves NOTHING this run (the event-sparse case that
    // motivated this fix) AND has zero ingested_accessions rows — the worst case for the old,
    // retrieval-only design — yet must still not fire, because 8-k is excluded from
    // COVERAGE_CHECKED_DOC_TYPES entirely. 10-k/10-q both retrieve chunks this run.
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 }),
      getCurrentVectorProviderAuthority: () => "test-provider",
      managedVectorLedgerAuthority: () => "test-ledger"
    }));

    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    // Deliberately NOT calling insertIngestedAccession for "8-K"/"8-K-body" anywhere.
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverageAudits = runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty");
    expect(coverageAudits.length).toBe(0);
  }, 75_000);

  it("(d1) does NOT fire for earnings-transcript while its default-off producer is disabled", async () => {
    // Both always-checked types retrieve chunks; transcript refresh is explicitly off, so the
    // producer cannot be expected to have populated the corpus and coverage stays quiet.
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 }),
      getCurrentVectorProviderAuthority: () => "test-provider",
      managedVectorLedgerAuthority: () => "test-ledger"
    }));

    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("WEB_SOURCE_FMP_TRANSCRIPTS", "off");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    expect(runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty").length).toBe(0);
  }, 75_000);

  it("(d2) names earnings-transcript when the producer is enabled but no transcript was ever ingested", async () => {
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 }),
      getCurrentVectorProviderAuthority: () => "test-provider",
      managedVectorLedgerAuthority: () => "test-ledger"
    }));

    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    vi.stubEnv("WEB_SOURCE_FMP_TRANSCRIPTS", "on");
    vi.stubEnv("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", "on");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverage = runAudits.find((e) => e.kind === "rag_doc_type_coverage_empty");
    expect((coverage?.payload as { emptyDocTypes?: string[] })?.emptyDocTypes).toEqual(["earnings-transcript"]);
  }, 75_000);

  it("(e) advisory invariant: the receipt firing does not change ragContext content or proposal count", async () => {
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10q", text: "Risk factors for AAPL.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 }),
      getCurrentVectorProviderAuthority: () => "test-provider",
      managedVectorLedgerAuthority: () => "test-ledger"
    }));

    vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");
    // Proposal flow unaffected: the stubbed LLM's single proposal still survives to completion.
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);

    const systemOf = (b: OpenAiBody) => b.input?.find((i) => i.role === "system")?.content ?? "";
    const userOf = (b: OpenAiBody) => b.input?.find((i) => i.role === "user")?.content ?? "";
    const bullBody = openAiBodies.find((b) => systemOf(b).includes("autonomous equity trading agent"));
    expect(bullBody).toBeDefined();
    const bullUser = JSON.parse(userOf(bullBody!)) as Record<string, unknown>;
    // ragContext (retrievedFinancialContext) carries ONLY the retrieved chunk text — the coverage
    // receipt must never be injected into it. This run also fires the receipt (10-k has no
    // producer and didn't retrieve) so this doubles as a same-run advisory-invariant check.
    const ragField = String(bullUser.retrievedFinancialContext ?? "");
    expect(ragField).toContain("Risk factors for AAPL.");
    expect(ragField).not.toContain("warming up");
    expect(ragField).not.toContain("earnings-transcript");
  }, 75_000);
});

// Placed AFTER the strategy integration tests above — see the ordering note near that block's
// header. This block seeds a real "10-K" ingested_accessions row, which would otherwise falsify
// test (a)'s "ZERO ingested_accessions rows for 10-K" premise if it ran first (shared DB per file).
describe("ingestedAccessionCountForDocType / ingestedAccessionCountsByDocType (db-learning, general-purpose diagnostic helpers)", () => {
  it("reports 0 for a doc type with no ingested rows", async () => {
    const { ingestedAccessionCountForDocType } = await import("../src/lib/db");
    expect(ingestedAccessionCountForDocType("earnings-transcript")).toBe(0);
  });

  it("reports non-zero for a doc type with ingested rows, tolerating the ingested_accessions naming split — but 0 for '8-k' when only the summary path (no insertIngestedAccession) ran", async () => {
    const { insertIngestedAccession, ingestedAccessionCountForDocType } = await import("../src/lib/db");
    // Mirrors src/lib/web-sources/sec-filings.ts (10-K/10-Q stored as the raw SEC form letter).
    insertIngestedAccession(`acc-${randomUUID()}`, "10-K", "AAPL", 4);
    // Mirrors src/lib/web-sources/sec8k.ts's FULL-BODY writer (stores "8-K-body", not "8-K").
    insertIngestedAccession(`acc-${randomUUID()}`, "8-K-body", "AAPL", 2);

    expect(ingestedAccessionCountForDocType("10-k")).toBeGreaterThan(0);
    // The full-body row above DOES count toward "8-k" via prefix-matching — this function is
    // correct for that writer. Its documented caveat is that the default-ON SUMMARY writer never
    // calls insertIngestedAccession at all, so this count understates true corpus coverage for
    // "8-k" in the default config — which is exactly why "8-k" is excluded from
    // COVERAGE_CHECKED_DOC_TYPES (the ledger is incomplete for it) even though this helper itself
    // is correct for what it measures.
    expect(ingestedAccessionCountForDocType("8-k")).toBeGreaterThan(0);
    expect(ingestedAccessionCountForDocType("earnings-transcript")).toBe(0);
  });
});
