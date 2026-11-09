import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  currentAuthjsSessionCookieName,
  isKnownSessionCookieName,
  type KnownSessionCookieName,
} from "./auth/session-cookie-names";

const HANDOFF_TTL_MS = 2 * 60_000;
const MAX_HANDOFFS = 256;

type MobileAuthHandoff = {
  sessionToken: string;
  cookieName: KnownSessionCookieName;
  codeChallenge: string;
  expiresAt: number;
};

export type ConsumedMobileAuthHandoff = {
  sessionToken: string;
  cookieName: KnownSessionCookieName;
};

type MobileAuthHandoffStore = Map<string, MobileAuthHandoff>;

const globalForMobileAuth = globalThis as typeof globalThis & {
  __mobileAuthHandoffs?: MobileAuthHandoffStore;
};

function handoffs(): MobileAuthHandoffStore {
  return (globalForMobileAuth.__mobileAuthHandoffs ??= new Map());
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function verifierChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

function hasValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function cleanExpired(now: number): void {
  const store = handoffs();
  for (const [code, handoff] of store) {
    if (handoff.expiresAt <= now) store.delete(code);
  }
  while (store.size >= MAX_HANDOFFS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

/**
 * A browser-authenticated Auth.js session is never placed into the custom URL callback. The
 * callback carries only this random code; the native app must also prove possession of the PKCE
 * verifier it created before OAuth began. The code is one-use and stays only in server memory.
 */
export function createMobileAuthHandoff(input: {
  sessionToken: string;
  codeChallenge: string;
  cookieName?: string;
  now?: number;
}): string | undefined {
  if (!input.sessionToken || !hasValidCodeChallenge(input.codeChallenge)) return undefined;
  const cookieName = input.cookieName ?? currentAuthjsSessionCookieName();
  if (!isKnownSessionCookieName(cookieName)) return undefined;
  const now = input.now ?? Date.now();
  cleanExpired(now);
  const code = base64url(randomBytes(32));
  handoffs().set(code, {
    sessionToken: input.sessionToken,
    cookieName,
    codeChallenge: input.codeChallenge,
    expiresAt: now + HANDOFF_TTL_MS
  });
  return code;
}

export function consumeMobileAuthHandoff(input: {
  code: string;
  codeVerifier: string;
  now?: number;
}): ConsumedMobileAuthHandoff | undefined {
  const now = input.now ?? Date.now();
  cleanExpired(now);
  const handoff = handoffs().get(input.code);
  // Consume before comparison: a custom-scheme interception gets exactly one failed guess.
  handoffs().delete(input.code);
  if (!handoff || handoff.expiresAt <= now || !input.codeVerifier) return undefined;
  const expected = Buffer.from(handoff.codeChallenge, "utf8");
  const actual = Buffer.from(verifierChallenge(input.codeVerifier), "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return { sessionToken: handoff.sessionToken, cookieName: handoff.cookieName };
}
