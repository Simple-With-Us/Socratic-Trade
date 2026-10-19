import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";

import { resolveAscCredentials } from "./asc-api.mjs";

const NAMES = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH", "ASC_KEY_P8", "FLEET_SECRETS"];
const saved = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * Write a fake `fleet-secrets` that answers `get NAME --path /asc` from a fixed table
 * and exits 3 for anything else.  The tests never touch the real CLI or Infisical.
 */
function fakeFleetSecrets(t, table) {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "fleet-secrets");
  const cases = Object.entries(table)
    .map(([k, v]) => `  ${k}) printf '%s\\n' '${v}' ;;`)
    .join("\n");
  writeFileSync(
    bin,
    `#!/bin/sh\n[ "$1" = get ] && [ "$3" = --path ] && [ "$4" = /asc ] || exit 3\ncase "$2" in\n${cases}\n  *) exit 3 ;;\nesac\n`,
    "utf8"
  );
  chmodSync(bin, 0o755);
  process.env.FLEET_SECRETS = bin;
  return bin;
}

function clearAsc() {
  for (const k of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH", "ASC_KEY_P8"]) delete process.env[k];
}

test("resolveAscCredentials prefers process.env over fleet-secrets", (t) => {
  fakeFleetSecrets(t, { ASC_KEY_ID: "INF_ID", ASC_ISSUER_ID: "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "/env/key.p8";

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.keyPath, "/env/key.p8");
});

test("resolveAscCredentials falls back to Infisical /asc when env is unset", (t) => {
  fakeFleetSecrets(t, { ASC_KEY_ID: "INF_ID", ASC_ISSUER_ID: "inf-issuer", ASC_KEY_P8: "PEM-BODY" });
  clearAsc();

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "INF_ID");
  assert.equal(creds.issuerId, "inf-issuer");
  assert.equal(creds.keyPath, "");
  assert.equal(creds.keyPem, "PEM-BODY");
});

test("resolveAscCredentials falls back per variable", (t) => {
  fakeFleetSecrets(t, { ASC_KEY_ID: "INF_ID", ASC_ISSUER_ID: "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "inf-issuer");
});

test("resolveAscCredentials ignores blank env values in favour of Infisical", (t) => {
  fakeFleetSecrets(t, { ASC_KEY_ID: "INF_ID", ASC_ISSUER_ID: "inf-issuer" });
  clearAsc();
  process.env.ASC_KEY_ID = "   ";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "";

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "INF_ID");
  assert.equal(creds.issuerId, "env-issuer");
});

test("resolveAscCredentials uses the key file in env and skips the .p8 lookup", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, "key.p8");
  writeFileSync(keyFile, "x", "utf8");
  fakeFleetSecrets(t, { ASC_KEY_P8: "SHOULD-NOT-BE-USED" });
  clearAsc();
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = keyFile;

  const creds = resolveAscCredentials();
  assert.equal(creds.keyPath, keyFile);
  assert.equal(creds.keyPem, "");
});

test("resolveAscCredentials returns empty values when env and fleet-secrets have nothing", (t) => {
  fakeFleetSecrets(t, {});
  clearAsc();

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "");
  assert.equal(creds.issuerId, "");
  assert.equal(creds.keyPath, "");
  assert.equal(creds.keyPem, "");
});

test("resolveAscCredentials survives a missing fleet-secrets binary", () => {
  clearAsc();
  process.env.FLEET_SECRETS = "/nonexistent/fleet-secrets";

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "");
  assert.equal(creds.keyPem, "");
});
