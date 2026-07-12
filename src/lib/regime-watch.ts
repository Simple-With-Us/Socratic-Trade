// Deterministic market-regime flip detector (Phase 1 — no LLM, no cost).
//
// The regime label (VIX + yield-curve) is otherwise recomputed every run and persisted nowhere,
// so there's no way to notice a *change*. This stores the current label in the no-audit internal
// KV and, on a flip, records an audit, pushes a dashboard refresh, and broadcasts a material event
// (which only triggers a run when TRIGGER_ENGINE is on — otherwise a free, observable signal).

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { determineMarketRegime, fetchMacroDataWithLiveVix } from "./macro";
import { isEscalationMarketRegime, regimeFromLabel } from "./market-regime";
import { emitDashboardEvent } from "./events";
import { submitMaterialEvent } from "./triggers";

function regimeKey(userId: string): string {
  return `regime:current:${userId}`;
}

// Legacy pre-multi-user shared key. Before the label was scoped per user, the last regime was stored
// under this single key. On existing deploys the first tick after the user-scoped key was introduced
// finds the new key empty; without this fallback it would silently seed and SWALLOW a real flip.
const LEGACY_REGIME_KEY = "regime:current";

/**
 * Regimes the expert panel flagged for escalation. Delegates to the shared typed source of truth
 * (`isEscalationMarketRegime` ∘ `regimeFromLabel`) so this consumer, the crisis cap (policy.ts),
 * and the bear filter (strategy.ts) can never silently desync on a regime relabel — the
 * string-coupling the typed `MarketRegime` enum was introduced to kill.
 *
 * Imported from ./market-regime (a dependency-free module), NOT ./macro: test/regime-watch.test.ts
 * mocks the ENTIRE `./macro` module (`vi.doMock("../src/lib/macro", ...)`), so importing the typed
 * helpers from ./macro would return `undefined` under that mock. ./market-regime is unmocked, so the
 * real classifier runs. Behavior is unchanged on every canonical persisted label (crisis / risk-off /
 * cautious-inverted → escalation; neutral / risk-on → not) AND on the test's non-canonical
 * "Neutral (Moderate)" (→ unknown → not); a non-canonical free-text label now reads non-escalating
 * rather than accidentally matching a substring.
 */
export function isEscalationRegime(label: string): boolean {
  return isEscalationMarketRegime(regimeFromLabel(label));
}

/**
 * Compute the current regime, compare to the stored label, and on a change persist + announce it.
 * Cheap (one cached macro read + one short-TTL live VIX read); safe to call on every scheduler
 * tick. Seeds silently on first run. Uses the LIVE VIX overlay (fetchMacroDataWithLiveVix), not
 * the bare 24h-cached fetchMacroData snapshot — flip detection off a day-old VIX could miss an
 * intraday regime change (and the panic brake above it) for up to a day.
 */
export async function checkRegimeFlip(userId: string): Promise<void> {
  const macro = await fetchMacroDataWithLiveVix(userId);
  const next = determineMarketRegime(macro);
  const key = regimeKey(userId);
  let prev = getInternalSetting<string>(key);

  // One-time legacy migration: the user-scoped key is empty on the first tick after this key was
  // introduced, but a pre-existing deploy holds the last label under the shared `regime:current`.
  // Fall back to it as `prev` (and migrate it into the user key) so the first post-deploy tick can't
  // silently seed and swallow a real flip. Only the `local` user inherits the shared key — a genuinely
  // new multi-user tenant should seed fresh, not adopt another context's label.
  if (!prev && userId === "local") {
    const legacy = getInternalSetting<string>(LEGACY_REGIME_KEY);
    if (legacy) {
      prev = legacy;
      setInternalSetting(key, legacy); // migrate once into the user-scoped key
    }
  }

  if (!prev) {
    setInternalSetting(key, next); // seed; don't announce a "flip" from nothing
    return;
  }
  if (prev === next) {
    // Keep the user key current even when unchanged (e.g. right after a legacy migration seeded it).
    if (getInternalSetting<string>(key) !== next) setInternalSetting(key, next);
    return;
  }

  setInternalSetting(key, next);
  audit(
    "regime_flip",
    { from: prev, to: next, vix: macro.vix, vixAsOf: macro.vixAsOf, fedFunds: macro.fedFundsRate, dgs10: macro.dgs10Treasury, escalation: isEscalationRegime(next) },
    userId
  );
  // Immediate dashboard refresh even when the trigger engine is off.
  emitDashboardEvent({ type: "dirty", at: new Date().toISOString(), detail: { regimeFrom: prev, regimeTo: next } });
  // Material event: only submit to THIS user when flipping INTO an escalation regime (Risk-Off /
  // Crisis / Inverted-curve). Scoped to the user whose regime flipped — broadcasting would fan an
  // LLM-triggering event to every active user for one user's flip. A de-escalation back to calm
  // should not trigger an expensive LLM run. submitMaterialEvent already guards on this user's policy
  // state (engine on, mode allows events, system active + account) before enqueuing.
  if (isEscalationRegime(next)) {
    submitMaterialEvent(userId, { type: "regime", sourceId: `${prev}->${next}`, reason: `Regime flip ${prev} → ${next}` });
  }
}
