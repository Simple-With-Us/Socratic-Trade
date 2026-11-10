import { randomBytes } from "node:crypto";
import { createHash, timingSafeEqual } from "node:crypto";

const PREPARE_TTL_MS = 5 * 60_000;
const MAX_PREPARED = 256;

type PreparedHandoff = {
  codeChallenge: string;
  expiresAt: number;
};

const globalForHandoffPrepare = globalThis as typeof globalThis & {
  __mobileHandoffPrepared?: Map<string, PreparedHandoff>;
};

function prepared(): Map<string, PreparedHandoff> {
  return (globalForHandoffPrepare.__mobileHandoffPrepared ??= new Map());
}

function verifierChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function hasValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function purge(now: number): void {
  const map = prepared();
  for (const [nonce, row] of map) {
    if (row.expiresAt <= now) map.delete(nonce);
  }
  while (map.size >= MAX_PREPARED) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

export function issueMobileHandoffPrepare(codeChallenge: string, now: number = Date.now()): string | undefined {
  if (!hasValidCodeChallenge(codeChallenge)) return undefined;
  purge(now);
  const nonce = randomBytes(32).toString("base64url");
  prepared().set(nonce, { codeChallenge, expiresAt: now + PREPARE_TTL_MS });
  return nonce;
}

export function consumeMobileHandoffPrepare(input: {
  handoffNonce: string;
  codeChallenge: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  purge(now);
  const row = prepared().get(input.handoffNonce);
  prepared().delete(input.handoffNonce);
  if (!row || row.expiresAt <= now || !hasValidCodeChallenge(input.codeChallenge)) return false;
  const expected = Buffer.from(row.codeChallenge, "utf8");
  const actual = Buffer.from(input.codeChallenge, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export { hasValidCodeChallenge, verifierChallenge };
