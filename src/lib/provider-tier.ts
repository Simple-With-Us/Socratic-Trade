// Provider paid-tier watchdog.
//
// We raise the Massive client rate limit to 100/min on the assumption of a paid (unlimited) plan.
// If that subscription ever lapses back to free (5/min), the app would 429-storm. This nightly
// watchdog probes each market-data key's actual tier, and on a CONFIDENT "free" detection it (a)
// notifies the operator and (b) auto-clamps the Massive limiter to the free-safe 5/min so the app
// degrades gracefully instead of hammering. It restores the high limit once it sees paid again.
//
// Neither Massive (Polygon) nor FMP exposes a "what plan am I on" endpoint, so we use cheap
// capability probes (~2 calls each, well within any tier). The classifier is biased toward "unknown"
// (no action) on any ambiguous/transient signal, so it never wrongly clamps a working paid key.

import { audit, getInternalSetting, resolveApiKey, setInternalSetting } from "./db";
import { massiveApiBase } from "./market-signals/massive";
import { notify } from "./notify";
import { sendNotification } from "./notifications";

export type ProviderTier = "paid" | "free" | "unknown";
export interface ProviderTierEntry {
  tier: ProviderTier;
  at: string;
  reason: string;
}
export type ProviderTierStatus = Partial<Record<"massive" | "fmp", ProviderTierEntry>>;

/** Internal-setting key holding the latest detected tier per provider. Also read by massive.ts. */
export const PROVIDER_TIER_STATUS_KEY = "providerTier:status";
const LAST_CHECK_KEY = "providerTier:lastCheckAt";
const DEFAULT_INTERVAL_HOURS = 24;
const PROBE_TIMEOUT_MS = 8000;
const DAY_MS = 86_400_000;

type Fetcher = typeof fetch;

function numericEnv(name: string, fallback: number, min = 0): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function getProviderTierStatus(): ProviderTierStatus {
  return getInternalSetting<ProviderTierStatus>(PROVIDER_TIER_STATUS_KEY) ?? {};
}

// ── Massive (Polygon) probe ───────────────────────────────────────────────────
// Free tier: 5 req/min + ~2 years of history. Paid: unlimited + full history. So a daily-aggregate
// query for a long-listed symbol (AAPL) at a window >2yr back returns data on paid and is empty/403
// on free. A 429 on a single call also means free (paid never rate-limits one call).
async function massiveAgg(key: string, from: string, to: string, fetcher: Fetcher): Promise<{ status: number; ok: boolean; results: number } | null> {
  const url = `${massiveApiBase()}/v2/aggs/ticker/AAPL/range/1/day/${from}/${to}?adjusted=true&limit=20`;
  try {
    const res = await fetcher(url, { cache: "no-store", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { status: res.status, ok: false, results: 0 };
    const json = (await res.json().catch(() => null)) as { results?: unknown[] } | null;
    return { status: res.status, ok: true, results: Array.isArray(json?.results) ? json!.results!.length : 0 };
  } catch {
    return null;
  }
}

export async function probeMassiveTier(key: string | undefined, now: number = Date.now(), fetcher: Fetcher = fetch): Promise<{ tier: ProviderTier; reason: string }> {
  if (!key) return { tier: "unknown", reason: "no Massive key configured" };
  const recent = await massiveAgg(key, ymd(now - 10 * DAY_MS), ymd(now), fetcher);
  if (!recent) return { tier: "unknown", reason: "recent probe network/timeout error" };
  if (recent.status === 429) return { tier: "free", reason: "429 on a single call (free tier is 5 req/min)" };
  if (!recent.ok) return { tier: "unknown", reason: `recent probe HTTP ${recent.status} (likely a bad key, not a tier signal)` };

  const oldFrom = ymd(now - Math.round(2.5 * 365) * DAY_MS);
  const oldTo = ymd(now - Math.round(2.5 * 365 - 6) * DAY_MS);
  const old = await massiveAgg(key, oldFrom, oldTo, fetcher);
  if (!old) return { tier: "unknown", reason: "history probe network/timeout error" };
  if (old.status === 429 || old.status === 403) return { tier: "free", reason: `>2yr history blocked (HTTP ${old.status}) — free 2-year cap` };
  if (!old.ok) return { tier: "unknown", reason: `history probe HTTP ${old.status}` };
  if (old.results > 0) return { tier: "paid", reason: "returned >2-year-old history (paid)" };
  return { tier: "free", reason: "no >2yr history returned — free 2-year cap" };
}

// ── FMP probe ──────────────────────────────────────────────────────────────────
// Best-effort: FMP free vs Starter is distinguished by per-minute throughput + endpoint gating, not
// a plan endpoint. We only assert "free" on an explicit premium/upgrade/limit error (or a 429);
// otherwise "unknown" — FMP's action is notify-only (no auto-clamp), so a miss just skips an alert.
const FMP_FREE_SIGNAL = /exclusive|premium|upgrade|limit reach|special endpoint|not available under your/i;

export async function probeFmpTier(key: string | undefined, fetcher: Fetcher = fetch): Promise<{ tier: ProviderTier; reason: string }> {
  if (!key) return { tier: "unknown", reason: "no FMP key configured" };
  const url = `https://financialmodelingprep.com/stable/ratios-ttm?symbol=AAPL&apikey=${encodeURIComponent(key)}`;
  let res: Response;
  try {
    res = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch {
    return { tier: "unknown", reason: "network/timeout error" };
  }
  if (res.status === 429) return { tier: "free", reason: "429 (free tier 250 calls/day cap)" };
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return FMP_FREE_SIGNAL.test(text)
      ? { tier: "free", reason: `premium-gated error (HTTP ${res.status})` }
      : { tier: "unknown", reason: `HTTP ${res.status}` };
  }
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { return { tier: "unknown", reason: "unparseable response" }; }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const msg = String((json as Record<string, unknown>)["Error Message"] ?? (json as Record<string, unknown>).message ?? "");
    if (FMP_FREE_SIGNAL.test(msg)) return { tier: "free", reason: `error envelope: ${msg.slice(0, 80)}` };
  }
  if (Array.isArray(json) && json.length > 0) return { tier: "paid", reason: "ratios-ttm returned data" };
  return { tier: "unknown", reason: "ambiguous response (no premium signal, no data)" };
}

// ── Orchestration ──────────────────────────────────────────────────────────────
export async function runProviderTierCheck(opts: { userId?: string; now?: number; fetcher?: Fetcher } = {}): Promise<ProviderTierStatus> {
  const userId = opts.userId ?? "local";
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetch;
  const nowIso = new Date(now).toISOString();
  const prev = getProviderTierStatus();
  const next: ProviderTierStatus = {};

  const massiveKey = resolveApiKey("massive", userId);
  if (massiveKey) {
    const r = await probeMassiveTier(massiveKey, now, fetcher);
    next.massive = { tier: r.tier, at: nowIso, reason: r.reason };
  }
  const fmpKey = resolveApiKey("fmp", userId);
  if (fmpKey) {
    const r = await probeFmpTier(fmpKey, fetcher);
    next.fmp = { tier: r.tier, at: nowIso, reason: r.reason };
  }

  setInternalSetting(PROVIDER_TIER_STATUS_KEY, next);
  audit("provider_tier_check", { massive: next.massive, fmp: next.fmp }, userId);

  // Alert on a subscription LAPSE or CHANGE (either direction), via the in-app feed AND the
  // multi-channel dispatcher (push/webhook/EMAIL/SMS per the user's notify prefs). Skip transitions
  // to/from "unknown" (transient probe blips) and skip the first-ever "paid" detection (not news).
  for (const provider of ["massive", "fmp"] as const) {
    const cur = next[provider];
    if (!cur) continue;
    const prevTier = prev[provider]?.tier;
    const msg = tierChangeMessage(provider, prevTier, cur.tier, cur.reason);
    if (!msg) continue;
    await sendNotification(
      { type: "provider_degraded", title: msg.title, payload: { provider, fromTier: prevTier ?? "unknown", toTier: cur.tier, reason: cur.reason, detectedAt: nowIso } },
      { userId }
    ).catch(() => {});
    await notify(userId, { title: msg.title, body: msg.body, kind: "provider_degraded", data: { provider, fromTier: prevTier ?? "unknown", toTier: cur.tier, reason: cur.reason } }).catch(
      (err) => console.error("[provider-tier] notify error:", err)
    );
  }
  return next;
}

/** Build the alert text for a tier transition, or null when it isn't worth alerting. */
function tierChangeMessage(
  provider: "massive" | "fmp",
  prevTier: ProviderTier | undefined,
  curTier: ProviderTier,
  reason: string
): { title: string; body: string } | null {
  if (curTier === "unknown") return null;            // transient probe failure — don't alert
  if (curTier === prevTier) return null;             // no change
  if (prevTier === undefined && curTier === "paid") return null; // first run, all good — not news
  const name = provider === "massive" ? "Massive (Polygon)" : "FMP";
  if (curTier === "free") {
    const action = provider === "massive"
      ? "Massive's rate limit was auto-clamped to the free-safe 5/min to avoid 429 errors."
      : "FMP enrichment will degrade to the free 250-calls/day budget.";
    return {
      title: `⚠️ ${name} data subscription appears to have LAPSED (now FREE tier)`,
      body: `The ${name} API key is responding like a free-tier key — your paid subscription may have lapsed or been downgraded.\n\nDetection: ${reason}\n\n${action}\n\nCheck your ${provider} billing/plan and confirm the key.`
    };
  }
  // curTier === "paid"
  return {
    title: `✅ ${name} data subscription is back on a PAID tier`,
    body: `The ${name} API key is now responding like a paid-tier key (${reason}). Full limits restored.`
  };
}

/** True roughly between 1am–6am US/Eastern, so the nightly check runs overnight (low-activity). */
function isOvernightEt(now: number): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(now)));
    return Number.isFinite(hour) && hour >= 1 && hour < 6;
  } catch {
    return true; // if the runtime lacks tz data, don't block the check
  }
}

export function isProviderTierCheckDue(now: number = Date.now()): boolean {
  const intervalMs = numericEnv("PROVIDER_TIER_CHECK_INTERVAL_HOURS", DEFAULT_INTERVAL_HOURS, 1) * 3600_000;
  const last = getInternalSetting<string>(LAST_CHECK_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const elapsed = now - lastMs;
  if (elapsed < intervalMs) return false;
  // Past the interval: prefer to actually fire overnight, but never stall forever — if we've already
  // waited 1.5× the interval (e.g. the box was down all night), run at the next opportunity.
  return isOvernightEt(now) || elapsed >= intervalMs * 1.5;
}

/** Cadence-gated runner for the scheduler tick. Self-guarded; sets the watermark BEFORE probing so a
 *  busy tick loop can't double-run it. No-op until due (default every 24h). */
export async function runProviderTierCheckIfDue(now: number = Date.now()): Promise<void> {
  try {
    if (!isProviderTierCheckDue(now)) return;
    setInternalSetting(LAST_CHECK_KEY, new Date(now).toISOString());
    await runProviderTierCheck({ now });
  } catch (err) {
    console.error("[provider-tier] tier check error:", err);
  }
}
