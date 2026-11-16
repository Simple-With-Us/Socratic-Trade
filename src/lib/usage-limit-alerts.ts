import { audit, getInternalSetting, getNotifyPrefs, getPolicy, setInternalSetting } from "./db";
import { sendNotification } from "./notifications";
import { isPushoverDeliverable, loadNotifyConfig, notify, operatorPushoverUserKey } from "./notify";
import type { NotifyPrefs } from "./types";

export interface UsageLimitAlertInput {
  userId?: string;
  provider: string;
  operation: string;
  limitName: string;
  status?: "warning" | "exceeded" | "rate_limited" | "billing" | "quota";
  used?: number;
  limit?: number | null;
  attempted?: number;
  skipped?: number;
  unit?: string;
  recommendation?: string;
  payload?: Record<string, unknown>;
}

interface UsageLimitAlertOptions {
  /** Cooperative ownership fence for callers whose work may be superseded while delivery awaits. */
  assertActive?: () => void;
  /** Cancels in-flight channel delivery and retry waits after ownership moves. */
  signal?: AbortSignal;
}

function assertUsageAlertActive(options: UsageLimitAlertOptions): void {
  options.assertActive?.();
  if (!options.signal?.aborted) return;
  throw options.signal.reason instanceof Error
    ? options.signal.reason
    : new Error("Usage-limit alert ownership was lost.");
}

const ALERT_KEY_PREFIX = "usageLimitAlert:lastSent";
const DEFAULT_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

function numericEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cooldownMs(): number {
  return numericEnv("USAGE_LIMIT_ALERT_COOLDOWN_MS", DEFAULT_ALERT_COOLDOWN_MS);
}

function normalizedProvider(provider: string): string {
  return provider.trim().toLowerCase().replace(/\s+/g, "-") || "unknown";
}

function usageAlertKey(input: Required<Pick<UsageLimitAlertInput, "userId" | "provider" | "operation" | "limitName">>): string {
  return `${ALERT_KEY_PREFIX}:${input.userId}:${normalizedProvider(input.provider)}:${input.operation}:${input.limitName}`;
}

/** Read-only. A prior FAILED/SKIPPED attempt must not latch this cooldown. */
function recentlyAlerted(input: Required<Pick<UsageLimitAlertInput, "userId" | "provider" | "operation" | "limitName">>): boolean {
  const last = getInternalSetting<string>(usageAlertKey(input));
  return Boolean(last && Date.now() - Date.parse(last) < cooldownMs());
}

function markAlerted(input: Required<Pick<UsageLimitAlertInput, "userId" | "provider" | "operation" | "limitName">>): void {
  setInternalSetting(usageAlertKey(input), new Date().toISOString());
}

function operatorAlertEmail(): string | undefined {
  return (
    process.env.USAGE_LIMIT_ALERT_EMAIL?.trim() ||
    process.env.ADMIN_ALERT_EMAIL?.trim() ||
    process.env.PRIMARY_USER_EMAIL?.trim() ||
    undefined
  );
}

function formatNumber(value: number | undefined | null): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.abs(value) >= 1000 ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(value);
}

function bodyFor(input: UsageLimitAlertInput): string {
  const parts = [
    `${input.provider} limit hit during ${input.operation}.`,
    `Limit: ${input.limitName}.`
  ];
  const used = formatNumber(input.used);
  const limit = formatNumber(input.limit);
  const unit = input.unit ? ` ${input.unit}` : "";
  if (used || limit) parts.push(`Usage: ${used ?? "unknown"}${unit}${limit ? ` of ${limit}${unit}` : ""}.`);
  if (input.attempted !== undefined) parts.push(`Attempted: ${formatNumber(input.attempted)}${unit}.`);
  if (input.skipped !== undefined) parts.push(`Skipped: ${formatNumber(input.skipped)} item${input.skipped === 1 ? "" : "s"}.`);
  if (input.recommendation) parts.push(`Action: ${input.recommendation}`);
  return parts.join("\n");
}

async function notifyOperatorEmailFallback(
  userId: string,
  title: string,
  body: string,
  data: unknown,
  options: UsageLimitAlertOptions
): Promise<boolean> {
  assertUsageAlertActive(options);
  const prefs = getNotifyPrefs(userId);
  const config = loadNotifyConfig();
  if (isPushoverDeliverable(prefs, config)) {
    // sendNotification already attempted Pushover when the user enabled that channel.
    if (prefs.channels.includes("pushover")) return false;
    const forcedPrefs: NotifyPrefs = {
      ...prefs,
      channels: ["pushover"],
      pushoverTarget: operatorPushoverUserKey(prefs),
      updatedAt: prefs.updatedAt
    };
    assertUsageAlertActive(options);
    await notify(userId, { title, body, kind: "budget_alert", data }, {
      config,
      prefs: forcedPrefs,
      assertActive: options.assertActive,
      signal: options.signal
    });
    assertUsageAlertActive(options);
    return true;
  }
  if (prefs.channels.includes("email") && prefs.email.trim()) return false;

  assertUsageAlertActive(options);
  const fallbackEmail = operatorAlertEmail();
  if (!fallbackEmail) return false;
  if (!config.email.resendKey || !config.email.from) return false;

  const forcedPrefs: NotifyPrefs = {
    ...prefs,
    channels: ["email"],
    email: fallbackEmail,
    updatedAt: prefs.updatedAt
  };
  assertUsageAlertActive(options);
  await notify(userId, { title, body, kind: "budget_alert", data }, {
    config,
    prefs: forcedPrefs,
    assertActive: options.assertActive,
    signal: options.signal
  });
  assertUsageAlertActive(options);
  return true;
}

/**
 * One path for usage/quota/cap notifications. It records an in-app budget_alert,
 * attempts the user's configured channels, and falls back to an operator email
 * target when email delivery is configured but the user has not opted into email.
 */
export async function alertUsageLimitHit(
  input: UsageLimitAlertInput,
  options: UsageLimitAlertOptions = {}
): Promise<void> {
  const userId = input.userId ?? "local";
  try {
    assertUsageAlertActive(options);
    const sendKey = {
      userId,
      provider: input.provider,
      operation: input.operation,
      limitName: input.limitName
    };
    assertUsageAlertActive(options);
    if (recentlyAlerted(sendKey)) return;

    assertUsageAlertActive(options);
    const status = input.status ?? "exceeded";
    const title =
      status === "warning"
        ? `Usage warning: ${input.provider} ${input.limitName}`
        : `Usage limit hit: ${input.provider} ${input.limitName}`;
    const payload = {
      provider: input.provider,
      operation: input.operation,
      limitName: input.limitName,
      status,
      used: input.used,
      limit: input.limit,
      attempted: input.attempted,
      skipped: input.skipped,
      unit: input.unit,
      recommendation: input.recommendation,
      ...(input.payload ?? {})
    };
    const body = bodyFor(input);
    assertUsageAlertActive(options);
    audit("usage_limit_alert", payload, userId);
    assertUsageAlertActive(options);
    // Delivery honors the user's real enabledEvents toggle (owner ruling 2026-08-12, "ALL toggles
    // must be real" — no force-include). A legacy stored enabledEvents array predating this event
    // type was backfilled once by migration 78 (db.ts); after that the toggle is genuinely the
    // user's.
    const event = await sendNotification(
      { type: "budget_alert", title, payload },
      {
        userId,
        policy: getPolicy(userId),
        assertActive: options.assertActive,
        signal: options.signal
      }
    );
    assertUsageAlertActive(options);
    const fallbackSent = await notifyOperatorEmailFallback(userId, title, body, payload, options);
    assertUsageAlertActive(options);
    if (event.status === "sent" || fallbackSent) markAlerted(sendKey);
  } catch {
    // A failed ownership fence is control flow, not a best-effort alert failure.
    assertUsageAlertActive(options);
    // Usage alerts must never block trading, ingestion, or provider fallback.
  }
}
