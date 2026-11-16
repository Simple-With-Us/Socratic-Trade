#!/usr/bin/env node
// Pre-`npm run dev` warning: if SECRETS_SOURCE is unset AND neither a bootstrap identity in the
// macOS login Keychain (service `socratic-trade-bootstrap`) nor an explicit INFISICAL_* identity
// is present, tell the operator how to use the Infisical
// runner. Never fail the dev boot (we still want `npm run dev` to work for tests / UI-only work
// where no credentials are needed). Added 2026-09-18 with the "no .env files anywhere" cutover.
//
// This is `predev` in package.json. npm only invokes it before `npm run dev`, not before
// `npm run dev:secrets` (which sets SECRETS_SOURCE=infisical before reaching here).

// ESM imports, not require(): this is a .mjs file, where `require` is undefined (ReferenceError on
// every plain `npm run dev`) and @typescript-eslint/no-require-imports fails the lint gate.
import { spawnSync } from "node:child_process";

const KEYCHAIN_SERVICE = "socratic-trade-bootstrap";
// Presence only: no `-w`/`-g`, so the secret is never read here.  macOS only.
function keychainHas(account) {
  if (process.platform !== "darwin" || process.env.SOCRATIC_BOOTSTRAP_KEYCHAIN === "off") return false;
  try {
    const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return r.status === 0;
  } catch { return false; }
}

const source = (process.env.SECRETS_SOURCE ?? "").trim().toLowerCase();
const hasInfisicalIdentity =
  !!process.env.INFISICAL_CLIENT_ID ||
  !!process.env.INFISICAL_TOKEN ||
  !!process.env.INFISICAL_ST_CLIENT_ID ||
  !!process.env.INFIISICAL_ST_CLIENT_ID;

const keychainIdentity =
  keychainHas("INFISICAL_ST_CLIENT_ID") ||
  keychainHas("INFIISICAL_ST_CLIENT_ID");

if (source === "infisical") {
  // The runner is in charge. No warning.
  process.exit(0);
}

if (hasInfisicalIdentity || keychainIdentity) {
  // The operator has SOME path to Infisical configured but chose `npm run dev` plain. They
  // probably want dev:secrets but might just be running tests. Tell them once.
  console.warn(
    "\n[predev] SECRETS_SOURCE is not 'infisical'.\n" +
    "  You're running `npm run dev` plain. The Infisical runner is the canonical start path:\n" +
    "    npm run dev:secrets\n" +
    "  Plain `npm run dev` works for UI-only work and tests; if you need API keys to load,\n" +
    "  switch to dev:secrets (see docs/secrets.md).\n"
  );
  process.exit(0);
}

// No Infisical identity in the env or the Keychain. Loud one-time notice — but don't fail, because
// tests and pure-UI development must still boot.
console.warn(
  "\n[predev] No Infisical identity configured.\n" +
  "  Plain `npm run dev` will boot without credentials. To load keys via the Infisical runner:\n" +
  "    1. Add the bootstrap identity to the macOS login Keychain, once per name\n" +
  "       (INFISICAL_ST_CLIENT_ID, INFISICAL_ST_CLIENT_SECRET):\n" +
  "         security add-generic-password -U -s socratic-trade-bootstrap -a NAME -w\n" +
  "       (enter the value at the prompt), OR\n" +
  "    2. Set INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET in the env, OR\n" +
  "    3. Use `npm run dev:secrets` which launches scripts/infisical-run.mjs.\n" +
  "  See docs/secrets.md.\n"
);
process.exit(0);