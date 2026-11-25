/** ST-4676 — web console P0 fixes.
 *
 *  This repo's vitest setup is node-only: no jsdom, no testing-library, no
 *  react-test-renderer (see test/console-context-split.test.tsx for the same
 *  constraint). So these tests use the established patterns:
 *   - `renderToStaticMarkup` for components that render without effects (the
 *     admin gate, the exposure review link, the RagItem disclosure);
 *   - a capture harness that renders a hook inside its real providers and then
 *     invokes the returned function against stubbed fetch/window (the guarded
 *     account switch);
 *   - source-wiring assertions for effect-driven behaviour that cannot run under
 *     static render (the drawer's close-on-pathname effect, the watchlist 401
 *     redirect, the strategy admin gate). The wiring asserted IS the contract
 *     the browser applies. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSnapshot } from "../app/dashboard-types";
import type { PendingProposal, SocraticRagAttribution } from "../src/lib/types";
import { ConsoleStore, initialConsoleState } from "../app/console/lib/console-store";
import { ConsoleStoreContext } from "../app/console/lib/useConsoleData";
import { DirtyGuardProvider } from "../app/console/lib/useDirtyGuard";
import { ToastProvider } from "../app/console/ui/toast";
import { useGuardedAccountSwitch } from "../app/console/lib/use-account-switch";
import LessonsPage from "../app/console/lessons/page";
import { ExposureSection } from "../app/console/ui/drilldown-sections";
import { SymbolDrawerProvider } from "../app/console/ui/symbol-drawer";
import { RagItem } from "../app/console/decisions/[id]/page";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

// ── Item 1: admin-only operator panels ───────────────────────────────────────

function lessonsStore(snapshot: DashboardSnapshot | null): ConsoleStore {
  return new ConsoleStore({ ...initialConsoleState(), snapshot });
}

function userSnapshot(isAdmin: boolean): DashboardSnapshot {
  return { currentUser: { isAdmin } } as unknown as DashboardSnapshot;
}

// LessonsPage's children (LearnedContextInbox / LearnedFactsArchive) read the console
// store and the toast context, so render inside the same providers the shell supplies.
function renderLessons(store: ConsoleStore): string {
  return renderToStaticMarkup(
    <ConsoleStoreContext.Provider value={store}>
      <DirtyGuardProvider>
        <ToastProvider>
          <LessonsPage />
        </ToastProvider>
      </DirtyGuardProvider>
    </ConsoleStoreContext.Provider>
  );
}

describe("ST-4676 item 1 — admin-only operator panels", () => {
  it("renders the Learning Ledger for an admin", () => {
    expect(renderLessons(lessonsStore(userSnapshot(true)))).toContain("Learning Ledger");
  });

  it("hides the Learning Ledger for a non-admin (no panel, so no mount fetch / 403)", () => {
    const html = renderLessons(lessonsStore(userSnapshot(false)));
    expect(html).not.toContain("Learning Ledger");
    expect(html).toContain("Lessons"); // the page itself still renders
  });

  it("hides the Learning Ledger while the snapshot has not loaded", () => {
    expect(renderLessons(lessonsStore(null))).not.toContain("Learning Ledger");
  });

  it("gates the ledger on isAdmin and keeps the admin fetch inside the gated panel's mount effect", () => {
    const page = read("app/console/lessons/page.tsx");
    expect(page).toContain("currentUser?.isAdmin");
    expect(page).toContain("{isAdmin && (");
    expect(page).toContain("<LearningLedgerPanel />");
    // The guaranteed-403 fetch lives in the panel's mount effect, so gating the
    // mount is what stops a non-admin Lessons load from firing it.
    const panel = read("app/console/lessons/learning-ledger.tsx");
    expect(panel).toContain("fetchLearningLedger");
    expect(panel).toMatch(/useEffect\(\(\) => \{\s*void load\(\);/);
  });

  it("gates the strategy Weight Tuning Preview (and its /admin/backtest-ic link) on isAdmin", () => {
    const strategy = read("app/console/strategy/page.tsx");
    expect(strategy).toContain("snapshot.currentUser?.isAdmin && (");
    expect(strategy).toContain("<TuningDryRunPanel />");
    // The admin diagnostic link lives inside the now-gated panel.
    expect(read("app/console/strategy/tuning-dry-run.tsx")).toContain('href="/admin/backtest-ic"');
  });
});

// ── Item 3: peer-account switch goes through the guarded path ────────────────

function captureGuardedSwitch(): (id: string) => Promise<void> {
  let captured: ((id: string) => Promise<void>) | null = null;
  function Harness() {
    captured = useGuardedAccountSwitch();
    return null;
  }
  renderToStaticMarkup(
    <DirtyGuardProvider>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </DirtyGuardProvider>
  );
  if (!captured) throw new Error("hook did not run");
  return captured;
}

function stubWindow() {
  const win = {
    location: { pathname: "/console", search: "", hash: "", href: "", reload: vi.fn() },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn()
  };
  vi.stubGlobal("window", win);
  return win;
}

describe("ST-4676 item 3 — guarded account switch", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("activates then reloads the page on a successful switch", async () => {
    const win = stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
      )
    );
    const switchTo = captureGuardedSwitch();
    await switchTo("acc-1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/connected-accounts/acc-1/activate",
      expect.objectContaining({ method: "POST" })
    );
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("rethrows and does NOT reload when activation fails (feedback stays with the caller)", async () => {
    const win = stubWindow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const switchTo = captureGuardedSwitch();
    await expect(switchTo("acc-2")).rejects.toBeTruthy();
    expect(win.location.reload).not.toHaveBeenCalled();
  });

  it("wires the drawer's peer switch through the dirty guard + guarded hook, not a bare activateAccount", () => {
    const drilldown = read("app/console/ui/symbol-drilldown.tsx");
    expect(drilldown).toContain("useGuardedAccountSwitch");
    expect(drilldown).toContain("useDirtyActionGuard");
    expect(drilldown).toContain("guardAction(() => void guardedSwitch(accountId))");
    // The old unguarded path is gone from the drilldown.
    expect(drilldown).not.toMatch(/import \{[^}]*activateAccount[^}]*\} from "\.\.\/lib\/api"/);
    expect(drilldown).not.toContain("void activateAccount(accountId)");
  });

  it("the shared hook keeps the header's error toast and reload rationale", () => {
    const hook = read("app/console/lib/use-account-switch.ts");
    expect(hook).toContain("activateAccount(id)");
    expect(hook).toContain("allowNextUnload()");
    expect(hook).toContain("window.location.reload()");
    expect(hook).toContain('toast.push("neg", "Could not load account"');
    // The header scope selector reuses the same hook.
    expect(read("app/console/components/chrome.tsx")).toContain("useGuardedAccountSwitch");
  });
});

// ── Item 4a: exposure review link carries the proposal id ────────────────────

describe("ST-4676 item 4a — approvals deep link", () => {
  it("links the pending idea's Review affordance to /console/approvals?proposal=<id>", () => {
    const pending = {
      id: "prop-1",
      createdAt: new Date().toISOString(),
      proposal: {
        side: "buy",
        rationale: "Momentum thesis",
        quantity: 10,
        tradeThesisTag: "quality_momentum",
        confidenceScore: 80
      }
    } as unknown as PendingProposal;
    const html = renderToStaticMarkup(
      <ExposureSection symbol="NVDA" pending={[pending]} orders={[]} />
    );
    expect(html).toContain('href="/console/approvals?proposal=prop-1"');
    expect(html).not.toContain('href="/console/approvals"');
  });
});

// ── Item 4b: all_openings trigger label ──────────────────────────────────────

describe("ST-4676 item 4b — all_openings trigger label", () => {
  it("names all_openings a 'risk-adding opening', matching the approval card", () => {
    const decisions = read("app/console/decisions/[id]/page.tsx");
    expect(decisions).toContain('if (trigger === "all_openings") return "risk-adding opening";');
    const card = read("app/console/components/approval-card.tsx");
    expect(card).toContain('case "all_openings":');
    expect(card).toContain('label: "risk-adding opening"');
  });
});

// ── Item 5: drawer closes on navigation ──────────────────────────────────────

describe("ST-4676 item 5 — drawer closes on pathname change", () => {
  it("subscribes to the pathname and clears the drawer content when it changes", () => {
    const drawer = read("app/console/ui/symbol-drawer.tsx");
    expect(drawer).toContain('import { usePathname } from "next/navigation";');
    expect(drawer).toContain("const pathname = usePathname();");
    expect(drawer).toMatch(/useEffect\(\(\) => \{\s*setContent\(null\);\s*\}, \[pathname\]\);/);
  });

  it("still renders its children (the provider adds no DOM around the route)", () => {
    const html = renderToStaticMarkup(
      <SymbolDrawerProvider>
        <div>route body</div>
      </SymbolDrawerProvider>
    );
    expect(html).toContain("route body");
    expect(html).not.toContain("con-drawer");
  });
});

// ── Item 6: watchlist 401 redirects to login ─────────────────────────────────

describe("ST-4676 item 6 — watchlist 401 fail-closed", () => {
  it("routes a 401 through the shared redirectToLogin for reads AND every mutation", () => {
    const watchlist = read("app/console/watchlist/page.tsx");
    expect(watchlist).toContain('import { redirectToLogin } from "../lib/api";');
    // Both reads in refresh().
    expect(watchlist).toContain("if (wlRes.status === 401) redirectToLogin();");
    expect(watchlist).toContain("if (alRes.status === 401) redirectToLogin();");
    // All four mutations (add/remove symbol, create/remove alert) share the guard.
    const mutationGuards = watchlist.match(/if \(res\.status === 401\) redirectToLogin\(\);/g) ?? [];
    expect(mutationGuards.length).toBe(4);
  });
});

// ── Item 11: RagItem raw-chunk disclosure ────────────────────────────────────

describe("ST-4676 item 11 — RagItem Raw Chunk expander", () => {
  const item: SocraticRagAttribution = {
    symbol: "NVDA",
    text: "Full retrieved chunk text about NVDA data-center margins.",
    contribution: "Short contribution.",
    chunkId: "chunk-abc",
    source: "sec",
    docType: "10-K",
    title: "NVDA 10-K"
  };

  it("shows the contribution and a Raw Chunk disclosure carrying the full text + chunk id", () => {
    const html = renderToStaticMarkup(<RagItem item={item} />);
    expect(html).toContain("Short contribution.");
    expect(html).toContain("<details");
    expect(html).toContain("Raw Chunk");
    expect(html).toContain("Full retrieved chunk text about NVDA data-center margins.");
    expect(html).toContain("Chunk chunk-abc");
  });

  it("omits the disclosure when there is no chunk text", () => {
    const html = renderToStaticMarkup(<RagItem item={{ ...item, text: "", contribution: "Only contribution." }} />);
    expect(html).toContain("Only contribution.");
    expect(html).not.toContain("Raw Chunk");
  });
});