// The App Store Connect key module:  how a key is validated, how it is staged
// for the Apple tools that need a key file, and what the client is allowed to
// read.
//
// AFC-459, revision 2.  The private key is a secret, and the approved secret
// sources are the process environment, a captured `fleet-secrets get NAME` and
// bootstrap-only Keychain credentials.  A caller-supplied file is not one of
// them, so NOTHING here reads a key file:  the module validates a key, writes
// a short-lived owner-only materialization for altool and Xcode, and hands the
// key to a child in an allowlisted environment.  The file it writes is never
// read back as a credential.
//
// Everything here is synthetic:  the keys are generated at test time and are
// never committed, and nothing reaches the network beyond a loopback server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CLIENT_ENV_ALLOWLIST,
  clientEnvironment,
  normalizePrivateKey,
  writePrivateKeyFile
} from "./asc-key.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, "asc-key.mjs");
const client = join(here, "asc-api.mjs");
const root = mkdtempSync(join(tmpdir(), "asc-key-test-"));
//  A PATH with node and nothing else:  the fleet reader lives in the operator's
//  own bin directory, and a test must never reach it or Infisical.
const safePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

function makeKey() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
    .export({ type: "pkcs8", format: "pem" });
}

const keyPem = makeKey();
const otherPem = makeKey();

function run(args, stdin = "", env = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [modulePath, ...args], {
      ...(env ? { env } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function spawnNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A loopback App Store Connect, so the client can be driven for real without
// touching Apple's servers.
function localServer() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || "" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      seen,
      close: () => server.close()
    }));
  });
}

function bearer(authorization) {
  return String(authorization || "").replace(/^Bearer /, "");
}

function jwtHeader(token) {
  return JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString());
}

// Verify an ES256 JWT against a PEM.  This is how a test proves WHICH key
// signed a request, without ever looking at the key itself.
function verifiesWith(token, pem) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return false;
  const verifier = createVerify("SHA256");
  verifier.update(Buffer.from(`${parts[0]}.${parts[1]}`));
  verifier.end();
  try {
    return verifier.verify(
      { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url")
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The module itself
// ---------------------------------------------------------------------------

test("the module exports exactly the four approved helpers", async () => {
  const mod = await import("./asc-key.mjs");
  const names = Object.keys(mod).sort();
  assert.deepEqual(names, [
    "CLIENT_ENV_ALLOWLIST",
    "clientEnvironment",
    "normalizePrivateKey",
    "writePrivateKeyFile"
  ]);
  //  The rejected revision-1 helpers are gone:  a path on disk is not an
  //  approved credential source, so there is no reader and no exec wrapper.
  assert.equal(mod.readPrivateKeyFile, undefined);
  assert.equal(mod.execWithKey, undefined);
});

test("the module never reads a file", () => {
  const source = readFileSync(modulePath, "utf8");
  //  A file read is the whole defect revision 2 removes, so the module text
  //  must not contain one, nor the flags a hardened reader would need.
  for (const needle of ["readFileSync", "readFile", "openSync", "O_NOFOLLOW", "createReadStream"]) {
    assert.ok(!source.includes(needle), `asc-key.mjs still mentions ${needle}`);
  }
  //  And there is no read or exec subcommand.
  assert.ok(!/command === "read"/.test(source), "asc-key.mjs still has a read subcommand");
  assert.ok(!/command === "exec"/.test(source), "asc-key.mjs still has an exec subcommand");
});

test("a generated key is accepted and comes back with a trailing newline", () => {
  const normalized = normalizePrivateKey(keyPem);
  assert.ok(normalized, "a real key was refused");
  assert.ok(normalized.endsWith("\n"), "the key has to end with a newline");
  assert.equal(normalized.trim(), keyPem.trim());
});

test("a PEM stored with literal backslash-n separators is a real key", () => {
  //  The shell layer, this module and the client all have to agree on what a
  //  key is, so the separators become newlines in the one place they use.
  const literal = keyPem.split("\n").join("\\n");
  const normalized = normalizePrivateKey(literal);
  assert.ok(normalized, "a key with literal separators was refused");
  assert.equal(normalized.trim(), keyPem.trim());
  assert.ok(normalized.includes("\n"), "the separators were not turned into newlines");
});

test("a malformed PEM is refused, because the envelope is not a key", () => {
  //  A truncated key, an armored block and a mangled export all carry the
  //  envelope and still fail to parse.  Accepting them would hand the signer
  //  something it cannot use, and the failure would come back as a stack
  //  trace instead of a credential error.
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\nnot base64 at all\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n"), null); // gitleaks:allow
  assert.equal(normalizePrivateKey(""), null);
  assert.equal(normalizePrivateKey(undefined), null);
  assert.equal(normalizePrivateKey("hunter2"), null);
});

test("a key written to a file is one only its owner can read", () => {
  const path = join(root, "written.p8");
  const written = writePrivateKeyFile(path, keyPem);
  assert.ok(written.pem, `the key was not written: ${written.error}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), keyPem.trim());
});

test("a value that is not a key is not written", () => {
  const path = join(root, "refused.p8");
  const written = writePrivateKeyFile(path, "not a private key");
  assert.ok(written.error, "a value that is not a key was written");
  assert.match(written.error, /not a PEM private key/);
});

// ---------------------------------------------------------------------------
// The allowlisted child environment
// ---------------------------------------------------------------------------

test("the allowlist names the variables the client reads and no path", () => {
  for (const name of [
    "PATH", "HOME", "ASC_KEY_ID", "ASC_ISSUER_ID",
    "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"
  ]) {
    assert.ok(CLIENT_ENV_ALLOWLIST.includes(name), `${name} is not on the allowlist`);
  }
  //  A named path is not a credential source, so it is never handed on.
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("ASC_KEY_PATH"), "ASC_KEY_PATH is on the allowlist");
  //  The key itself is added separately, under its own name only.
  assert.ok(!CLIENT_ENV_ALLOWLIST.includes("ASC_KEY_P8"), "ASC_KEY_P8 is on the allowlist");
});

test("a child's environment is an allowlist, not a copy of the parent's", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    ASC_KEY_ID: "SYNTHETICKEYID1",
    AWS_SECRET_ACCESS_KEY: "not-the-clients-business",
    SENTRY_AUTH_TOKEN: "also-not-the-clients-business",
    OPENAI_API_KEY: "nor-this"
  };
  const child = clientEnvironment(parent);
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.ASC_KEY_ID, "SYNTHETICKEYID1");
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.SENTRY_AUTH_TOKEN, undefined);
  assert.equal(child.OPENAI_API_KEY, undefined);
});

test("the key reaches the child in its environment and nowhere else", () => {
  const child = clientEnvironment({ PATH: "/usr/bin", HOME: "/home/someone" }, { ASC_KEY_P8: keyPem });
  assert.equal(child.ASC_KEY_P8, keyPem);
  assert.equal(Object.keys(child).filter((k) => child[k] === keyPem).length, 1);
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("the command line reports the status of a key and never prints it", async () => {
  //  A key on stdout is a key in every log that captures it, so the module
  //  reports whether the value is usable and nothing else.
  const ok = await run(["validate"], keyPem);
  assert.equal(ok.code, 0, `the key was refused: ${ok.stderr}`);
  assert.match(ok.stdout, /is a PEM private key/, `the status was not reported:\n${ok.stdout}`);
  assert.doesNotMatch(ok.stdout, /PRIVATE KEY/, "the key reached stdout");
  assert.doesNotMatch(ok.stderr, /PRIVATE KEY/, "the key reached stderr");
});

test("the command line refuses a value that is not a key", async () => {
  const bad = await run(["validate"], "not a private key");
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /not a PEM private key/);
  assert.equal(bad.stdout, "", "a refused key must not put anything on stdout");
});

test("the command line writes a key to a file only its owner can read", async () => {
  const path = join(root, "cli.p8");
  const result = await run(["write", path], keyPem);
  assert.equal(result.code, 0, `the write failed: ${result.stderr}`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8").trim(), keyPem.trim());
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/, "the key reached the output");
});

test("there is no read subcommand and no exec subcommand", async () => {
  const path = join(root, "no-reader.p8");
  writeFileSync(path, keyPem);
  chmodSync(path, 0o600);
  for (const args of [["read", path], ["exec", path], ["read"], ["exec"]]) {
    const result = await run(args, keyPem);
    assert.notEqual(result.code, 0, `asc-key.mjs ${args[0]} was accepted`);
    assert.match(result.stderr, /usage: asc-key\.mjs/, `asc-key.mjs ${args[0]} did not report the usage`);
  }
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

test("the client takes the key from the environment and ignores a named ASC_KEY_PATH", async () => {
  const server = await localServer();
  try {
    //  A named path that holds a DIFFERENT key.  If the client read it, the
    //  request would be signed with that key instead of the one in the
    //  environment.
    const namedPath = join(root, "named.p8");
    writeFileSync(namedPath, otherPem);
    chmodSync(namedPath, 0o600);

    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-env"),
      ASC_KEY_ID: "ENVKEY0001",
      ASC_ISSUER_ID: "env-issuer",
      ASC_KEY_P8: keyPem,
      ASC_KEY_PATH: namedPath
    });
    assert.equal(result.code, 0, `the client refused the environment key: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using ASC_KEY_P8 environment/,
      `the client did not report the environment source:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /ASC_KEY_PATH/,
      "the client reported the named path as a source");
    assert.ok(server.seen.length > 0, "the client never reached App Store Connect");

    const token = bearer(server.seen[0].authorization);
    assert.equal(jwtHeader(token).kid, "ENVKEY0001", "the request was not signed with the named key id");
    assert.ok(verifiesWith(token, keyPem), "the request was not signed with the environment key");
    assert.ok(!verifiesWith(token, otherPem), "the request was signed with the named key file");
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/, "the key reached the output");
  } finally {
    server.close();
  }
});

test("the client does not need a named path at all", async () => {
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-nopath"),
      ASC_KEY_ID: "ENVKEY0002",
      ASC_ISSUER_ID: "env-issuer",
      ASC_KEY_P8: keyPem
    });
    assert.equal(result.code, 0, `the client refused the environment key: ${result.stderr}`);
    assert.ok(server.seen.length > 0, "the client never reached App Store Connect");
  } finally {
    server.close();
  }
});

test("the APPLE_API_* trio wins over the ASC_* trio", async () => {
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-apple"),
      APPLE_API_KEY_ID: "APPLEKEY001",
      APPLE_API_ISSUER_ID: "apple-issuer",
      APPLE_API_KEY_P8_BASE64: Buffer.from(otherPem, "utf8").toString("base64"),
      ASC_KEY_ID: "ENVKEY0003",
      ASC_ISSUER_ID: "env-issuer",
      ASC_KEY_P8: keyPem
    });
    assert.equal(result.code, 0, `the client refused the environment key: ${result.stderr}`);
    assert.match(result.stderr, /asc-auth: using APPLE_API_\* environment/,
      `the client did not report the APPLE_API_* source:\n${result.stderr}`);
    const token = bearer(server.seen[0].authorization);
    assert.equal(jwtHeader(token).kid, "APPLEKEY001");
    assert.ok(verifiesWith(token, otherPem), "the request was not signed with the APPLE_API_* key");
    assert.ok(!verifiesWith(token, keyPem), "the ASC_* key won over the APPLE_API_* key");
  } finally {
    server.close();
  }
});

test("an ASC_KEY_P8 that is not a PEM private key is a credential error", async () => {
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: safePath,
    HOME: join(root, "home-badkey"),
    ASC_KEY_ID: "ENVKEY0004",
    ASC_ISSUER_ID: "env-issuer",
    ASC_KEY_P8: "not a private key"
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /is not a PEM private key/);
});

test("with no credential at all the client names the three sources and refuses a path", async () => {
  //  A bare PATH and a throwaway HOME keep the fleet reader out of the way,
  //  so the client really has no source left.
  const result = await spawnNode([client, "GET", "http://127.0.0.1:1/v1/apps"], {
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home-empty"),
    ASC_KEY_ID: "ENVKEY0005",
    ASC_ISSUER_ID: "env-issuer",
    ASC_KEY_PATH: join(root, "named.p8")
  });
  assert.equal(result.code, 1, `expected the refusal exit, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /no App Store Connect credential found/);
  assert.match(result.stderr, /APPLE_API_KEY_ID \/ APPLE_API_ISSUER_ID \/ APPLE_API_KEY_P8_BASE64/);
  assert.match(result.stderr, /ASC_KEY_ID \/ ASC_ISSUER_ID \/ ASC_KEY_P8/);
  assert.match(result.stderr, /Fleet-OPS prod \/asc through fleet-secrets/);
  assert.match(result.stderr, /A path in ASC_KEY_PATH is not a credential source/);
});

test("the key never travels in the command arguments of the client", async () => {
  const server = await localServer();
  try {
    const result = await spawnNode([client, "GET", `${server.base}/v1/apps`], {
      PATH: safePath,
      HOME: join(root, "home-argv"),
      ASC_KEY_ID: "ENVKEY0006",
      ASC_ISSUER_ID: "env-issuer",
      ASC_KEY_P8: keyPem
    });
    assert.equal(result.code, 0, `the client refused the environment key: ${result.stderr}`);
    //  The key is in the environment, never in the arguments of the process
    //  and never in its output:  a distinctive line of the PEM body is the
    //  needle, so a leak of any part of it is caught.
    const needle = keyPem.split("\n").find((line) => line.length > 32);
    assert.ok(needle, "the fixture key has no body to look for");
    assert.ok(!result.stdout.includes(needle), "the key reached the client's stdout");
    assert.ok(!result.stderr.includes(needle), "the key reached the client's stderr");
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/,
      "the key reached the client's output");
  } finally {
    server.close();
  }
});
