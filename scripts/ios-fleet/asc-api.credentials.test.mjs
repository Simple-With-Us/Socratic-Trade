import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";

import { resolveAscCredentials } from "./asc-api.mjs";

const saved = {
  ASC_KEY_ID: process.env.ASC_KEY_ID,
  ASC_ISSUER_ID: process.env.ASC_ISSUER_ID,
  ASC_KEY_PATH: process.env.ASC_KEY_PATH,
  ASC_SECRETS_ENV: process.env.ASC_SECRETS_ENV,
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * Write a secrets file into a fresh temp dir and register cleanup with `t.after`
 * so the dir is removed even when an assertion throws mid-test.
 */
function writeSecretsFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, "appstore-connect.env");
  writeFileSync(
    envPath,
    "ASC_KEY_ID=FILE_ID\nASC_ISSUER_ID=file-issuer\nASC_KEY_PATH=/file/key.p8\n",
    "utf8"
  );
  return envPath;
}

test("resolveAscCredentials prefers process.env over the secrets file", (t) => {
  const envPath = writeSecretsFile(t);
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "/env/key.p8";

  const creds = resolveAscCredentials(envPath);
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.keyPath, "/env/key.p8");
});

test("resolveAscCredentials falls back to the secrets file when env is unset", (t) => {
  const envPath = writeSecretsFile(t);
  delete process.env.ASC_KEY_ID;
  delete process.env.ASC_ISSUER_ID;
  delete process.env.ASC_KEY_PATH;

  const creds = resolveAscCredentials(envPath);
  assert.equal(creds.keyId, "FILE_ID");
  assert.equal(creds.issuerId, "file-issuer");
  assert.equal(creds.keyPath, "/file/key.p8");
});

test("resolveAscCredentials falls back to the secrets file per variable", (t) => {
  const envPath = writeSecretsFile(t);
  process.env.ASC_KEY_ID = "ENV_ID";
  delete process.env.ASC_ISSUER_ID;
  delete process.env.ASC_KEY_PATH;

  const creds = resolveAscCredentials(envPath);
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "file-issuer");
  assert.equal(creds.keyPath, "/file/key.p8");
});

test("resolveAscCredentials ignores blank env values in favour of the file", (t) => {
  const envPath = writeSecretsFile(t);
  process.env.ASC_KEY_ID = "   ";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "";

  const creds = resolveAscCredentials(envPath);
  assert.equal(creds.keyId, "FILE_ID");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.keyPath, "/file/key.p8");
});

test("resolveAscCredentials works with a missing secrets file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, "does-not-exist.env");
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "/env/key.p8";

  const creds = resolveAscCredentials(envPath);
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.keyPath, "/env/key.p8");
});

test("resolveAscCredentials with no path uses only process.env (no implicit secrets file)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, "appstore-connect.env");
  writeFileSync(
    envPath,
    "ASC_KEY_ID=FILE_ID\nASC_ISSUER_ID=file-issuer\nASC_KEY_PATH=/file/key.p8\n",
    "utf8"
  );
  delete process.env.ASC_SECRETS_ENV;
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "/env/key.p8";

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.envPath, "");
});

test("resolveAscCredentials reads ASC_SECRETS_ENV when set", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envPath = join(dir, "appstore-connect.env");
  writeFileSync(
    envPath,
    "ASC_KEY_ID=FILE_ID\nASC_ISSUER_ID=file-issuer\nASC_KEY_PATH=/file/key.p8\n",
    "utf8"
  );
  delete process.env.ASC_KEY_ID;
  delete process.env.ASC_ISSUER_ID;
  delete process.env.ASC_KEY_PATH;
  process.env.ASC_SECRETS_ENV = envPath;

  const creds = resolveAscCredentials();
  assert.equal(creds.keyId, "FILE_ID");
  assert.equal(creds.envPath, envPath);
});

test("resolveAscCredentials ignores a secrets path that throws on read", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.ASC_KEY_ID = "ENV_ID";
  process.env.ASC_ISSUER_ID = "env-issuer";
  process.env.ASC_KEY_PATH = "/env/key.p8";

  const creds = resolveAscCredentials(dir);
  assert.equal(creds.keyId, "ENV_ID");
  assert.equal(creds.issuerId, "env-issuer");
  assert.equal(creds.keyPath, "/env/key.p8");
});
