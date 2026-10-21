#!/usr/bin/env node
/**
 * The App Store Connect private key: how it is validated, and how it is
 * staged for the Apple tools that need a key file.
 *
 * WHY THIS IS ITS OWN MODULE (2026-10-21, Kody rule 42 on PR #271):
 * The private key is a secret, and the fleet's approved secret sources are the
 * process environment, a captured `fleet-secrets get NAME`, and bootstrap-only
 * Keychain credentials.  A caller-supplied local file is not one of them, so
 * nothing here reads a key file:  the only approved sources of the key are
 * process.env.ASC_KEY_P8 and `fleet-secrets get ASC_KEY_P8`.
 *
 * ASC_KEY_PATH IS NOT A CREDENTIAL SOURCE (2026-10-21, Kody rule 42 on PR
 * #271):  not as a fallback, not as a lower priority, not at all.  A named
 * path is ignored wherever it appears, so a stale or foreign path in an
 * operator's shell can never decide which credential signs a request.
 *
 * The command line never carries key material:
 *   validate       check that a key on stdin holds a usable key
 *   write <path>   read a key on stdin and write it to a mode-600 file
 *
 * WHY NOTHING PRINTS THE KEY (2026-10-21, Kody rule 42 on PR #271):
 * A key on stdout is a key in a log, in a CI transcript and in whatever
 * captures that output next.  So `validate` reports the STATUS of a key and
 * never the key itself, and the key reaches a consumer through the process
 * environment:  never in an argument, never on stdout, never in a log line.
 *
 * WHAT THE ENVIRONMENT IS NOT (2026-10-21, audit on PR #271):
 * The key is not in argv, not on stdout and not in a log line, and a child
 * is given an allowlist of variables instead of a copy of the parent's
 * environment.  The environment of a process is still readable by another
 * process of the same user on this platform:  `ps eww` and `ps -E` show it,
 * and the PEM envelope is in the listing of the key-bearing child.  So the
 * handoff keeps the key out of the places a process listing is read for (the
 * command line) and out of every log, and it does not claim more than that.
 */
import { writeFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";

// Normalizes a PEM private key and refuses anything that is not one.
//
// The envelope alone is not enough: a truncated key, an armored block or a
// mangled export carries the envelope and still fails to parse, and an
// unparsable key that reaches the signer comes back as a raw stack trace
// instead of a credential error.  So the key is parsed before it is accepted.
//
// Returns the normalized PEM, or null when the value is not a private key.
export function normalizePrivateKey(value) {
  const pem = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!pem) return null;
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pem)) return null;
  try {
    createPrivateKey(pem);
  } catch {
    return null;
  }
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}

// Writes a key to a file only its owner can read.
//
// The key arrives on stdin, so it never becomes a command argument, and the
// file is created with mode 600 whatever the umask of the caller says.  The
// file is a staging copy for the Apple tools that need a key on disk, and it
// is never read back as a credential:  the credential comes from the
// environment or from fleet-secrets.
export function writePrivateKeyFile(keyPath, value) {
  const pem = normalizePrivateKey(value);
  if (!pem) return { error: "the value is not a PEM private key" };
  try {
    writeFileSync(keyPath, pem, { mode: 0o600 });
  } catch {
    return { error: `the key file ${keyPath} could not be written` };
  }
  return { pem };
}

// The variables the App Store Connect client needs from the environment.
//
// The child's environment is an allowlist, never a copy of the parent's:  a
// wholesale copy hands every credential on the operator's machine to the
// child, including the ones that have nothing to do with App Store Connect.
// These are the variables the client reads (see resolveCredential in
// asc-api.mjs), plus PATH and HOME, which it needs to find fleet-secrets and
// to reach the bootstrap Keychain.
export const CLIENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "ASC_API_BASE",
  "ASC_REQUEST_TIMEOUT_MS",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_P8_BASE64",
  "FLEET_SECRETS_BIN",
  "FLEET_SECRETS"
];

// Builds the environment a child of the key handoff runs with.
//
// Only the allowlisted variables cross over, and the key is added
// separately:  it goes in as ASC_KEY_P8 and in no other variable.
export function clientEnvironment(env = process.env, extra = {}) {
  const child = {};
  for (const name of CLIENT_ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) child[name] = value;
  }
  return { ...child, ...extra };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === "validate") {
    const pem = normalizePrivateKey(await readStdin());
    if (!pem) {
      console.error("asc-key: the value is not a PEM private key");
      return 1;
    }
    //  The key is not printed here either:  see the module header.
    console.log("asc-key: the value is a PEM private key");
    return 0;
  }
  if (command === "write") {
    if (!target) {
      console.error("asc-key: usage: asc-key.mjs write <path>");
      return 1;
    }
    const written = writePrivateKeyFile(target, await readStdin());
    if (written.error) {
      console.error(`asc-key: ${written.error}`);
      return 1;
    }
    return 0;
  }
  console.error("asc-key: usage: asc-key.mjs validate | write <path>");
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("asc-key.mjs")) {
  main().then((code) => { process.exitCode = code; });
}
