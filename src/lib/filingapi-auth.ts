/**
 * FilingAPI.dev is an optional enrichment lane. A missing, invalid, or 401 key
 * must skip the lane (ROIC + SEC EDGAR cover the same fields) without failing
 * health. A later different key is tried again.
 *
 * Rejection is keyed by SHA-256 of the secret so we stop using a dead prod
 * trial key after the first 401, without storing the secret.  The fingerprint
 * set is also persisted in durable_state (namespace filingapi, key
 * rejected-fingerprint) so a container restart does not re-401 the same key.
 */

import { createHash } from "crypto";
import { isFilingApiAuthErrorText, isFilingApiAuthStatus } from "./filingapi-auth-classify";
import { createDurableMap, type DurableMap } from "./durable-state";

export { isFilingApiAuthErrorText, isFilingApiAuthStatus };

const FILINGAPI_NS = "filingapi";
const REJECTED_FINGERPRINT_KEY = "rejected-fingerprint";

const rejectedFingerprints = new Set<string>();
let hydratedFromDurable = false;

let rejectedStoreInstance: DurableMap<string[]> | undefined;
function rejectedStore(): DurableMap<string[]> {
  return (
    rejectedStoreInstance ??
    (rejectedStoreInstance = createDurableMap<string[]>(FILINGAPI_NS, { flush: "immediate" }))
  );
}

function persistRejectedFingerprints(): void {
  try {
    rejectedStore().set(REJECTED_FINGERPRINT_KEY, Array.from(rejectedFingerprints));
  } catch {
    // Memory still gates this process; a durable write failure must not re-401.
  }
}

function hydrateRejectedFingerprints(): void {
  if (hydratedFromDurable) return;
  hydratedFromDurable = true;
  try {
    const stored = rejectedStore().get(REJECTED_FINGERPRINT_KEY);
    if (Array.isArray(stored)) {
      for (const fingerprint of stored) {
        if (typeof fingerprint === "string" && fingerprint) rejectedFingerprints.add(fingerprint);
      }
    } else if (typeof stored === "string" && stored) {
      rejectedFingerprints.add(stored);
    }
  } catch {
    // Fail open to the in-memory set (empty on a fresh process).
  }
}

export function filingApiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function isFilingApiKeyRejected(apiKey: string | null | undefined): boolean {
  const key = apiKey?.trim();
  if (!key) return false;
  hydrateRejectedFingerprints();
  return rejectedFingerprints.has(filingApiKeyFingerprint(key));
}

export function markFilingApiKeyRejected(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) return;
  hydrateRejectedFingerprints();
  rejectedFingerprints.add(filingApiKeyFingerprint(key));
  persistRejectedFingerprints();
}

export function clearFilingApiKeyRejected(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) return;
  hydrateRejectedFingerprints();
  rejectedFingerprints.delete(filingApiKeyFingerprint(key));
  persistRejectedFingerprints();
}

/** Register / call FilingAPI only when a key is present and not known-dead. */
export function shouldUseFilingApiKey(apiKey: string | null | undefined): apiKey is string {
  const key = apiKey?.trim();
  if (!key) return false;
  return !isFilingApiKeyRejected(key);
}

/** Drop the in-memory set so the next read rehydrates from durable_state. */
export function resetFilingApiAuthMemoryForTests(): void {
  rejectedFingerprints.clear();
  hydratedFromDurable = false;
}

export function resetFilingApiAuthStateForTests(): void {
  resetFilingApiAuthMemoryForTests();
  try {
    rejectedStore().clear();
  } catch {
    /* tests without a migrated db still get a clean memory set */
  }
}
