import "server-only";
import { DATA_POOL_CONSENT_VERSION, getDataPoolConsent, getLegalNoticeConsent, needsAppConsent } from "./db";
import type { DataPoolConsent, LegalNoticeConsent } from "./db";
import { LEGAL_NOTICE_VERSION } from "./legal-notice";

/** First-use consent (W15 / ST-4689), carried in the dashboard payload so the console's
 *  ConsentGate does not fire two extra requests on every load: the same records
 *  `GET /api/consent` and `GET /api/legal-notice` return, plus both policy versions and
 *  the combined gate flag.
 *
 *  Read-only.  Accepting still POSTs to each route, which remains the only writer.
 *  Contains accept flags, timestamps and policy versions — never an API key, token, or
 *  personal account data. */
export interface DashboardConsent {
  legal: LegalNoticeConsent;
  dataPool: DataPoolConsent;
  legalVersion: number;
  dataPoolVersion: number;
  /** True until the user has accepted BOTH the current legal notice and data-pool terms. */
  needsConsent: boolean;
}

/** Read the current consent records for one user.  Cheap (two user_settings reads) and
 *  always fresh: routes merge this AFTER the cached snapshot so an accept is reflected
 *  on the next poll instead of waiting out the ~10s snapshot TTL. */
export function buildDashboardConsent(userId: string): DashboardConsent {
  return {
    legal: getLegalNoticeConsent(userId),
    dataPool: getDataPoolConsent(userId),
    legalVersion: LEGAL_NOTICE_VERSION,
    dataPoolVersion: DATA_POOL_CONSENT_VERSION,
    needsConsent: needsAppConsent(userId)
  };
}
