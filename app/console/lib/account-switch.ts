/** Pure guarded account-switch steps (W16 / OD-11). No React, no window — the
 *  unit test drives this exactly as the callers do.
 *
 *  Activating an account is a server-side scope change (POST
 *  /api/connected-accounts/:id/activate). The old flow answered it with a
 *  full page relocation so no stale Account A UI could stay interactive while
 *  the server pointed at Account B. The new flow keeps the same guarantee
 *  without the navigation: `activate` lands the new scope, then `refresh`
 *  reseats the in-memory snapshot — and the console shell keys the routed page
 *  subtree by the active account id, so account-scoped editors remount from
 *  B's snapshot exactly as a page-wide reset once did. A refresh failure after
 *  a successful activation is swallowed here on purpose: the scope change
 *  already happened, and the console's native freshness/error state is the
 *  surface that reports refresh problems. */

export interface AccountSwitchSteps {
  activate: (id: string) => Promise<{ ok: boolean }>;
  /** Rescope the in-memory snapshot after the server-side scope change. */
  refresh: () => Promise<void>;
}

export async function switchAccountGuarded(id: string, steps: AccountSwitchSteps): Promise<void> {
  await steps.activate(id);
  await steps.refresh().catch(() => undefined);
}