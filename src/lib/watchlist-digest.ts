// watchlist-digest.ts — opt-in daily watchlist summary (owner default OFF, enabled per-user via
// Settings -> Delivery: notification_prefs.watchlistDigestEnabled). Fires once per Central-Time
// calendar day, only at/after 15:15 CT (shortly after the US market close), reusing ONLY data the
// app already persisted this run cycle (report-context.ts) — no provider calls, no LLM. Modeled
// closely on runR2UsageDailyDigestIfDue (src/lib/r2-usage.ts): internal-setting watermark claimed
// before work runs, every failure captured into an audit event and never thrown, skip reasons
// returned rather than silently swallowed. Delivered via notify() directly (not sendNotification)
// with tiered bodies — see NotifyMessage.bodyTiers / CHANNEL_CAPABILITIES in notify.ts.

import { audit, getInternalSetting, getNotifyPrefs, listUsers, setInternalSetting } from "./db";
import { notify, type NotifyDispatchDeps } from "./notify";
import { buildWatchlistReportContext } from "./report-context";
import { renderWatchlistDigestBrief, renderWatchlistDigestFull, renderWatchlistDigestMedium, ctDateKey } from "./report-renderer";
import type { NotificationEventType } from "./types";

const CENTRAL_TIME_ZONE = "America/Chicago";
/** Post-close gate: the US market closes at 4:00pm Eastern (3:00pm Central); 15 minutes past
 *  gives quotes a moment to settle before the digest reads the latest persisted scan. */
const DIGEST_CT_HOUR = 15;
const DIGEST_CT_MINUTE = 15;

const LAST_DIGEST_KEY_PREFIX = "watchlistDigest:lastSentDate";
function lastDigestKey(userId: string): string {
  return `${LAST_DIGEST_KEY_PREFIX}:${userId}`;
}

/** Central-Time calendar-day key ("YYYY-MM-DD") + local wall-clock hour/minute for `date`,
 *  DST-safe via Intl. Duplicated (not imported) from report-renderer.ts's ctDateKey because this
 *  needs the hour/minute too, in one Intl call. */
function centralWallClock(date: Date): { dateKey: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CENTRAL_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour); // some engines render midnight as "24"
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: Number(parts.minute) };
}

/** Due for `userId` when: the digest is enabled, it's at/after 15:15 Central, and no digest has
 *  gone out yet for today's Central calendar day. Exported for tests. */
export function isWatchlistDigestDue(userId: string, now: number = Date.now()): boolean {
  if (getNotifyPrefs(userId).watchlistDigestEnabled !== true) return false;
  const { dateKey, hour, minute } = centralWallClock(new Date(now));
  if (hour < DIGEST_CT_HOUR || (hour === DIGEST_CT_HOUR && minute < DIGEST_CT_MINUTE)) return false;
  return getInternalSetting<string>(lastDigestKey(userId)) !== dateKey;
}

const WATCHLIST_DIGEST_EVENT_TYPE: NotificationEventType = "watchlist_digest";

export interface WatchlistDigestResult {
  status: "sent" | "skipped" | "error";
  reason?: string;
  /** Number of users the digest actually delivered to (>=1 channel accepted it). */
  usersSent?: number;
}

/**
 * Scheduler entry point (src/lib/scheduler.ts, next to the r2-usage-daily-digest lane): checks
 * every user, builds+sends the digest for whichever are due, and always resolves rather than
 * throwing — a bad render or a delivery failure for one user must never wedge the scheduler tick
 * or block another user's digest.
 */
export async function runWatchlistDigestIfDue(
  now: number = Date.now(),
  deps: { notifyImpl?: typeof notify } & Pick<NotifyDispatchDeps, "fetchImpl"> = {}
): Promise<WatchlistDigestResult> {
  try {
    const notifyImpl = deps.notifyImpl ?? notify;
    const { dateKey } = centralWallClock(new Date(now));
    const dueUsers = listUsers().filter((userId) => isWatchlistDigestDue(userId, now));
    if (dueUsers.length === 0) return { status: "skipped", reason: "not_due" };

    let sent = 0;
    for (const userId of dueUsers) {
      // Claim the watermark BEFORE building/sending (watermark-first, mirrors r2-usage's daily
      // digest) so a mid-build error can't loop the same user's digest twice in one CT day.
      setInternalSetting(lastDigestKey(userId), dateKey);
      try {
        const context = buildWatchlistReportContext(userId);
        if (context.symbols.length === 0) {
          audit("watchlist_digest.skip", { userId, reason: "empty_watchlist" }, userId);
          continue;
        }
        const full = renderWatchlistDigestFull(context);
        const medium = renderWatchlistDigestMedium(context);
        const brief = renderWatchlistDigestBrief(context);
        const title = `Watchlist Digest - ${ctDateKey(context.generatedAt)} (${context.symbols.length} symbol${context.symbols.length === 1 ? "" : "s"})`;

        const results = await notifyImpl(
          userId,
          { title, body: full, kind: WATCHLIST_DIGEST_EVENT_TYPE, bodyTiers: { full, medium, brief } },
          deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined
        );
        const anySent = results.some((r) => r.ok);
        // Event name reflects the real outcome: "sent" would overstate delivery when every
        // channel skipped or failed, so that case gets its own name with the same payload.
        audit(
          anySent ? "watchlist_digest.sent" : "watchlist_digest.undelivered",
          { userId, symbolCount: context.symbols.length, channelResults: results },
          userId
        );
        if (anySent) sent += 1;
      } catch (err) {
        console.error(`[watchlist-digest] build/send error for ${userId}:`, err);
        audit(
          "watchlist_digest.error",
          { userId, error: err instanceof Error ? err.message : String(err) },
          userId
        );
      }
    }
    return sent > 0 ? { status: "sent", usersSent: sent } : { status: "skipped", reason: "no_messages" };
  } catch (err) {
    console.error("[watchlist-digest] daily digest error:", err);
    try {
      audit("watchlist_digest.digest_error", { error: err instanceof Error ? err.message : String(err) });
    } catch {
      // never throw
    }
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
