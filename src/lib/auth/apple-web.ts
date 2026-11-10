/**
 * Web Sign in with Apple (Auth.js Apple provider).
 *
 * Required Infisical keys (prod env `/`, never print values):
 *   AUTH_APPLE_ID            Apple Services ID (e.g. services.jays.socratic.web)
 *   AUTH_APPLE_SECRET        Client-secret JWT (ES256, aud=https://appleid.apple.com)
 *
 * Optional components — used only when AUTH_APPLE_SECRET is unset, so the JWT
 * can be minted at process start instead of stored as a 6-month blob:
 *   AUTH_APPLE_TEAM_ID       Apple Developer Team ID (10-char)
 *   AUTH_APPLE_KEY_ID        Sign In with Apple key id
 *   AUTH_APPLE_PRIVATE_KEY   PEM of the SIWA .p8 (including BEGIN/END lines)
 *
 * These are NOT App Store Connect / APNs keys.  A team ASC .p8 or APNs .p8
 * cannot mint this JWT.  Apple only sends the user email on first authorization.
 */
import { createPrivateKey, sign as signDer } from "node:crypto";

export const APPLE_WEB_AUTH_REQUIRED_KEYS = ["AUTH_APPLE_ID", "AUTH_APPLE_SECRET"] as const;
export const APPLE_WEB_AUTH_COMPONENT_KEYS = [
  "AUTH_APPLE_TEAM_ID",
  "AUTH_APPLE_KEY_ID",
  "AUTH_APPLE_PRIVATE_KEY"
] as const;

type EnvSource = Record<string, string | undefined>;

function trimEnv(env: EnvSource, key: string): string {
  return (env[key] ?? "").trim();
}

export function appleWebAuthId(env: EnvSource = process.env): string {
  return trimEnv(env, "AUTH_APPLE_ID");
}

export function appleWebAuthComponentsPresent(env: EnvSource = process.env): boolean {
  return APPLE_WEB_AUTH_COMPONENT_KEYS.every((key) => trimEnv(env, key).length > 0);
}

/** True when the Auth.js Apple provider can be registered. */
export function isAppleWebAuthConfigured(env: EnvSource = process.env): boolean {
  if (!appleWebAuthId(env)) return false;
  return trimEnv(env, "AUTH_APPLE_SECRET").length > 0 || appleWebAuthComponentsPresent(env);
}

/**
 * Resolve the Apple client-secret JWT.  Prefers AUTH_APPLE_SECRET; otherwise
 * mints one from team/key/p8.  Returns undefined when web Apple cannot be armed.
 */
export function resolveAppleClientSecret(env: EnvSource = process.env): string | undefined {
  const stored = trimEnv(env, "AUTH_APPLE_SECRET");
  if (stored) return stored;
  const clientId = appleWebAuthId(env);
  const teamId = trimEnv(env, "AUTH_APPLE_TEAM_ID");
  const keyId = trimEnv(env, "AUTH_APPLE_KEY_ID");
  const privateKey = trimEnv(env, "AUTH_APPLE_PRIVATE_KEY");
  if (!clientId || !teamId || !keyId || !privateKey) return undefined;
  return mintAppleClientSecret({ clientId, teamId, keyId, privateKey });
}

export function mintAppleClientSecret(opts: {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  nowSec?: number;
  ttlSec?: number;
}): string {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSec ?? 86400 * 180;
  const header = { alg: "ES256", kid: opts.keyId };
  const payload = {
    iss: opts.teamId,
    iat: now,
    exp: now + ttl,
    aud: "https://appleid.apple.com",
    sub: opts.clientId
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${encodedHeader}.${encodedPayload}`;
  const pem = opts.privateKey.includes("BEGIN")
    ? opts.privateKey.replace(/\\n/g, "\n")
    : `-----BEGIN PRIVATE KEY-----\n${opts.privateKey}\n-----END PRIVATE KEY-----`;
  const key = createPrivateKey(pem);
  const sig = signDer("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `${data}.${sig.toString("base64url")}`;
}
