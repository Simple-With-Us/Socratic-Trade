/**
 * ST-4689 (web batch 2): the dashboard `fields=` slice, consent in the dashboard
 * payload, the three early-render console routes, and the single-tree Orders /
 * Watchlist / Positions surfaces.
 *
 * The pure slice rules and the consent reader get behavioural tests; the wiring
 * that only exists inside a React tree or a route module is pinned with source
 * assertions, matching this repo's node-only vitest patterns (no jsdom).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_SLICE_ALWAYS_INCLUDED,
  DASHBOARD_SNAPSHOT_FIELDS,
  parseDashboardFields,
  sliceDashboardSnapshot,
  type DashboardSnapshotField
} from "../app/dashboard-slice";
import type { DashboardSnapshot } from "../app/dashboard-types";

const ROOT = process.cwd();

// The route module is imported for its 400 path only; keep its heavy upstreams inert,
// matching test/dashboard-coalesce.test.ts (next-auth's ESM-only next/server import
// does not resolve under vitest without this).
vi.mock("../src/lib/auth/auth", () => ({ auth: async () => null }));
vi.mock("../src/lib/dashboard", () => ({
  getDashboardSnapshot: vi.fn(async () => ({ partialData: false }))
}));

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// Kody 68SUSf (rule 33): capture the caller's DATABASE_URL before overriding it, so the
// suite leaves the environment exactly as it found it (deleted when it was unset).
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-web-batch-2-${randomUUID()}.db`)}`;
});

afterAll(() => {
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

describe("GET /api/dashboard fields= slice", () => {
  it("returns the whole snapshot when no fields parameter is present", () => {
    expect(parseDashboardFields(null)).toEqual({ fields: null, unknown: [] });
    expect(parseDashboardFields([])).toEqual({ fields: null, unknown: [] });
    expect(parseDashboardFields(["   "])).toEqual({ fields: null, unknown: [] });
    expect(parseDashboardFields([" , "])).toEqual({ fields: null, unknown: [] });
  });

  it("accepts one comma list, repeated parameters, and a mix of both", () => {
    const comma = parseDashboardFields(["positions,orders"]);
    expect(comma.unknown).toEqual([]);
    expect([...(comma.fields ?? [])].sort()).toEqual(["orders", "positions"]);

    const repeated = parseDashboardFields(["positions", "orders"]);
    expect([...(repeated.fields ?? [])].sort()).toEqual(["orders", "positions"]);

    const mixed = parseDashboardFields(["positions", "orders, policy "]);
    expect([...(mixed.fields ?? [])].sort()).toEqual(["orders", "policy", "positions"]);
  });

  it("reports unknown names instead of silently dropping them", () => {
    const allUnknown = parseDashboardFields(["nope,Bogus"]);
    expect(allUnknown.fields).toBeNull();
    expect(allUnknown.unknown).toEqual(["Bogus", "nope"]);

    const partial = parseDashboardFields(["positions,nope"]);
    expect([...(partial.fields ?? [])]).toEqual(["positions"]);
    expect(partial.unknown).toEqual(["nope"]);
  });

  it("slices to the requested fields plus the always-included correctness flags", () => {
    const consent = { needsConsent: false } as DashboardSnapshot["consent"];
    const snapshot = {
      partialData: true,
      partialReason: "broker timed out",
      policy: { systemState: "active" },
      positions: [{ symbol: "AAA" }],
      orders: [{ id: "o1" }],
      latestScan: { source: "test" },
      consent
    } as unknown as DashboardSnapshot;

    const sliced = sliceDashboardSnapshot(snapshot, new Set<DashboardSnapshotField>(["positions"]));
    expect(sliced.positions).toEqual([{ symbol: "AAA" }]);
    expect(sliced.partialData).toBe(true);
    expect(sliced.partialReason).toBe("broker timed out");
    expect(sliced.consent).toBe(consent);
    expect(sliced.orders).toBeUndefined();
    expect(sliced.latestScan).toBeUndefined();
    expect(sliced.policy).toBeUndefined();
    for (const field of DASHBOARD_SLICE_ALWAYS_INCLUDED) {
      expect(Object.keys(sliced)).toContain(field);
    }
  });

  it("keeps an absent partialData explicit and an absent consent absent", () => {
    const snapshot = { positions: [] } as unknown as DashboardSnapshot;
    const sliced = sliceDashboardSnapshot(snapshot, new Set<DashboardSnapshotField>(["positions"]));
    expect(sliced.partialData).toBe(false);
    // Consent is never fabricated: a snapshot that predates the field stays without it,
    // and the console falls back to its own two GETs.
    expect("consent" in sliced).toBe(false);
  });

  it("lists every DashboardSnapshot field (compile-time completeness guard, spot-checked here)", () => {
    expect(DASHBOARD_SNAPSHOT_FIELDS).toContain("consent");
    expect(DASHBOARD_SNAPSHOT_FIELDS).toContain("positions");
    expect(DASHBOARD_SNAPSHOT_FIELDS).toContain("socratic");
    expect(new Set(DASHBOARD_SNAPSHOT_FIELDS).size).toBe(DASHBOARD_SNAPSHOT_FIELDS.length);
  });

  it("answers 400 for an unknown field before any snapshot work", async () => {
    const { GET } = await import("../app/api/dashboard/route");
    const response = await GET(new Request("https://socratictrade.com/api/dashboard?fields=positions,nope"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; allowed: readonly string[] };
    expect(body.error).toContain("nope");
    expect(body.allowed).toContain("positions");
  });

  it("wires the slice and the fresh consent merge into the route source", () => {
    const route = read("app/api/dashboard/route.ts");
    expect(route).toContain("parseDashboardFields");
    expect(route).toContain("sliceDashboardSnapshot");
    expect(route).toContain("buildDashboardConsent");
    // Consent must be merged AFTER the coalesced read (freshness), not inside it.
    expect(route.indexOf("coalesceUserDashboardSnapshot")).toBeLessThan(route.indexOf("buildDashboardConsent(user.userId)"));
  });
});

describe("consent in the dashboard payload", () => {
  it("builds a secret-free record and flips after both accepts", async () => {
    const { buildDashboardConsent } = await import("../src/lib/dashboard-consent");
    const { LEGAL_NOTICE_VERSION } = await import("../src/lib/legal-notice");
    const { DATA_POOL_CONSENT_VERSION } = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;

    const before = buildDashboardConsent(userId);
    expect(before.needsConsent).toBe(true);
    expect(before.legal).toEqual({ accepted: false, acceptedAt: null, version: 0 });
    expect(before.dataPool).toEqual({ accepted: false, acceptedAt: null, version: 0 });
    expect(before.legalVersion).toBe(LEGAL_NOTICE_VERSION);
    expect(before.dataPoolVersion).toBe(DATA_POOL_CONSENT_VERSION);
    // Only these five top-level keys — no user id, no token, no email.
    expect(Object.keys(before).sort()).toEqual([
      "dataPool",
      "dataPoolVersion",
      "legal",
      "legalVersion",
      "needsConsent"
    ]);

    const { setDataPoolConsent, setLegalNoticeConsent } = await import("../src/lib/db");
    setLegalNoticeConsent(userId, true);
    // The combined gate stays closed until BOTH accepts are at the current version.
    expect(buildDashboardConsent(userId).needsConsent).toBe(true);
    setDataPoolConsent(userId, true);
    const after = buildDashboardConsent(userId);
    expect(after.needsConsent).toBe(false);
    expect(after.legal.accepted).toBe(true);
    expect(after.dataPool.accepted).toBe(true);
    expect(after.legal.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("the gate reads the snapshot copy and only fetches when it is absent", () => {
    const gate = read("app/console/components/consent-gate.tsx");
    expect(gate).toContain("useConsoleSnapshotOptional()?.consent");
    expect(gate).toContain("if (consent) return;");
    expect(gate).toContain('fetch("/api/legal-notice"');
    expect(gate).toContain('fetch("/api/consent"');
    // A local accept must close the gate even while a cached payload still says otherwise.
    expect(gate).toContain("accepted ? false : consent ? consent.needsConsent");
  });

  it("blocks while the consent state is unresolved (Kody 68SUDT)", () => {
    const gate = read("app/console/components/consent-gate.tsx");
    // Only a definitive false lets the console render; null keeps the blocking shell up.
    expect(gate).toContain("if (needsConsent === false) return null;");
    expect(gate).toContain("const checking = needsConsent === null;");
    expect(gate).toContain("useFocusTrap(dialogRef, needsConsent !== false, { blocking: true });");
    expect(gate).toContain("useOverlay(overlayId, needsConsent !== false");
    expect(gate).toContain("aria-busy={checking || undefined}");
    expect(gate).toContain("Checking your consent status…");
    // The gate never returns null while unresolved.
    expect(gate).not.toContain("if (needsConsent !== true) return null;");
  });
});

describe("early-render console routes", () => {
  it("adds watchlist as snapshot-independent and lessons/decisions as self-skeleton", () => {
    const shell = read("app/console/components/shell.tsx");
    const independent = /const SNAPSHOT_INDEPENDENT_ROUTES = new Set\(\[([^\]]*)\]\)/.exec(shell)?.[1] ?? "";
    expect(independent).toContain('"/console/watchlist"');
    expect(independent).not.toContain('"/console/lessons"');

    const selfSkeleton = /const SELF_SKELETON_ROUTES = new Set\(\[([^\]]*)\]\)/.exec(shell)?.[1] ?? "";
    expect(selfSkeleton).toContain('"/console/lessons"');
    expect(selfSkeleton).toContain('"/console/decisions"');
    expect(selfSkeleton).toContain('"/console/connections"');
  });

  it("does not claim an empty framework-proposal queue while the snapshot is absent", () => {
    const panel = read("app/console/lessons/framework-proposals.tsx");
    expect(panel).toContain("const snapshotPending = snapshot === null;");
    expect(panel).toContain("Waiting for the dashboard snapshot to list framework proposals.");
  });

  it("surfaces the snapshot error with a retry instead of waiting forever (Kody 68SUIj)", () => {
    const panel = read("app/console/lessons/framework-proposals.tsx");
    expect(panel).toContain("useConsoleDataOptional()");
    expect(panel).toContain("const fetchError = consoleData?.error ?? null;");
    expect(panel).toContain("snapshotPending && fetchError");
    expect(panel).toContain("Framework proposals could not load because the dashboard snapshot failed.");
    expect(panel).toContain("onClick={() => void refresh()}");
    expect(panel).toContain("Retry");
  });
});

describe("Orders / Watchlist / Positions single trees (W20)", () => {
  const surfaces = [
    {
      path: "app/console/orders/page.tsx",
      components: ["function OpenOrderRow(", "function FinishedOrderRow("],
      calls: ["<OpenOrderRow\n", "<FinishedOrderRow\n"]
    },
    {
      path: "app/console/watchlist/page.tsx",
      components: ["function WatchlistRow("],
      calls: ["<WatchlistRow\n"]
    },
    {
      path: "app/console/components/positions.tsx",
      components: ["function PositionRow(", "function OptionPositionRow("],
      calls: ["<PositionRow", "<OptionPositionRow"]
    }
  ];

  for (const surface of surfaces) {
    it(`${surface.path} defines one component per row kind and gates the mount`, () => {
      const source = read(surface.path);
      for (const component of surface.components) {
        expect(source.split(component).length - 1).toBe(1);
      }
      for (const call of surface.calls) {
        // One table call site + one card call site per row kind.
        expect(source.split(call).length - 1).toBe(2);
      }
      expect(source).toContain('layout="table"');
      expect(source).toContain('layout="card"');
      expect(source).toContain("useIsDesktopConsole()");
      // The old CSS twin trick would keep both trees in the DOM.
      expect(source).not.toMatch(/className="[^"]*lg:hidden/);
      expect(source).not.toMatch(/className="hidden [^"]*lg:block/);
    });
  }

  it("re-runs the order deep-link scroll after the breakpoint swap (Kody 68SRKN)", () => {
    const orders = read("app/console/orders/page.tsx");
    expect(orders).toContain(
      "}, [focusedSymbol, firstFocusedOpenId, firstFocusedHistoryId, isDesktop]);"
    );
  });
});

describe("ApprovalCard decision link (W27)", () => {
  it("looks the decision up by proposalId and links only when found", () => {
    const card = read("app/console/components/approval-card.tsx");
    expect(card).toContain("decision.proposalId === pending.id");
    expect(card).toContain("const decisionCase = matchedDecision(snapshot, pending);");
    expect(card).toContain("/console/decisions/${encodeURIComponent(decisionCase.id)}");
    expect(card).toContain("{decisionCase && (");
  });
});
