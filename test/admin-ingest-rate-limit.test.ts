import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminIngestBucketKey, type AdminIngestLimitKind } from "../src/lib/admin-ingest-rate-limit";
import { resetAdminOperationInFlight } from "../src/lib/admin-operation-guard";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";
import { RATE_LIMITS, rateLimit, resetRateLimiter } from "../src/lib/rate-limit";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import * as chatHistory from "../src/lib/chat-history";

const TOKEN = "ingest-rate-limit-test-token";

const mocks = vi.hoisted(() => ({
  startCorpusReembedRun: vi.fn(),
  getCorpusReembedProgress: vi.fn(),
  purgeLegacyEmbeddingSpace: vi.fn(),
  resetCorpusReembedWatermarks: vi.fn(),
  runCorpusReembedDryRun: vi.fn(),
  refreshFilingBodies: vi.fn(),
  getVectorStoreStats: vi.fn(),
  getEightKDataset: vi.fn(),
  reindexEightKDataset: vi.fn(),
  refreshEightK: vi.fn(),
  getCongressDataset: vi.fn(),
  refreshCongress: vi.fn(),
  seedSecIngestJobsFromManifest: vi.fn(),
  requeueSecIngestDeadLetters: vi.fn(),
  reconcileSecIngestJob: vi.fn(),
  getSecIngestJobReceipt: vi.fn(),
  manuallyProbeEarningsCallsEntitlement: vi.fn(),
  clearEarningsCallsEntitlementBlock: vi.fn(),
  earningsCallsEntitlementState: vi.fn(),
  armEarningsCallsBurst: vi.fn(),
  earningsCallsBudgetUsage: vi.fn(),
  earningsCallsBurstMaxTranscripts: vi.fn(),
  earningsCallsBurstPending: vi.fn(),
  earningsCallsLastPicksAudit: vi.fn()
}));

vi.mock("@/lib/rag/corpus-reembed", () => ({
  CORPUS_REEMBED_DOC_TYPES: ["10-K"],
  DEFAULT_CORPUS_REEMBED_DOC_TYPES: ["10-K"],
  getCorpusReembedProgress: mocks.getCorpusReembedProgress,
  purgeLegacyEmbeddingSpace: mocks.purgeLegacyEmbeddingSpace,
  resetCorpusReembedWatermarks: mocks.resetCorpusReembedWatermarks,
  runCorpusReembedDryRun: mocks.runCorpusReembedDryRun,
  startCorpusReembedRun: mocks.startCorpusReembedRun
}));
vi.mock("@/lib/web-sources/sec-filings", () => ({
  refreshFilingBodies: mocks.refreshFilingBodies,
  padCik: (cik: string) => cik
}));
vi.mock("@/lib/vector-db", () => ({ getVectorStoreStats: mocks.getVectorStoreStats }));
vi.mock("@/lib/web-sources/sec8k", () => ({
  getEightKDataset: mocks.getEightKDataset,
  reindexEightKDataset: mocks.reindexEightKDataset,
  refreshEightK: mocks.refreshEightK
}));
vi.mock("@/lib/web-sources/congress", () => ({
  getCongressDataset: mocks.getCongressDataset,
  refreshCongress: mocks.refreshCongress
}));
vi.mock("@/lib/rag/sec-ingest-seeder", () => ({
  seedSecIngestJobsFromManifest: mocks.seedSecIngestJobsFromManifest
}));
vi.mock("@/lib/db-rag-ingest", () => ({
  getSecIngestJobReceipt: mocks.getSecIngestJobReceipt,
  reconcileSecIngestJob: mocks.reconcileSecIngestJob,
  requeueSecIngestDeadLetters: mocks.requeueSecIngestDeadLetters
}));
vi.mock("@/lib/earningscalls-transcripts", () => ({
  armEarningsCallsBurst: mocks.armEarningsCallsBurst,
  clearEarningsCallsEntitlementBlock: mocks.clearEarningsCallsEntitlementBlock,
  earningsCallsBudgetUsage: mocks.earningsCallsBudgetUsage,
  earningsCallsBurstMaxTranscripts: mocks.earningsCallsBurstMaxTranscripts,
  earningsCallsBurstPending: mocks.earningsCallsBurstPending,
  earningsCallsEntitlementState: mocks.earningsCallsEntitlementState,
  earningsCallsLastPicksAudit: mocks.earningsCallsLastPicksAudit,
  manuallyProbeEarningsCallsEntitlement: mocks.manuallyProbeEarningsCallsEntitlement
}));
vi.mock("@/lib/earningscalls-gate", () => ({
  earningsCallsTranscriptsEnabled: () => false
}));

import { GET as reembedGet, POST as reembedPost } from "../app/api/admin/reembed/route";
import { GET as reindexTenKGet, POST as reindexTenKPost } from "../app/api/admin/reindex-10k/route";
import { GET as reindexEightKGet, POST as reindexEightKPost } from "../app/api/admin/reindex-8k/route";
import { GET as secIngestGet, POST as secIngestPost } from "../app/api/admin/sec-ingest/route";
import { POST as refreshWebSourcePost } from "../app/api/admin/refresh-websource/route";
import { GET as earningsCallsGet, POST as earningsCallsPost } from "../app/api/admin/earningscalls/route";
import { GET as transcriptGet } from "../app/api/admin/transcript/route";

const listAllTurns = vi.spyOn(chatHistory, "listAllTurns");

type Auth = { token?: string; email?: string };

function adminRequest(path: string, init: RequestInit, auth: Auth): Request {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (auth.token) headers.set("x-admin-token", auth.token);
  if (auth.email) {
    headers.set(AUTHENTICATED_EMAIL_HEADER, auth.email);
    headers.set(AUTHENTICATED_IDENTITY_SOURCE_HEADER, AUTHENTICATED_IDENTITY_SOURCES.authJsSession);
  }
  return new Request(`https://socratictrade.com${path}`, { ...init, headers });
}

const tokenAuth: Auth = { token: TOKEN };

function saturate(auth: Auth, route: string, kind: AdminIngestLimitKind): void {
  const probe = adminRequest("/api/admin/reembed", { method: "POST" }, auth);
  const key = adminIngestBucketKey(probe, route, kind);
  const options = kind === "job" ? RATE_LIMITS.adminIngest : RATE_LIMITS.adminIngestRead;
  for (let i = 0; i < options.limit; i += 1) {
    expect(rateLimit(key, options).allowed).toBe(true);
  }
}

async function expectLimited(response: Response, spy: { mock: { calls: unknown[] } }): Promise<void> {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  const body = (await response.json()) as { ok: boolean };
  expect(body.ok).toBe(false);
  expect(spy.mock.calls).toHaveLength(0);
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-admin-ingest-rl-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetRateLimiter();
  resetAdminOperationInFlight();
  listAllTurns.mockClear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.startCorpusReembedRun.mockReturnValue({ acquired: true });
  mocks.getCorpusReembedProgress.mockReturnValue({});
  mocks.refreshFilingBodies.mockResolvedValue({ errors: [] });
  mocks.getVectorStoreStats.mockResolvedValue({});
  mocks.getEightKDataset.mockReturnValue(null);
  mocks.reindexEightKDataset.mockResolvedValue({ indexed: 1 });
  mocks.refreshEightK.mockResolvedValue({ ok: true });
  mocks.getCongressDataset.mockReturnValue(null);
  mocks.refreshCongress.mockResolvedValue({ ok: true });
  mocks.seedSecIngestJobsFromManifest.mockResolvedValue({ seeded: 0 });
  mocks.requeueSecIngestDeadLetters.mockReturnValue({ requeued: 0 });
  mocks.getSecIngestJobReceipt.mockReturnValue(null);
  mocks.manuallyProbeEarningsCallsEntitlement.mockResolvedValue({ entitlement: "unknown" });
  mocks.clearEarningsCallsEntitlementBlock.mockReturnValue({ status: "unknown" });
  mocks.earningsCallsEntitlementState.mockReturnValue({ status: "unknown" });
  mocks.armEarningsCallsBurst.mockReturnValue(25);
  mocks.earningsCallsBudgetUsage.mockReturnValue({ used: 0 });
  mocks.earningsCallsBurstMaxTranscripts.mockReturnValue(25);
  mocks.earningsCallsBurstPending.mockReturnValue(0);
  mocks.earningsCallsLastPicksAudit.mockReturnValue(null);
  vi.stubEnv("ADMIN_REINDEX_TOKEN", TOKEN);
  vi.stubEnv("ADMIN_USER_EMAILS", "boss@example.com");
  vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DB_BOOTSTRAP", "");
  vi.stubEnv("CODE_CLI_ENABLED", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimiter();
  resetAdminOperationInFlight();
});

const jobs: Array<{
  name: string;
  route: string;
  run: (auth: Auth) => Promise<Response>;
  spy: () => { mock: { calls: unknown[] } };
}> = [
  {
    name: "reembed POST",
    route: "reembed",
    run: (auth) => reembedPost(adminRequest("/api/admin/reembed", { method: "POST", body: "{}" }, auth)),
    spy: () => mocks.startCorpusReembedRun
  },
  {
    name: "reindex-10k POST",
    route: "reindex-10k",
    run: (auth) => reindexTenKPost(adminRequest("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: ["AAPL"] })
    }, auth)),
    spy: () => mocks.refreshFilingBodies
  },
  {
    name: "reindex-8k POST",
    route: "reindex-8k",
    run: (auth) => reindexEightKPost(adminRequest("/api/admin/reindex-8k", {
      method: "POST",
      body: JSON.stringify({ limit: 1 })
    }, auth)),
    spy: () => mocks.reindexEightKDataset
  },
  {
    name: "sec-ingest seed",
    route: "sec-ingest",
    run: (auth) => secIngestPost(adminRequest("/api/admin/sec-ingest", {
      method: "POST",
      body: JSON.stringify({ action: "seed" })
    }, auth)),
    spy: () => mocks.seedSecIngestJobsFromManifest
  },
  {
    name: "refresh-websource POST",
    route: "refresh-websource",
    run: (auth) => refreshWebSourcePost(adminRequest("/api/admin/refresh-websource", {
      method: "POST",
      body: JSON.stringify({ id: "congress" })
    }, auth)),
    spy: () => mocks.refreshCongress
  },
  {
    name: "earningscalls probe",
    route: "earningscalls",
    run: (auth) => earningsCallsPost(adminRequest("/api/admin/earningscalls", {
      method: "POST",
      body: JSON.stringify({ action: "probe-entitlement" })
    }, auth)),
    spy: () => mocks.manuallyProbeEarningsCallsEntitlement
  }
];

describe("admin ingest jobs", () => {
  for (const job of jobs) {
    it(`${job.name} returns 429 and does not start when the caller is over the limit`, async () => {
      saturate(tokenAuth, job.route, "job");
      const response = await job.run(tokenAuth);
      await expectLimited(response, job.spy());
    });

    it(`${job.name} still starts for an authorized caller under the limit`, async () => {
      const response = await job.run(tokenAuth);
      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(429);
      expect(job.spy().mock.calls.length).toBeGreaterThan(0);
    });

    it(`${job.name} still rejects a caller with no admin credentials`, async () => {
      const response = await job.run({});
      expect(response.status).toBe(403);
      expect(job.spy().mock.calls).toHaveLength(0);
    });
  }

  it("does not spend the job budget on forbidden reembed calls", async () => {
    for (let i = 0; i < RATE_LIMITS.adminIngest.limit + 2; i += 1) {
      const denied = await reembedPost(adminRequest("/api/admin/reembed", { method: "POST", body: "{}" }, {}));
      expect(denied.status).toBe(403);
    }
    const allowed = await reembedPost(adminRequest("/api/admin/reembed", { method: "POST", body: "{}" }, tokenAuth));
    expect(allowed.status).toBe(200);
    expect(mocks.startCorpusReembedRun).toHaveBeenCalledOnce();
  });

  it("keeps an empty 10-K symbol list at 400 and still allows the next real start", async () => {
    const empty = await reindexTenKPost(adminRequest("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: [] })
    }, tokenAuth));
    expect(empty.status).toBe(400);
    expect(mocks.refreshFilingBodies).not.toHaveBeenCalled();

    const started = await reindexTenKPost(adminRequest("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: ["AAPL"] })
    }, tokenAuth));
    expect(started.status).not.toBe(429);
    expect(mocks.refreshFilingBodies).toHaveBeenCalledOnce();
  });

  it("keeps an unknown web-source id at 400 and still allows a congress refresh", async () => {
    const unknown = await refreshWebSourcePost(adminRequest("/api/admin/refresh-websource", {
      method: "POST",
      body: JSON.stringify({ id: "unknown" })
    }, tokenAuth));
    expect(unknown.status).toBe(400);
    expect(mocks.refreshCongress).not.toHaveBeenCalled();
    expect(mocks.refreshEightK).not.toHaveBeenCalled();

    const started = await refreshWebSourcePost(adminRequest("/api/admin/refresh-websource", {
      method: "POST",
      body: JSON.stringify({ id: "congress" })
    }, tokenAuth));
    expect(started.status).not.toBe(429);
    expect(mocks.refreshCongress).toHaveBeenCalledOnce();
  });

  it("sec-ingest requeue over the limit does not requeue dead letters", async () => {
    saturate(tokenAuth, "sec-ingest", "job");
    const response = await secIngestPost(adminRequest("/api/admin/sec-ingest", {
      method: "POST",
      body: JSON.stringify({ action: "requeue-dead-letter" })
    }, tokenAuth));
    await expectLimited(response, mocks.requeueSecIngestDeadLetters);
  });

  it("earningscalls clear-block over the limit does not write entitlement state", async () => {
    saturate(tokenAuth, "earningscalls", "job");
    const response = await earningsCallsPost(adminRequest("/api/admin/earningscalls", {
      method: "POST",
      body: JSON.stringify({ action: "clear-entitlement-block" })
    }, tokenAuth));
    await expectLimited(response, mocks.clearEarningsCallsEntitlementBlock);
  });

  it("reindex-10k in production still requires the token and still accepts it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const emailOnly = await reindexTenKPost(adminRequest("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: ["AAPL"] })
    }, { email: "boss@example.com" }));
    expect(emailOnly.status).toBe(403);
    expect(mocks.refreshFilingBodies).not.toHaveBeenCalled();

    const withToken = await reindexTenKPost(adminRequest("/api/admin/reindex-10k", {
      method: "POST",
      body: JSON.stringify({ symbols: ["AAPL"] })
    }, tokenAuth));
    expect(withToken.status).not.toBe(403);
    expect(withToken.status).not.toBe(429);
    expect(mocks.refreshFilingBodies).toHaveBeenCalledOnce();
  });

  it("refresh-websource in production still accepts a verified admin email without the token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await refreshWebSourcePost(adminRequest("/api/admin/refresh-websource", {
      method: "POST",
      body: JSON.stringify({ id: "congress" })
    }, { email: "boss@example.com" }));
    expect(response.status).toBe(200);
    expect(mocks.refreshCongress).toHaveBeenCalledOnce();
  });

  it("a different admin is not blocked by another caller's ingest burst", async () => {
    saturate(tokenAuth, "reembed", "job");
    const response = await reembedPost(adminRequest("/api/admin/reembed", { method: "POST", body: "{}" }, {
      email: "boss@example.com"
    }));
    expect(response.status).toBe(200);
    expect(mocks.startCorpusReembedRun).toHaveBeenCalledOnce();
  });
});

describe("admin ingest reads", () => {
  it("reembed GET over the read limit does not load progress", async () => {
    saturate(tokenAuth, "reembed", "read");
    const response = await reembedGet(adminRequest("/api/admin/reembed", { method: "GET" }, tokenAuth));
    await expectLimited(response, mocks.getCorpusReembedProgress);
  });

  it("reindex-10k GET over the read limit does not query the vector store", async () => {
    saturate(tokenAuth, "reindex-10k", "read");
    const response = await reindexTenKGet(adminRequest("/api/admin/reindex-10k", { method: "GET" }, tokenAuth));
    await expectLimited(response, mocks.getVectorStoreStats);
  });

  it("reindex-8k GET over the read limit does not load the dataset", async () => {
    saturate(tokenAuth, "reindex-8k", "read");
    const response = await reindexEightKGet(adminRequest("/api/admin/reindex-8k", { method: "GET" }, tokenAuth));
    await expectLimited(response, mocks.getEightKDataset);
  });

  it("sec-ingest GET over the read limit does not reconcile jobs", async () => {
    const { getDb } = await import("../src/lib/db");
    const now = new Date().toISOString();
    const id = `job-${randomUUID()}`;
    getDb().prepare(
      `INSERT INTO sec_ingest_jobs (id, idempotency_key, corpus_revision, status, created_at, updated_at)
       VALUES (?, ?, 'rev', 'pending', ?, ?)`
    ).run(id, `idem-${id}`, now, now);
    saturate(tokenAuth, "sec-ingest", "read");
    const response = await secIngestGet(adminRequest("/api/admin/sec-ingest", { method: "GET" }, tokenAuth));
    await expectLimited(response, mocks.reconcileSecIngestJob);
  });

  it("earningscalls GET over the read limit does not read entitlement state", async () => {
    saturate(tokenAuth, "earningscalls", "read");
    const response = await earningsCallsGet(adminRequest("/api/admin/earningscalls", { method: "GET" }, tokenAuth));
    await expectLimited(response, mocks.earningsCallsEntitlementState);
  });

  it("transcript GET over the read limit does not list turns", async () => {
    saturate({ email: "boss@example.com" }, "transcript", "read");
    const response = await transcriptGet(adminRequest("/api/admin/transcript", { method: "GET" }, {
      email: "boss@example.com"
    }));
    await expectLimited(response, listAllTurns);
  });

  it("transcript GET still returns turns for a verified admin and still rejects everyone else", async () => {
    const denied = await transcriptGet(adminRequest("/api/admin/transcript", { method: "GET" }, {}));
    expect(denied.status).toBe(403);
    expect(listAllTurns).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "production");
    const allowed = await transcriptGet(adminRequest("/api/admin/transcript?limit=10", { method: "GET" }, {
      email: "boss@example.com"
    }));
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { turns: unknown[] };
    expect(Array.isArray(body.turns)).toBe(true);
    expect(listAllTurns).toHaveBeenCalled();
  });

  it("reindex-10k GET under the limit still returns for a valid token", async () => {
    const response = await reindexTenKGet(adminRequest("/api/admin/reindex-10k", { method: "GET" }, tokenAuth));
    expect(response.status).toBe(200);
    expect(mocks.getVectorStoreStats).toHaveBeenCalledOnce();
  });
});
