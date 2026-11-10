import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedAccount, TradingPolicy } from "../src/lib/types";
import type { DashboardSnapshot } from "../app/dashboard-types";

/** per-account-visibility (lifecycle-02, lifecycle-12): Settings > Broker connections used to
 *  chip EVERY non-loaded account "Inactive" and its pending-proposal count 0, regardless of
 *  what that account was actually doing — brokers.tsx only ever derived real state for the
 *  active account (isCurrentLoaded), and its "Other Accounts" pending-proposal filter ran
 *  against snapshot.pendingProposals, an array the server already scopes to the active account
 *  only, so it could never match another account's id. This proves a genuinely running,
 *  genuinely-pending OTHER account now reads honestly instead of "Inactive" / silent zero. */

vi.mock("../app/console/lib/useConsoleData", () => ({
  useConsoleData: () => ({ snapshot: fixtureSnapshot, refresh: vi.fn(async () => {}) })
}));
vi.mock("../app/console/ui/toast", () => ({
  useToast: () => ({ push: vi.fn() })
}));

function account(partial: Partial<ConnectedAccount> & Pick<ConnectedAccount, "id" | "label" | "isActive">): ConnectedAccount {
  return {
    userId: "u1",
    broker: "alpaca",
    environment: "live",
    accountNumber: partial.id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial
  } as ConnectedAccount;
}

const loadedAccount = account({ id: "acct-paper", label: "Loaded Paper Account", isActive: true, environment: "paper" });
const otherAccount = account({ id: "acct-roth-live", label: "Roth IRA Live Account", isActive: false, environment: "live" });
// Lane h5 review round: a stopped, non-loaded account the app auto-paused (the 2026-09-25 Alpaca
// Paper shape) must say so on its row, not a bare "Stopped".
const pausedAccount = account({ id: "acct-alpaca-paper", label: "Alpaca Paper Account", isActive: false, environment: "paper" });

// The genuinely-running-but-not-loaded account: Autopilot (strategyAuthority "decide") with the
// market open, plus 2 real pending proposals waiting — exactly the case lifecycle-02/lifecycle-12
// describe (a second connected account trading independently of what's loaded in this tab).
const fixtureSnapshot = {
  policy: { systemState: "active", strategyAuthority: "propose", includedIndices: [], additionalSymbols: [], maxDailyOrders: 6 } as unknown as TradingPolicy,
  connectedAccounts: [loadedAccount, otherAccount, pausedAccount],
  // runDuringExtendedHours deliberately omitted (stays undefined): deriveStateInfo treats that as
  // "can't know if the market-hours window matters" and skips the open/closed split entirely, so
  // the label is a plain, time-of-day-independent "Running"/"Autopilot" — not flaky depending on
  // when this test happens to run relative to market hours.
  connectedAccountPolicies: {
    [loadedAccount.id]: { systemState: "active", strategyAuthority: "propose" },
    [otherAccount.id]: { systemState: "active", strategyAuthority: "decide" },
    [pausedAccount.id]: {
      systemState: "halted",
      strategyAuthority: "decide",
      haltCause: {
        kind: "broker_auto_pause",
        resumesOnItsOwn: true,
        since: "2026-09-25T18:20:24.034Z",
        reason: "Broker health check timed out: checkBrokerHealth timeout",
        autoResumeOnBootNow: false,
        summary: "Paused by the app since Thu, Sep 25, 1:20 PM CT: Broker health check timed out."
      }
    }
  },
  connectedAccountPendingCounts: {
    [loadedAccount.id]: 0,
    [otherAccount.id]: 2
  },
  pendingProposals: [],
  accounts: [],
  positions: [],
  orders: [],
  symbolMetaBySymbol: {},
  dailyStats: { orderCount: 0, openingOrderCount: 0, notional: 0 },
  strategyRuns: [],
  audit: [],
  auditFeed: [],
  unifiedFeed: [],
  strategyPrompt: "",
  notifications: [],
  profiles: [],
  notificationStatus: { configured: false, enabledEvents: [] }
} as unknown as DashboardSnapshot;

describe("Settings > Broker connections (per-account-visibility)", () => {
  it("shows the non-loaded account's REAL run state and pending count, never a blanket Inactive/0", async () => {
    const { BrokerAccountsCard } = await import("../app/console/settings/brokers");
    const html = renderToStaticMarkup(<BrokerAccountsCard />);

    // Split at the "Other Accounts" heading so assertions are scoped to that account's row,
    // not the loaded account's (which legitimately shows Ask-first, not Autopilot).
    const otherSection = html.split("Other Accounts")[1];
    expect(otherSection).toBeTruthy();
    expect(otherSection).toContain(otherAccount.label);

    // The dead-code fallback this cluster fixes: every "Other Accounts" row used to render this
    // literal text unconditionally. It must be gone once a real per-account state is available.
    expect(otherSection).not.toContain("Inactive");

    // The real per-account projection (connectedAccountPolicies) says this account is running
    // Autopilot right now — that must actually reach the chip.
    expect(otherSection).toContain("Autopilot");

    // The real per-account pending count (connectedAccountPendingCounts) — 2 proposals waiting on
    // an account that was never "loaded" in this browser tab.
    expect(otherSection).toContain("2 pending proposals");
  });

  it("says why a stopped, non-loaded account is stopped (lane h5)", async () => {
    const { BrokerAccountsCard } = await import("../app/console/settings/brokers");
    const html = renderToStaticMarkup(<BrokerAccountsCard />);
    const pausedRow = html.split(pausedAccount.label)[1];
    expect(pausedRow).toBeTruthy();
    expect(pausedRow).toContain("Stopped · auto-paused");
  });

  it("still shows the loaded account's own real state (unchanged, sanity check)", async () => {
    const { BrokerAccountsCard } = await import("../app/console/settings/brokers");
    const html = renderToStaticMarkup(<BrokerAccountsCard />);
    const loadedSection = html.split("Currently Loaded Account")[1]?.split("Other Accounts")[0];
    expect(loadedSection).toBeTruthy();
    expect(loadedSection).toContain(loadedAccount.label);
    // Running (strategyAuthority "propose"), not Autopilot — distinguishes this row from the
    // other account's, proving the fix reads PER-ACCOUNT data, not one shared value.
    expect(loadedSection).toContain("Running");
    expect(loadedSection).not.toContain("Autopilot");
  });
});
