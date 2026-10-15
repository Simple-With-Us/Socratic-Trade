import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Exposure surface of the PUBLIC /api/health probe (middleware PUBLIC_PREFIXES). The route emits a
// full operator view only to a caller presenting the ops token; everyone else gets the same payload
// minus operator-only items (OpenRouter USD figures, host/DB byte counts, the lease owner's pid,
// and per-dependency `lastFailure` / `failureClass` from ST-3988). These tests pin BOTH halves:
// that the sensitive values are absent anonymously, and that they are still there behind the token
// — i.e. that this is a projection, not a deletion.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-health-exposure-${randomUUID()}.db`)}`;
});

const OPS_TOKEN = "health-exposure-ops-token";
const HEALTH_URL = "http://localhost/api/health";
// A lease owner in the real `${process.pid}:${randomUUID()}` shape (scheduler-lease.ts) so the
// anonymous view's pid-stripping is actually exercised rather than trivially satisfied.
const LEASE_PID = "424242";
const LEASE_UUID = "0c7f5b2a-1111-4222-8333-444455556666";
const LEASE_OWNER = `${LEASE_PID}:${LEASE_UUID}`;

async function load() {
  const db = await import("../src/lib/db");
  const lease = await import("../src/lib/scheduler-lease");
  const credits = await import("../src/lib/openrouter-credits");
  const healthRoute = await import("../app/api/health/route");
  return { db, lease, credits, healthRoute };
}

// `checks.dependencies` arrives from the route via `Response.json()`, so it is untrusted boundary
// data. Validate it at the boundary instead of casting (Kody Rules 19 / 31).
const healthDependencyEntrySchema = z
  .object({
    ok: z.boolean(),
    degraded: z.boolean().optional(),
    lastFailure: z.string().nullable().optional(),
    failureClass: z.string().nullable().optional()
  })
  .passthrough();

const healthDependenciesSchema = z.record(z.string(), healthDependencyEntrySchema).optional();

type HealthDependencyEntry = z.infer<typeof healthDependencyEntrySchema>;
type HealthDependencies = Record<string, HealthDependencyEntry>;

/** Untrusted JSON from `Response.json()` — parse before any dependency comparison. */
function parseHealthDependenciesFromJson(raw: unknown): HealthDependencies {
  const parsed = healthDependenciesSchema.parse(raw);
  return parsed ?? {};
}

/** Mirrors `projectHealthPayload` dependency stripping for anonymous /api/health. */
function dependenciesWithoutOpsDetail(dependencies: HealthDependencies | undefined): HealthDependencies {
  if (!dependencies) return {};
  const stripped: HealthDependencies = {};
  for (const [name, entry] of Object.entries(dependencies)) {
    const copy = { ...entry };
    delete copy.lastFailure;
    delete copy.failureClass;
    stripped[name] = copy;
  }
  return stripped;
}

/** Stub the OpenRouter /credits fetch so the balance block is populated deterministically. */
function stubCredits(totalCredits: number, totalUsage: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: { total_credits: totalCredits, total_usage: totalUsage } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    )
  );
}

async function seed(healthy = true) {
  const { db, lease, credits } = await load();
  credits.__resetOpenRouterCreditCache();
  db.getDb().prepare("DELETE FROM settings").run();
  db.getDb().prepare("DELETE FROM api_health_log").run();
  db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
  lease.acquireLease(LEASE_OWNER, 60_000);
  db.upsertUserApiKey("local", "openrouter", "or-test-key");
  if (healthy) db.logApiHealth({ service: "pinecone", ok: true, keySource: "env" });
}

describe("/api/health exposure", () => {
  beforeEach(async () => {
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    delete process.env.ADMIN_REINDEX_TOKEN;
    stubCredits(100, 40); // remaining $60, comfortably above the default $3 threshold
    await seed();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    delete process.env.ADMIN_REINDEX_TOKEN;
    const { db, credits } = await load();
    credits.__resetOpenRouterCreditCache();
    try {
      db.deleteUserApiKey("local", "openrouter");
    } catch {
      /* best-effort */
    }
  });

  it("withholds the USD balance, host byte counts and the lease owner's pid from an anonymous caller", async () => {
    const { healthRoute } = await load();
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw);

    // The low-balance boolean IS the alert an external monitor watches; the dollars are not.
    expect(body.checks.openrouterCredits.ok).toBe(true);
    expect(body.checks.openrouterCredits).not.toHaveProperty("remainingUsd");
    expect(body.checks.openrouterCredits).not.toHaveProperty("totalUsd");
    expect(body.checks.openrouterCredits).not.toHaveProperty("usedUsd");
    expect(raw).not.toMatch(/remainingUsd|totalUsd|usedUsd/);

    for (const key of ["dbSizeBytes", "walSizeBytes", "freeBytes", "totalBytes"]) {
      expect(body.checks.storage).not.toHaveProperty(key);
    }

    expect(body.checks.schedulerLease.owner).toBe(LEASE_UUID);
    expect(raw).not.toContain(LEASE_OWNER);
  });

  it("keeps every public liveness signal an uptime probe and the deploy-verify runbook read", async () => {
    const { healthRoute } = await load();
    const response = await healthRoute.GET(new Request(HEALTH_URL));
    const body = await response.json();

    // release.sha is a commit id of a public repo and is what a deploy verifier compares against
    // origin/main — it stays readable without a token.
    expect(body.checks).toHaveProperty("release");
    expect(body.checks.release).toHaveProperty("sha");
    expect(body.checks.db).toBe("ok");
    expect(typeof body.checks.schedulerAgeSeconds).toBe("number");
    expect(body.checks.schedulerStale).toBe(false);
    expect(typeof body.checks.tradingLiveness.degraded).toBe("number");
    expect(body.checks.tradingLivenessDegraded).toBe(false);
    expect(typeof body.checks.storage.litestreamTiersDegraded).toBe("boolean");
    // .claude/skills/deploy-verify/SKILL.md greps exactly these litestream fields with no token.
    for (const key of ["litestreamAgeSeconds", "litestreamState", "litestreamStatus", "litestreamDegradedReasons"]) {
      expect(body.checks.storage).toHaveProperty(key);
    }
    // Weekly R2 cold snapshot (second-provider DR) — public so UM fleet backup can read it.
    // Object key + age only; never credentials, bucket, or endpoint.
    const r2Weekly = body.checks.storage.r2Weekly;
    expect(r2Weekly).toEqual(
      expect.objectContaining({
        ok: expect.any(Boolean),
      }),
    );
    expect(r2Weekly).toHaveProperty("ageSeconds");
    expect(r2Weekly).toHaveProperty("key");
    expect(r2Weekly).toHaveProperty("reason");
    // Fresh test DB has never run a snapshot → archive_not_run; still must not 503.
    expect(typeof r2Weekly.ok).toBe("boolean");
    expect(r2Weekly.ok === true || r2Weekly.reason === "archive_not_run" || r2Weekly.reason === "archive_stale").toBe(
      true,
    );
    expect(body.checks.dependencies.pinecone.ok).toBe(true);
    // Lease timing stays public — only the owner string is redacted.
    expect(typeof body.checks.schedulerLease.ageSeconds).toBe("number");
    expect(body.checks.schedulerLease.expired).toBe(false);
  });

  it("returns the full detail to a caller presenting a valid x-ops-token", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
    const { healthRoute } = await load();
    const response = await healthRoute.GET(
      new Request(HEALTH_URL, { headers: { "x-ops-token": OPS_TOKEN } })
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.checks.openrouterCredits.remainingUsd).toBe(60);
    expect(body.checks.openrouterCredits.totalUsd).toBe(100);
    expect(body.checks.openrouterCredits.usedUsd).toBe(40);
    expect(typeof body.checks.storage.dbSizeBytes).toBe("number");
    expect(typeof body.checks.storage.freeBytes).toBe("number");
    expect(typeof body.checks.storage.totalBytes).toBe("number");
    expect(body.checks.schedulerLease.owner).toBe(LEASE_OWNER);
  });

  it("treats a wrong token, and a correct token while none is configured, as anonymous", async () => {
    const { healthRoute } = await load();

    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
    const wrong = await healthRoute.GET(
      new Request(HEALTH_URL, { headers: { "x-ops-token": "not-the-token" } })
    );
    expect((await wrong.json()).checks.storage).not.toHaveProperty("freeBytes");

    // Fail-closed shape of authorizeOpsRequest: with no secret configured, NOBODY gets detail.
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    const unconfigured = await healthRoute.GET(
      new Request(HEALTH_URL, { headers: { "x-ops-token": OPS_TOKEN } })
    );
    expect((await unconfigured.json()).checks.storage).not.toHaveProperty("freeBytes");
  });

  it("keeps the Uptime Robot low-balance keyword intact in the anonymous view", async () => {
    // The external keyword monitor matches the literal substring `"openrouterCredits":{"ok":false`
    // (docs/rollouts/2026-07-18-openrouter-credit-health-signal.md) — dropping the USD fields must
    // not disturb it, so `ok` has to remain the first serialized key.
    stubCredits(10, 9.5); // remaining $0.50, below the default $3 threshold
    const { credits, healthRoute } = await load();
    credits.__resetOpenRouterCreditCache();

    const response = await healthRoute.GET(new Request(HEALTH_URL));
    const raw = await response.text();
    expect(raw).toContain('"openrouterCredits":{"ok":false');
    // A drained balance DEGRADES, it never 503s — a restart cannot refill credits.
    expect(response.status).toBe(200);
    expect(JSON.parse(raw).checks.dependencies.openrouter.ok).toBe(false);
  });

  it("computes ok and the 503 status identically in both views", async () => {
    const { db, healthRoute } = await load();
    // A hard-stopped critical dependency (>=5 consecutive global failures) is the 503 path.
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Global Error", keySource: "env" });
    }
    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;

    const anonymous = await healthRoute.GET(new Request(HEALTH_URL));
    const detailed = await healthRoute.GET(
      new Request(HEALTH_URL, { headers: { "x-ops-token": OPS_TOKEN } })
    );

    expect(anonymous.status).toBe(503);
    expect(detailed.status).toBe(503);
    const [anonBody, detailBody] = [await anonymous.json(), await detailed.json()];
    expect(anonBody.ok).toBe(false);
    expect(detailBody.ok).toBe(false);
    const detailDeps = parseHealthDependenciesFromJson(detailBody.checks.dependencies);
    const anonDeps = parseHealthDependenciesFromJson(anonBody.checks.dependencies);
    expect(anonDeps).toEqual(dependenciesWithoutOpsDetail(detailDeps));
    expect(detailDeps.pinecone).toMatchObject({
      ok: false,
      lastFailure: "Global Error",
      failureClass: null
    });
    expect(anonDeps.pinecone).toEqual({ ok: false });
    expect(anonBody.checks.storageDegraded).toEqual(detailBody.checks.storageDegraded);
  });
});
