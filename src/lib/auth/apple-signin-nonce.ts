import { createHash, randomBytes } from "node:crypto";

const NONCE_TTL_MS = 5 * 60_000;
const MAX_NONCES = 512;

type StoredNonce = { expiresAt: number };

const globalForAppleNonce = globalThis as typeof globalThis & {
  __appleSignInNonces?: Map<string, StoredNonce>;
};

function store(): Map<string, StoredNonce> {
  return (globalForAppleNonce.__appleSignInNonces ??= new Map());
}

function purge(now: number): void {
  const nonces = store();
  for (const [nonce, row] of nonces) {
    if (row.expiresAt <= now) nonces.delete(nonce);
  }
  while (nonces.size >= MAX_NONCES) {
    const oldest = nonces.keys().next().value;
    if (!oldest) break;
    nonces.delete(oldest);
  }
}

export function issueAppleSignInNonce(now: number = Date.now()): string {
  purge(now);
  const nonce = randomBytes(32).toString("base64url");
  store().set(nonce, { expiresAt: now + NONCE_TTL_MS });
  return nonce;
}

export function consumeAppleSignInNonce(nonce: string, now: number = Date.now()): boolean {
  purge(now);
  const row = store().get(nonce);
  store().delete(nonce);
  return !!row && row.expiresAt > now;
}

/** Lowercase hex SHA-256. Apple copies `request.nonce` into the identity token, and the
 * native client sets that property to this digest of the issued nonce. */
export function appleSignInNonceDigest(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/** The identity-token `nonce` claim is either the issued nonce or its SHA-256 hex. */
export function applePresentedNonceMatches(issuedNonce: string, tokenNonce: string | undefined): boolean {
  if (!issuedNonce || !tokenNonce) return false;
  return tokenNonce === issuedNonce || tokenNonce === appleSignInNonceDigest(issuedNonce);
}
