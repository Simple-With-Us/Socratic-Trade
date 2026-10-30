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
 */
export const WEEKLY_BACKUP_RETENTION_WEEKS = 3;
/** User-facing backup retention sentence shared by the privacy policy and consent gate. */
export const BACKUP_RETENTION_SENTENCE = `Short-term backups are kept for ${BACKUP_RETENTION_DAYS} days.\u00a0 Weekly backups are kept for ${WEEKLY_BACKUP_RETENTION_WEEKS} weeks, then deleted.`;

export const LEGAL_TERMS_PATH = "/terms-and-conditions";
export const LEGAL_PRIVACY_PATH = "/privacy-policy";
