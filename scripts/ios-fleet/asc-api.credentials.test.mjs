// The client's credential resolution:  the source order is the rule.
//
// AFC-459, revision 2.  The private key is a secret, and the approved sources
// are the process environment and a captured `fleet-secrets get`.  A path on
// disk is not one of them, so ASC_KEY_PATH is never a source:  a named path
// is ignored wherever it appears, so a stale path in an operator's shell can
// never decide which key signs a request.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and the fake fleet-secrets never reaches Infisical.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";

import { resolveAscCredentials } from "./asc-api.mjs";

const NAMES = [
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "ASC_KEY_PATH",
  "ASC_KEY_P8",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_P8_BASE64",
  "FLEET_SECRETS"
];
const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
const savedHome = process.env.HOME;

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function makeKey() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
    .export({ type: "pkcs8", format: "pem" });
}

const envPem = makeKey();
const otherPem = makeKey();

/**
 * Write a fake `fleet-secrets` that answers `get NAME --path FOLDER` from a
 * fixed table and exits 3 for anything else.  The tests never touch the real
 * CLI or Infisical.
 */
function fakeFleetSecrets(t, table) {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fleet-secrets");
  const cases = Object.entries(table)
    .map(([k, v]) => `  ${k}) printf '%s\\n' '${v.replace(/'/g, "'\\''")}' ;;`)
    .join("\n");
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = get ] && [ "$3" = --path ] || exit 3\ncase "$4:$2" in\n${cases}\n  *) exit 3 ;;\nesac\n`,
    "utf8"
  );
  chmodSync(bin, 0o755);
  process.env.FLEET_SECRETS = bin;
  //  The client falls back to ~/.local/bin/fleet-secrets when FLEET_SECRETS
  //  does not answer, so HOME points at a scratch directory:  the real reader
  //  is never reached.
  const home = join(dir, "home");
  writeFileSync(join(dir, "placeholder"), "", "utf8");
  process.env.HOME = home;
  return bin;
}

function clearAsc() {
  //  FLEET_SECRETS is not a credential:  it names the fake binary, so it
  //  stays put and the real reader is never reached.
  for (const k of NAMES) {
    if (k === "FLEET_SECRETS") continue;
    delete process.env[k];
  }
}

test("resolveAscCredentials takes the APPLE_API_* trio first", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.APPLE_API_KEY_ID = "APPLE_ID";
  process.env.APPLE_API_ISSUER_ID = "apple-issuer";
  process.env.APPLE_API_KEY_P8_BASE64 = Buffer.from(otherPem, "utf8").toString("base64");
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_P8 = envPem;

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "APPLE_ID");
  assert.equal(creds.issuerId, "apple-issuer");
  assert.equal(creds.source, "APPLE_API_* environment (base64 p8)");
  assert.equal(creds.privateKeyPem.trim(), otherPem.trim());
});

test("resolveAscCredentials takes the ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 trio from the environment", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_P8 = envPem;

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.source, "ASC_KEY_P8 environment");
  assert.equal(creds.privateKeyPem.trim(), envPem.trim());
});

test("resolveAscCredentials ignores a named ASC_KEY_PATH", (t) => {
  //  A path on disk is not an approved credential source, so a named path is
  //  ignored:  the credential is the one in the environment, and the file is
  //  never read.
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "key.p8");
  writeFileSync(keyFile, otherPem, "utf8");
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_P8 = envPem;
  process.env.ASC_KEY_PATH = keyFile;

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.source, "ASC_KEY_P8 environment");
  assert.equal(creds.privateKeyPem.trim(), envPem.trim());
  assert.notEqual(creds.privateKeyPem.trim(), otherPem.trim());
  assert.equal(creds.keyPath, undefined);
});

test("resolveAscCredentials falls back to Infisical /asc when env is unset", (t) => {
  fakeFleetSecrets(t, {
    "/asc:ASC_KEY_ID": "INF_ID",
    "/asc:ASC_ISSUER_ID": "inf-issuer",
    "/asc:ASC_KEY_P8": envPem
  });
  clearAsc();

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "INF_ID");
  assert.equal(creds.issuerId, "inf-issuer");
  assert.equal(creds.source, "Infisical /asc");
  assert.equal(creds.privateKeyPem.trim(), envPem.trim());
});

test("resolveAscCredentials falls back per variable", (t) => {
  //  The key id and the issuer may come from different places, as long as
  //  the key id is the /asc one.
  fakeFleetSecrets(t, {
    "/asc:ASC_KEY_ID": "INF_ID",
    "/asc:ASC_ISSUER_ID": "inf-issuer",
    "/asc:ASC_KEY_P8": envPem
  });
  clearAsc();
  process.env.ASC_KEY_ID = "INF_ID";

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "INF_ID");
  assert.equal(creds.issuerId, "inf-issuer");
  assert.equal(creds.source, "Infisical /asc");
});

test("resolveAscCredentials ignores blank env values in favour of Infisical", (t) => {
  fakeFleetSecrets(t, {
    "/asc:ASC_KEY_ID": "INF_ID",
    "/asc:ASC_ISSUER_ID": "inf-issuer",
    "/asc:ASC_KEY_P8": envPem
  });
  clearAsc();
  process.env.ASC_KEY_ID = "   ";
  process.env.ASC_ISSUER_ID = "env-issuer";

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "INF_ID");
  //  A blank key id falls back to Infisical, and an issuer named in the
  //  environment belongs to the key named with it:  the environment named no
  //  key id, so the issuer is the /asc one.
  assert.equal(creds.issuerId, "inf-issuer");
  assert.equal(creds.source, "Infisical /asc");
});

test("resolveAscCredentials never pairs an environment issuer with the /asc key", (t) => {
  //  The issuer belongs to a key.  When the environment names an issuer but
  //  no key id, the key comes from Infisical, so the issuer has to come from
  //  there too:  a stale issuer would be paired with the /asc key and App
  //  Store Connect would answer 401 with a mismatched input.
  fakeFleetSecrets(t, {
    "/asc:ASC_KEY_ID": "INF_ID",
    "/asc:ASC_ISSUER_ID": "inf-issuer",
    "/asc:ASC_KEY_P8": envPem
  });
  clearAsc();
  process.env.ASC_ISSUER_ID = "stale-env-issuer";

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "INF_ID");
  assert.equal(creds.issuerId, "inf-issuer");
  assert.equal(creds.source, "Infisical /asc");
});

test("resolveAscCredentials keeps an environment issuer with the environment key id", (t) => {
  //  The environment named both, so they belong together.
  fakeFleetSecrets(t, {
    "/asc:ASC_KEY_ID": "INF_ID",
    "/asc:ASC_ISSUER_ID": "inf-issuer",
    "/asc:ASC_KEY_P8": envPem
  });
  clearAsc();
  process.env.ASC_KEY_ID = "ENVKEYID1";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_P8 = envPem;

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "ENVKEYID1");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.source, "ASC_KEY_P8 environment");
});

test("resolveAscCredentials gives a key id that is not the /asc one its own key", (t) => {
  //  The /asc issuer belongs to the /asc key, so a different key id gets its
  //  own .p8 from /authkey-<id>-p8.
  fakeFleetSecrets(t, {
    "/asc:ASC_KEY_ID": "INF_ID",
    "/asc:ASC_ISSUER_ID": "inf-issuer",
    "/authkey-otherkey01-p8:AUTHKEY_OTHERKEY01": otherPem
  });
  clearAsc();
  process.env.ASC_KEY_ID = "OTHERKEY01";
  process.env.ASC_ISSUER_ID = "issuer-other";

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.keyId, "OTHERKEY01");
  assert.equal(creds.issuerId, "issuer-other");
  assert.equal(creds.privateKeyPem.trim(), otherPem.trim());
});

test("resolveAscCredentials refuses an ASC_KEY_P8 that is not a PEM private key", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_P8 = "not a private key";

  const creds = resolveAscCredentials();
  assert.match(creds.error, /is not a PEM private key/);
  assert.equal(creds.privateKeyPem, undefined);
});

test("resolveAscCredentials refuses an APPLE_API_KEY_P8_BASE64 that is not a key", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.APPLE_API_KEY_ID = "APPLE_ID";
  process.env.APPLE_API_ISSUER_ID = "apple-issuer";
  process.env.APPLE_API_KEY_P8_BASE64 = Buffer.from("not a private key", "utf8").toString("base64");

  const creds = resolveAscCredentials();
  assert.match(creds.error, /did not decode to a PEM private key/);
  assert.equal(creds.privateKeyPem, undefined);
});

test("resolveAscCredentials accepts a raw PEM in APPLE_API_KEY_P8_BASE64", (t) => {
  //  The shell layer accepts a PEM in that variable as well as a base64 body,
  //  so both layers have to agree on what a key looks like.
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.APPLE_API_KEY_ID = "APPLE_ID";
  process.env.APPLE_API_ISSUER_ID = "apple-issuer";
  process.env.APPLE_API_KEY_P8_BASE64 = otherPem;

  const creds = resolveAscCredentials();
  assert.equal(creds.error, undefined);
  assert.equal(creds.source, "APPLE_API_* environment (base64 p8)");
  assert.equal(creds.privateKeyPem.trim(), otherPem.trim());
});

test("a refused value is reported with a masked preview, never with the value", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_P8 = "not a private key at all";

  const creds = resolveAscCredentials();
  assert.match(creds.error, /preview: not a pr\.\.\. all/);
  assert.ok(!creds.error.includes("not a private key at all"), "the refused value was printed");
  assert.equal(creds.privateKeyPem, undefined);
});

test("resolveAscCredentials names the key material that is missing", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";

  const creds = resolveAscCredentials();
  assert.match(creds.error, /the App Store Connect private key is missing/);
  assert.match(creds.error, /AUTHKEY_ENV_ID in Infisical \/authkey-env_id-p8/);
  assert.equal(creds.privateKeyPem, undefined);
});

test("resolveAscCredentials names the /asc key material for the /asc key id", (t) => {
  fakeFleetSecrets(t, { "/asc:ASC_KEY_ID": "INF_ID", "/asc:ASC_ISSUER_ID": "inf-issuer" });
  clearAsc();

  const creds = resolveAscCredentials();
  assert.match(creds.error, /the App Store Connect private key is missing/);
  assert.match(creds.error, /ASC_KEY_P8 in Infisical \/asc/);
  assert.equal(creds.privateKeyPem, undefined);
});

test("resolveAscCredentials has no credential when env and fleet-secrets have nothing", (t) => {
  fakeFleetSecrets(t, {});
  clearAsc();

  const creds = resolveAscCredentials();
  assert.equal(creds.error, null);
  assert.equal(creds.privateKeyPem, undefined);
  assert.ok(!creds.keyId, "a key id came out of nowhere");
  assert.ok(!creds.issuerId, "an issuer came out of nowhere");
});

test("resolveAscCredentials survives a missing fleet-secrets binary", () => {
  clearAsc();
  process.env.FLEET_SECRETS = "/nonexistent/fleet-secrets";
  process.env.HOME = join(tmpdir(), "asc-cred-no-home");

  const creds = resolveAscCredentials();
  assert.equal(creds.error, null);
  assert.equal(creds.privateKeyPem, undefined);
});
