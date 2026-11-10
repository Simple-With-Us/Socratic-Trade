/**
 * Versioned legal clickwrap + desk notice.  Same pattern as Coach's PROMPT_VERSION
 * bundle and DATA_POOL_CONSENT_VERSION: accept once at the current version, then
 * the gate stays dismissed until the copy/terms materially change.
 *
 * Owner cut 2026-08-17 items 9–11: dismissible (does not reappear after accept),
 * mandatory market-data share, Privacy names self-serve deletion / backup TTL /
 * shared RAG corpus.  Not a paywall.  Multi-user isolation still applies.
 */

export const LEGAL_NOTICE_VERSION = 2;

/** One-line desk sentence — also the strategy-prompt framing. */
export const LEGAL_NOTICE_SENTENCE = "Not investment advice.  You set authority.";

/** Green/Red system-prompt sentence.  Bump STRATEGY_PROMPT_VERSION when this changes. */
export const STRATEGY_LEGAL_SENTENCE =
  "This software is a user-configured trading tool, not investment advice.  The owner sets authority; propose only within those settings.";

/** Production Litestream snapshot retention (`litestream.coolify.yml` snapshot.retention). */
export const BACKUP_RETENTION_HOURS = 72;
export const BACKUP_RETENTION_DAYS = 3;
/**
 * Weekly R2 cold-archive depth (`R2_COLD_SNAPSHOT_DEFAULT_RETAIN` in r2-cold-snapshot.ts):
 * the newest N Sunday full copies are kept, so a copy lives about N weeks.
 * Weekly copies run alongside the short-term ones from day 1, so N weeks is also the
 * total maximum age of any backup.  The prune pass also enforces a hard 14-day cap
 * (`R2_COLD_SNAPSHOT_MAX_AGE_DAYS`), counted from the day each copy is made.
 */
export const WEEKLY_BACKUP_RETENTION_WEEKS = 2;
/** User-facing backup retention sentence shared by the privacy policy and consent gate. */
export const BACKUP_RETENTION_SENTENCE = `Backups are kept for at most ${WEEKLY_BACKUP_RETENTION_WEEKS} weeks: short-term backups for ${BACKUP_RETENTION_DAYS} days, and weekly backups for ${WEEKLY_BACKUP_RETENTION_WEEKS} weeks, then deleted.`;

export const LEGAL_TERMS_PATH = "/terms-and-conditions";
export const LEGAL_PRIVACY_PATH = "/privacy-policy";
