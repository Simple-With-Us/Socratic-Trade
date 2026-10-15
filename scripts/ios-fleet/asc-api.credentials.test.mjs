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
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function withTempSecretsFile(body) {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-"));
  const envPath = join(dir, "appstore-connect.env");
  try {
    return body(envPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveAscCredentials prefers process.env over the secrets file", () => {
  withTempSecretsFile((envPath) => {
    writeFileSync(
      envPath,
      "ASC_KEY_ID=FILE_ID\nASC_ISSUER_ID=file-issuer\nASC_KEY_PATH=/file/key.p8\n",
      "utf8"
    );
    process.env.ASC_KEY_ID = "ENV_ID";
    process.env.ASC_ISSUER_ID = "env-issuer";
    process.env.ASC_KEY_PATH = "/env/key.p8";

    const creds = resolveAscCredentials(envPath);
    assert.equal(creds.keyId, "ENV_ID");
    assert.equal(creds.issuerId, "env-issuer");
    assert.equal(creds.keyPath, "/env/key.p8");
  });
});

test("resolveAscCredentials falls back to the secrets file when env is unset", () => {
  withTempSecretsFile((envPath) => {
    writeFileSync(
      envPath,
      "ASC_KEY_ID=FILE_ID\nASC_ISSUER_ID=file-issuer\nASC_KEY_PATH=/file/key.p8\n",
      "utf8"
    );
    delete process.env.ASC_KEY_ID;
    delete process.env.ASC_ISSUER_ID;
    delete process.env.ASC_KEY_PATH;

    const creds = resolveAscCredentials(envPath);
    assert.equal(creds.keyId, "FILE_ID");
    assert.equal(creds.issuerId, "file-issuer");
    assert.equal(creds.keyPath, "/file/key.p8");
  });
});

test("resolveAscCredentials picks env per variable when only some ASC_* are set", () => {
  withTempSecretsFile((envPath) => {
    writeFileSync(
      envPath,
      "ASC_KEY_ID=FILE_ID\nASC_ISSUER_ID=file-issuer\nASC_KEY_PATH=/file/key.p8\n",
      "utf8"
    );
    process.env.ASC_KEY_ID = "ENV_ID";
    delete process.env.ASC_ISSUER_ID;
    delete process.env.ASC_KEY_PATH;

    const creds = resolveAscCredentials(envPath);
    assert.equal(creds.keyId, "ENV_ID");
    assert.equal(creds.issuerId, "file-issuer");
    assert.equal(creds.keyPath, "/file/key.p8");
  });
});
