// Deterministic market-regime flip detector (Phase 1 — no LLM, no cost).
//
// The regime label (VIX + yield-curve) is otherwise recomputed every run and persisted nowhere,
// so there's no way to notice a *change*. This stores the current label in the no-audit internal
// KV and, on a flip, records an audit, pushes a dashboard refresh, and broadcasts a material event
// (which only triggers a run when TRIGGER_ENGINE is on — otherwise a free, observable signal).

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { getPolicy } from "./db-profiles";
import { determineMarketRegime, fetchMacroDataWithLiveVix, type MacroData } from "./macro";
import { classifyMarketRegime, isEscalationMarketRegime, MARKET_REGIME_LABELS, regimeFromLabel } from "./market-regime";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMultiSignalSeverity } from "./regime-severity";
import { emitDashboardEvent } from "./events";
import { submitMaterialEvent } from "./triggers";

// Macro-only severity (no signals fetch here — checkRegimeFlip only has `macro` in scope).
// Best-effort: a scorer failure must never affect flip detection/notification. Logged as
// `severityMacroOnly` in the regime_flip audit payload to distinguish it from the fuller
// (macro + signals) `regimeSeverity` computed at strategy-run time (strategy.ts).
//
// OPT-IN (DEFAULT false via policy.tuning.regimeSeverityScoring): default false: default behavior
// is byte-identical — the scorer is not invoked and no `severityMacroOnly` key is added to the
// regime_flip audit payload unless an operator opts in.
function macroOnlySeverity(macro: MacroData, userId: string): number | undefined {
  if (!getPolicy(userId).tuning?.regimeSeverityScoring) return undefined;
  try {
    const derived = deriveMacroMetrics(macro);
    const hyCreditSpreadPct = macro.hyCreditSpread ? parseFloat(macro.hyCreditSpread) : undefined;
    const result = computeMultiSignalSeverity({
      regime: classifyMarketRegime(macro).regime,
      vix: macro.vix ? parseFloat(macro.vix) : undefined,
      vixTermStructure: derived.vixTermStructure,
      hyCreditSpreadPct: Number.isFinite(hyCreditSpreadPct) ? hyCreditSpreadPct : undefined
    });
    return Number(result.severity.toFixed(2));
  } catch {
    return undefined;
  }
}

function regimeKey(userId: string): string {
  return `regime:current:${userId}`;
}

// Legacy pre-multi-user shared key. Before the label was scoped per user, the last regime was stored
// under this single key. On existing deploys the first tick after the user-scoped key was introduced
// finds the new key empty; without this fallback it would silently seed and SWALLOW a real flip.
const LEGACY_REGIME_KEY = "regime:current";

// ── Unknown-side suppression ──────────────────────────────────────────────────
// "Unknown (no macro feed)" is a DATA OUTAGE state (classifyMarketRegime's asOf === "unavailable"
// branch, severity 0 by design), not a market regime. Before this gate, every tick recomputed the
// label and announced ANY change, so a flaky feed flapped the stored label Neutral <-> Unknown,
// wrote a regime_flip audit row per transition (6 on 2026-07-28 alone, some ~1 minute apart), and
// on recovery into an escalation regime could fire LLM trigger runs off an outage artifact.
const UNKNOWN_REGIME_LABEL: string = MARKET_REGIME_LABELS.unknown; // "Unknown (no macro feed)"

// Throttle for the outage diagnostic: at most one macro_feed_unavailable audit per user per hour.
// The outage must stay OBSERVABLE (one row with evidence) without recreating the flap spam.
const MACRO_UNAVAILABLE_THROTTLE_MS = 60 * 60_000;

function macroUnavailableNotifiedKey(userId: string): string {
  return `regime:macro-unavailable-notified:${userId}`;
}

/**
 * Audit the outage once per throttle window. Marker is the last-emitted ISO timestamp in the
 * no-audit internal KV (same store as the regime label), so the throttle survives restarts.
 * Payload carries the sourcing evidence (asOf/vixAsOf) plus the held last-known regime.
 */
function auditMacroFeedUnavailable(userId: string, macro: MacroData & { vixAsOf?: string }, heldRegime: string | null, now: number): void {
  const markerKey = macroUnavailableNotifiedKey(userId);
  const last = getInternalSetting<string>(markerKey);
  const lastAt = last ? Date.parse(last) : NaN;
  if (Number.isFinite(lastAt) && now - lastAt < MACRO_UNAVAILABLE_THROTTLE_MS) return;
  setInternalSetting(markerKey, new Date(now).toISOString());
  audit(
    "macro_feed_unavailable",
    {
      asOf: macro.asOf,
      vixAsOf: macro.vixAsOf ?? null,
      heldRegime,
      throttleMinutes: MACRO_UNAVAILABLE_THROTTLE_MS / 60_000
    },
    userId
  );
}

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
 *
 * OUTAGE HANDLING: when the feed is down the classifier returns "Unknown (no macro feed)" — that is
 * held OFF the stored label (see UNKNOWN_REGIME_LABEL gate below): no flip audit, no dirty event,
 * no material event, just a throttled macro_feed_unavailable diagnostic. The stored last-known
 * label survives the outage untouched, so when the feed recovers the normal comparison below
 * catches any REAL regime change that happened during the outage and announces it with the usual
 * semantics (escalations submit a material event, de-escalations don't).
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

  // OUTAGE GATE: a missing feed is not a regime change. When the computed label is Unknown, hold
  // the stored last-known label — no overwrite, no regime_flip audit, no dashboard dirty event, no
  // material event. Emit only the throttled macro_feed_unavailable diagnostic so the outage stays
  // observable. This also covers first-ever ticks: the key is never SEEDED with the Unknown label;
  // we wait for a real reading.
  if (next === UNKNOWN_REGIME_LABEL) {
    auditMacroFeedUnavailable(userId, macro, prev ?? null, Date.now());
    return;
  }

  // Repair path for deploys where the pre-gate code already persisted an Unknown label: treat it
  // as unseeded and silently adopt the recovered real label rather than announcing a fake
  // "Unknown -> X" flip (Unknown was never a real regime to flip FROM).
  if (!prev || prev === UNKNOWN_REGIME_LABEL) {
    setInternalSetting(key, next); // seed; don't announce a "flip" from nothing
    return;
  }
  if (prev === next) {
    // Keep the user key current even when unchanged (e.g. right after a legacy migration seeded it).
    if (getInternalSetting<string>(key) !== next) setInternalSetting(key, next);
    return;
  }

  setInternalSetting(key, next);
  const severityMacroOnly = macroOnlySeverity(macro, userId);
  audit(
    "regime_flip",
    {
      from: prev,
      to: next,
      vix: macro.vix,
      vixAsOf: macro.vixAsOf,
      fedFunds: macro.fedFundsRate,
      dgs10: macro.dgs10Treasury,
      escalation: isEscalationRegime(next),
      ...(severityMacroOnly !== undefined ? { severityMacroOnly } : {})
    },
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
