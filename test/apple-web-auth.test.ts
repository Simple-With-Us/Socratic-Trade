import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appleWebAuthComponentsPresent,
  isAppleWebAuthConfigured,
  mintAppleClientSecret,
  resolveAppleClientSecret
} from "../src/lib/auth/apple-web";

function testP8Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("web Apple Sign-In env gate", () => {
  it("is off when AUTH_APPLE_* is missing", () => {
    expect(isAppleWebAuthConfigured({})).toBe(false);
    expect(isAppleWebAuthConfigured({ AUTH_APPLE_ID: "com.example.web" })).toBe(false);
    expect(isAppleWebAuthConfigured({ AUTH_APPLE_SECRET: "jwt" })).toBe(false);
  });

  it("is on when AUTH_APPLE_ID + AUTH_APPLE_SECRET are set", () => {
    const env = { AUTH_APPLE_ID: "com.example.web", AUTH_APPLE_SECRET: "stored.jwt.value" };
    expect(isAppleWebAuthConfigured(env)).toBe(true);
    expect(resolveAppleClientSecret(env)).toBe("stored.jwt.value");
  });

  it("is on when the SIWA component keys can mint a JWT", () => {
    const pem = testP8Pem();
    const env = {
      AUTH_APPLE_ID: "com.example.web",
      AUTH_APPLE_TEAM_ID: "TEAMID1234",
      AUTH_APPLE_KEY_ID: "KEYID12345",
      AUTH_APPLE_PRIVATE_KEY: pem
    };
    expect(appleWebAuthComponentsPresent(env)).toBe(true);
    expect(isAppleWebAuthConfigured(env)).toBe(true);
    const jwt = resolveAppleClientSecret(env);
    expect(jwt).toBeTruthy();
    expect(jwt!.split(".")).toHaveLength(3);
  });

  it("mints a verifiable ES256 Apple client-secret JWT", () => {
    const pem = testP8Pem();
    const now = 1_776_000_000;
    const jwt = mintAppleClientSecret({
      clientId: "com.example.web",
      teamId: "TEAMID1234",
      keyId: "KEYID12345",
      privateKey: pem,
      nowSec: now,
      ttlSec: 3600
    });
    const [headerB64, payloadB64] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf8")) as {
      alg: string;
      kid: string;
    };
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as {
      iss: string;
      sub: string;
      aud: string;
      iat: number;
      exp: number;
    };
    expect(header).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(payload).toMatchObject({
      iss: "TEAMID1234",
      sub: "com.example.web",
      aud: "https://appleid.apple.com",
      iat: now,
      exp: now + 3600
    });
    expect(createPrivateKey(pem).asymmetricKeyType).toBe("ec");
  });
});
