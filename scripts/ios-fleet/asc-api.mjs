#!/usr/bin/env node
/**
 * Minimal App Store Connect API client. No dependencies beyond Node's
 * built-in crypto (ES256 JWT signing) and fetch (Node 18+).
 *
 * Auth: resolveAscCredentials() takes the first source that is present, and
 * never prints values:
 *   1. APPLE_API_KEY_ID / APPLE_API_ISSUER_ID / APPLE_API_KEY_P8_BASE64 in
 *      process.env (the key itself, base64),
 *   2. ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 in process.env (the key itself),
 *   3. `fleet-secrets get` (Infisical /asc: ASC_KEY_ID, ASC_ISSUER_ID,
 *      ASC_KEY_P8).
 * A path on disk is NOT a credential source (AFC-459, revision 2):  the
 * private key is a secret, and the approved sources are the process
 * environment and a captured `fleet-secrets get`.  ASC_KEY_PATH is never read
 * here:  the shell layer that owns the credential resolves it and hands the
 * key over in the environment (scripts/ios-fleet/asc-key.mjs).
 * No handoff file is read (AFC-359).  Never prints values.
 *
 * Usage:
 *   node asc-api.mjs GET /v1/apps
 *   node asc-api.mjs GET "/v1/apps?filter[bundleId]=com.socratictrade.ios"
 *   node asc-api.mjs PATCH /v1/betaAppReviewDetails/<id> '{"data":{...}}'
 *   node asc-api.mjs latest-build-seq <bundleId> <prefix>   # e.g. ... trade.congress.ios 1.0
 *
 * Prints the raw JSON response to stdout. Caller is responsible for not
 * echoing anything secret-shaped from the response (ASC responses don't
 * carry credentials, only app metadata, so this is safe to print as-is).
 */
import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePrivateKey } from "./asc-key.mjs";

const INFISICAL_ASC_FOLDER = "/asc";

/**
 * Read one value from Infisical Fleet-OPS through `fleet-secrets get`.  FLEET_SECRETS
 * overrides the binary (tests inject a fake).  Returns "" when the CLI is absent,
 * the key is absent, or the call fails.  Never logs stdout or stderr.
 */
function fleetSecret(name, folder = INFISICAL_ASC_FOLDER) {
  // The explicit/installed binary first, then fleet-secrets on PATH.
  const candidates = [process.env.FLEET_SECRETS || join(homedir(), ".local", "bin", "fleet-secrets")];
  if (!process.env.FLEET_SECRETS) candidates.push("fleet-secrets");
  for (const bin of candidates) {
    try {
      return execFileSync(bin, ["get", name, "--path", folder], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30000
      })
        .replace(/\r?\n$/, "")
        .trim();
    } catch {
      // try the next candidate
    }
  }
  return "";
}

/**
 * Decode a base64 private key.  Returns "" when the value does not decode.
 *
 * The value may already be a PEM:  the shell layer accepts a raw PEM in the
 * same variable, so both layers have to agree on what a key looks like
 * (HogHunter #213).
 */
function decodeP8(base64) {
  const cleaned = String(base64 || "").trim();
  if (!cleaned) return "";
  if (cleaned.includes("-----BEGIN ")) return cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
  try {
    const pem = Buffer.from(cleaned, "base64").toString("utf8");
    return pem.includes("-----BEGIN ") ? pem : "";
  } catch {
    return "";
  }
}

/**
 * A masked preview of a value:  the first eight and the last four
 * characters, and nothing else.  A value too short to mask safely is
 * withheld whole, so a preview can never become the secret it describes.
 *
 * The shape is the fleet's blessed one (HogHunter #213):  every copy of the
 * App Store Connect client masks a refused value the same way.
 */
function maskedPreview(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "(empty)";
  if (text.length <= 12) return `[${text.length} chars, withheld]`;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

/**
 * Resolve the App Store Connect credential.
 *
 * The order is the rule (AFC-459, revision 2):  the environment beats the
 * network, and a file is not a source at all.  A path on disk is not an
 * approved secret source, so ASC_KEY_PATH is never read here:  the shell
 * layer that owns the credential resolves it and hands the key over in
 * ASC_KEY_P8.  A named path is ignored wherever it appears, so a stale path
 * in an operator's shell can never decide which key signs a request.
 *
 * Returns { keyId, issuerId, privateKeyPem, source } or { error }.
 */
export function resolveAscCredentials() {
  const fromEnv = (name) => {
    const v = process.env[name];
    return v != null && String(v).trim() !== "" ? String(v).trim() : "";
  };

  // 1. The APPLE_API_* trio:  the key itself is in the environment, so it
  //    wins over every other source.
  const appleKeyId = fromEnv("APPLE_API_KEY_ID");
  const appleIssuerId = fromEnv("APPLE_API_ISSUER_ID");
  const appleBase64 = fromEnv("APPLE_API_KEY_P8_BASE64");
  if (appleKeyId && appleIssuerId && appleBase64) {
    const decoded = decodeP8(appleBase64);
    const pem = normalizePrivateKey(decoded);
    if (!pem) {
      return {
        error: "APPLE_API_KEY_P8_BASE64 is set but did not decode to a PEM private key"
          + `; preview: ${maskedPreview(appleBase64)}`
      };
    }
    return {
      keyId: appleKeyId,
      issuerId: appleIssuerId,
      privateKeyPem: pem,
      source: "APPLE_API_* environment (base64 p8)"
    };
  }

  // 2. The same secret as a plain environment variable.  This is the form
  //    fleet-secrets hands out, and the form the shell layer uses when it
  //    hands the key to this client.
  const envKeyId = fromEnv("ASC_KEY_ID");
  const envIssuerId = fromEnv("ASC_ISSUER_ID");
  const envKeyPem = fromEnv("ASC_KEY_P8");
  if (envKeyId && envIssuerId && envKeyPem) {
    const pem = normalizePrivateKey(envKeyPem);
    if (!pem) {
      return {
        error: "ASC_KEY_P8 is set but is not a PEM private key"
          + `; preview: ${maskedPreview(envKeyPem)}`
      };
    }
    return {
      keyId: envKeyId,
      issuerId: envIssuerId,
      privateKeyPem: pem,
      source: "ASC_KEY_P8 environment"
    };
  }

  // 3. Infisical Fleet-OPS /asc.  The /asc issuer belongs to the /asc key, so
  //    a key id that is not the /asc one never gets the /asc issuer; it gets
  //    its own key from /authkey-<id>-p8.  An issuer named in the environment
  //    belongs to the key named with it, so it is only trusted when the
  //    environment named the key id too:  otherwise a stale issuer would be
  //    paired with the /asc key.
  const infisicalKeyId = fleetSecret("ASC_KEY_ID");
  const keyId = envKeyId || infisicalKeyId;
  const issuerId = envKeyId
    ? envIssuerId || (keyId === infisicalKeyId ? fleetSecret("ASC_ISSUER_ID") : "")
    : fleetSecret("ASC_ISSUER_ID");
  if (!keyId || !issuerId) {
    return { keyId, issuerId, error: null };
  }
  let keyPem = "";
  if (keyId === infisicalKeyId) {
    keyPem = fleetSecret("ASC_KEY_P8");
  }
  if (!keyPem) {
    keyPem = fleetSecret(`AUTHKEY_${keyId}`, `/authkey-${keyId.toLowerCase()}-p8`);
  }
  if (!keyPem) {
    //  The key id and the issuer are there and the key material is not, so
    //  the failure names the secret that is missing:  a generic "no
    //  credential found" would leave the operator guessing which of the
    //  three sources to look in.  The shell layer names it the same way.
    const where = keyId === infisicalKeyId
      ? "ASC_KEY_P8 in Infisical /asc"
      : `AUTHKEY_${keyId} in Infisical /authkey-${keyId.toLowerCase()}-p8`;
    return { keyId, issuerId, error: `the App Store Connect private key is missing: ${where}` };
  }
  const pem = normalizePrivateKey(keyPem);
  if (!pem) {
    return {
      keyId,
      issuerId,
      error: "the App Store Connect key in Infisical /asc is not a PEM private key"
        + `; preview: ${maskedPreview(keyPem)}`
    };
  }
  return { keyId, issuerId, privateKeyPem: pem, source: "Infisical /asc" };
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt({ keyId, issuerId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat: now, exp: now + 1190, aud: "appstoreconnect-v1" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // ASC requires the JOSE (r||s) signature encoding, not DER.
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  const encodedSig = signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${signingInput}.${encodedSig}`;
}

// ---------------------------------------------------------------------------
// TestFlight "What to Test" (betaBuildLocalizations.whatsNew)
// ---------------------------------------------------------------------------
// Every build of every fleet app shipped with this EMPTY (24 builds checked
// 2026-08-13; `GET /v1/builds/<id>/betaBuildLocalizations` returns `data: []`,
// i.e. the en-US row is ABSENT, not blank -- so this must CREATE, not only
// PATCH). /Users/jay/apps/AGENT-SYNC.md "App Versioning & TestFlight Build
// Policy" defines a mandatory template that nothing implemented.
//
// PUBLISHING SAFETY. This is the only step in the ship pipeline that writes
// owner-facing copy every TestFlight tester reads, generated from commit
// subjects nobody reviewed. So it is OPT-IN:
//   IOS_TF_RELEASE_NOTES=1      upload the rendered notes to App Store Connect
//   IOS_TF_RELEASE_NOTES=0      disabled entirely (render nothing)
//   unset / anything else       DRY RENDER: print the exact body, write nothing
// The default is the dry render, so the owner can read the real output of real
// ships before a single character reaches a tester. Flipping it to 1 is the
// owner's call, not an agent's.
//
// A hard deny-list assertion runs on the FULLY RENDERED body: if any internal
// agent name survives, the upload is skipped entirely rather than publishing a
// violation (AGENT-SYNC forbids agent names in release notes). Offending
// bullets are dropped whole -- never word-deleted in place, which yields
// mangled copy like "Fix:  lane".
const AGENT_NAMES = "grok|claude|monet|codex|antigravity|cursor|kimi|fable|gemini|deepseek|opus|sonnet|haiku";
// Bracketed agent markers, stripped ANYWHERE in the subject -- not only at
// position 0. The fleet's actual convention puts the tag at the END, e.g.
// "fix(ios): set App Category to Finance (#1030) [AG] (#1264)". Measured
// 2026-08-13: Congress.Trade has 48 subjects carrying a NON-leading [AG] and
// ZERO leading ones (Socratic-Trade: 2 and 2). An earlier version of this file
// stripped only /^\[[A-Za-z]+\]/ and left "AG" out of the deny-list below on
// the stated assumption that the strip covered it. It did not: every one of
// those 48 subjects would have published "[AG]" straight to TestFlight, which
// AGENT-SYNC's STRICT no-agent-names rule names explicitly.
const AGENT_MARKER = new RegExp(`\\[\\s*(?:ag|${AGENT_NAMES})\\s*\\]`, "gi");
// Bare "AG" stays OUT of the word-boundary deny-list -- as a naked token it
// fires on ordinary English and on tickers. The bracketed form is unambiguous,
// so the final rendered-body assertion tests for that form specifically.
const AGENT_NAME_DENY = new RegExp(`(?:\\b(?:${AGENT_NAMES})\\b|\\[\\s*ag\\s*\\])`, "i");

function centralTimestamp(now = new Date()) {
  // AGENT-SYNC renders "Mon, Aug 12, 2026 at 1:15 AM CT". One combined
  // Intl call yields "Mon, Aug 12, 2026, 1:15 AM" (comma, not "at"), so build
  // the two halves separately. America/Chicago handles CDT/CST automatically.
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  }).format(now);
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric", minute: "2-digit", hour12: true
  }).format(now);
  return `${d} at ${t} CT`;
}

function gitSubjects(repoRoot, prevSha) {
  // Returns { subjects, note }. Never throws: notes must not fail a ship.
  const run = (args) => execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000
  }).trim();
  try {
    if (prevSha) {
      let reachable = true;
      try { run(["merge-base", "--is-ancestor", prevSha, "HEAD"]); }
      catch { reachable = false; }
      if (!reachable) {
        // Shallow clone, force-push, or a squash-merge orphan. One deepen attempt.
        try { run(["fetch", "--deepen=200"]); } catch { /* offline is fine */ }
        try { run(["merge-base", "--is-ancestor", prevSha, "HEAD"]); reachable = true; }
        catch { reachable = false; }
      }
      if (reachable) {
        const out = run(["log", "--no-merges", "--format=%s", `${prevSha}..HEAD`]);
        return { subjects: out ? out.split("\n") : [], note: "" };
      }
      return {
        subjects: [run(["log", "-1", "--format=%s"])],
        note: `previous ship sha ${prevSha.slice(0, 10)} unreachable from HEAD; using HEAD subject only`
      };
    }
    return { subjects: [run(["log", "-1", "--format=%s"])], note: "no previous ship recorded; using HEAD subject only" };
  } catch (err) {
    return { subjects: [], note: `git unavailable (${err && err.message ? err.message.split("\n")[0] : err})` };
  }
}

function buildReleaseNotes({ marketing, displayName, title, subjects, iosPathPrefix, repoRoot, prevSha }) {
  // PR numbers are harvested only from bullets that SURVIVE filtering, so the
  // header line and the body describe the same set of changes.
  const prByBullet = new Map();
  const bullets = [];
  const seen = new Set();

  for (const raw of subjects) {
    let s = String(raw || "").trim();
    if (!s) continue;
    // 1. structured agent markers first, so a bracketed tag never survives as
    //    prose. AGENT_MARKER is global and unanchored because the fleet writes
    //    the tag at the END far more often than at the start.
    s = s.replace(AGENT_MARKER, " ")
         .replace(/^\[[A-Za-z]+\]\s*/, "")
         .replace(/\bAgent:\s*\S+\b/gi, "")
         .replace(/\bCo-Authored-By:.*$/gi, "");
    // 2. conventional-commit prefix
    s = s.replace(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([^)]*\))?!?:\s*/i, "");
    // 3. harvest + strip the trailing PR ref; the numbers go in the header line
    const pr = s.match(/\s*\(#(\d+)\)\s*$/);
    let prNum = "";
    if (pr) {
      prNum = pr[1];
      s = s.replace(/\s*\(#\d+\)\s*$/, "");
    }
    s = s.replace(/\s+/g, " ").trim();
    if (!s) continue;
    // 4. noise
    if (/^(merge|bump|wip|revert)\b/i.test(s)) continue;
    if (s.length < 12) continue;
    // 5. agent names -> drop the whole bullet
    if (AGENT_NAME_DENY.test(s)) continue;
    s = s.charAt(0).toUpperCase() + s.slice(1);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (prNum) prByBullet.set(s, prNum);
    bullets.push(s);
  }

  let kept = bullets;
  if (bullets.length > 10) {
    // Over the cap: prefer commits that touched this app's iOS tree, then backfill.
    let iosFirst = [];
    if (iosPathPrefix && repoRoot && prevSha) {
      try {
        const touched = execFileSync("git", [
          "-C", repoRoot, "log", "--no-merges", "--format=%s", `${prevSha}..HEAD`, "--", iosPathPrefix
        ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 })
          .trim().toLowerCase();
        iosFirst = bullets.filter((b) => touched.includes(b.slice(0, 20).toLowerCase()));
      } catch { /* tie-break only */ }
    }
    kept = [...iosFirst, ...bullets.filter((b) => !iosFirst.includes(b))].slice(0, 10);
  }
  if (kept.length === 0) kept = ["Maintenance and reliability updates"];

  const LIMIT = 4000;
  const heading = `[${marketing || "unversioned"}] ${title || `${displayName || "App"} Update`}`;

  const render = (keptBullets) => {
    const prNumbers = [];
    for (const b of keptBullets) {
      const n = prByBullet.get(b);
      if (n && !prNumbers.includes(n)) prNumbers.push(n);
    }
    let released = `Released: ${centralTimestamp()}`;
    if (prNumbers.length === 1) released += ` · PR #${prNumbers[0]}`;
    else if (prNumbers.length > 1 && prNumbers.length <= 5) {
      released += ` · PRs ${prNumbers.map((n) => `#${n}`).join(", ")}`;
    } else if (prNumbers.length > 5) {
      released += ` · PRs ${prNumbers.slice(0, 5).map((n) => `#${n}`).join(", ")} +${prNumbers.length - 5} more`;
    }
    return `${heading}\n${released}\n\nWhat's New:\n`;
  };

  const header = render(kept);
  const lines = [];
  let used = header.length;
  for (const b of kept) {
    const line = `- ${b}`;
    if (used + line.length + 1 > LIMIT) break;   // truncate at a bullet boundary
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) lines.push("- Maintenance and reliability updates");
  return `${header}${lines.join("\n")}`;
}

async function setWhatToTest({ api, buildId, appId, marketing }) {
  const mode = process.env.IOS_TF_RELEASE_NOTES;
  if (mode === "0") {
    console.error("release-notes: disabled (IOS_TF_RELEASE_NOTES=0)");
    return;
  }
  const repoRoot = process.env.IOS_TF_NOTES_REPO || "";
  const prevSha = process.env.IOS_TF_NOTES_PREV_SHA || "";
  const displayName = process.env.IOS_TF_NOTES_APP || "";
  const title = process.env.IOS_TF_RELEASE_TITLE || "";
  const iosPathPrefix = process.env.IOS_TF_NOTES_IOS_PREFIX || "";
  if (!repoRoot) {
    console.error("release-notes: IOS_TF_NOTES_REPO not set; skipping");
    return;
  }

  const { subjects, note } = gitSubjects(repoRoot, prevSha);
  if (note) console.error(`release-notes: ${note}`);
  const bodyText = buildReleaseNotes({
    marketing, displayName, title, subjects, iosPathPrefix, repoRoot, prevSha
  });

  console.error("release-notes: rendered body follows");
  for (const line of bodyText.split("\n")) console.error(`release-notes:   ${line}`);

  // Final assertion on the FULLY RENDERED body. Skip the upload rather than
  // publish a violation; never fail the ship over it.
  if (AGENT_NAME_DENY.test(bodyText)) {
    console.error("release-notes: ERROR - an internal agent name survived into the rendered body; NOT uploading");
    return;
  }

  if (mode !== "1") {
    console.error("release-notes: DRY RENDER only (set IOS_TF_RELEASE_NOTES=1 to publish this to TestFlight)");
    return;
  }

  const existing = await api("GET", `/v1/builds/${buildId}/betaBuildLocalizations`);
  if (!existing.ok) {
    console.error(`release-notes: could not read localizations (HTTP ${existing.status}); skipping`);
    return;
  }
  const enUs = (existing.parsed.data || []).find((x) => x.attributes?.locale === "en-US");
  if (enUs) {
    const res = await api("PATCH", `/v1/betaBuildLocalizations/${enUs.id}`, JSON.stringify({
      data: { type: "betaBuildLocalizations", id: enUs.id, attributes: { whatsNew: bodyText } }
    }));
    console.error(res.ok
      ? `release-notes: updated en-US What to Test (${bodyText.length} chars)`
      : `release-notes: PATCH failed HTTP ${res.status}`);
    return;
  }
  // No row exists yet -- CREATE it. This POST shape was NOT verified against a
  // live write (no ASC write was performed while implementing this); treat the
  // first real run as the verification, and read the printed HTTP status.
  let res = await api("POST", "/v1/betaBuildLocalizations", JSON.stringify({
    data: {
      type: "betaBuildLocalizations",
      attributes: { locale: "en-US", whatsNew: bodyText },
      relationships: { build: { data: { type: "builds", id: buildId } } }
    }
  }));
  if (!res.ok && appId) {
    // Some apps are not localized to en-US; fall back to a locale the app has.
    const locales = await api("GET", `/v1/apps/${appId}/betaAppLocalizations`);
    const alt = (locales.parsed?.data || [])[0]?.attributes?.locale;
    if (alt && alt !== "en-US") {
      console.error(`release-notes: en-US rejected (HTTP ${res.status}); retrying with ${alt}`);
      res = await api("POST", "/v1/betaBuildLocalizations", JSON.stringify({
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: alt, whatsNew: bodyText },
          relationships: { build: { data: { type: "builds", id: buildId } } }
        }
      }));
    }
  }
  console.error(res.ok
    ? `release-notes: created What to Test (${bodyText.length} chars)`
    : `release-notes: POST failed HTTP ${res.status}`);
}

function appleFailure(res) {
  const first = Array.isArray(res.parsed?.errors) ? res.parsed.errors[0] : null;
  const code = first?.code ? String(first.code) : "";
  const title = first?.title ? String(first.title) : "";
  const detail = first?.detail ? String(first.detail).replace(/\s+/g, " ").slice(0, 160) : "";
  return [`HTTP ${res.status}`, code, title, detail].filter(Boolean).join(" ");
}

async function getRetrying(api, url) {
  let res = await api("GET", url);
  if (!res.ok && (res.status >= 500 || res.status === 429)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    res = await api("GET", url);
  }
  return res;
}

// Try each list URL.  A non-2xx on page 1 falls through to the next URL.
// A non-2xx on a later page fails the scan: a partial floor can reuse a
// version Apple already has.
async function scanPages(api, urls, visit) {
  let last = "no response";
  for (const first of urls) {
    let url = first;
    let failed = null;
    for (let page = 0; page < 10 && url; page++) {
      const res = await getRetrying(api, url);
      if (!res.ok) {
        failed = appleFailure(res);
        break;
      }
      for (const row of res.parsed.data || []) visit(row);
      url = res.parsed.links?.next || "";
    }
    if (!failed) return { ok: true };
    last = failed;
    console.error(`latest-build-seq: list failed (${failed}); trying next URL`);
  }
  return { ok: false, error: last };
}

async function resolveAppId(api, bundleId) {
  const filtered = await getRetrying(
    api,
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`
  );
  if (filtered.ok) {
    const rows = filtered.parsed.data || [];
    const match = rows.find((row) => row.attributes?.bundleId === bundleId) || rows[0];
    if (match?.id) return match.id;
  }
  const listed = await getRetrying(api, "/v1/apps?limit=200");
  if (listed.ok) {
    const match = (listed.parsed.data || []).find((row) => row.attributes?.bundleId === bundleId);
    if (match?.id) return match.id;
  }
  const why = filtered.ok ? "filter returned no rows" : appleFailure(filtered);
  const listWhy = listed.ok ? "list returned no matching bundle" : appleFailure(listed);
  console.error(`latest-build-seq: app not found for bundle (${why}; ${listWhy})`);
  return null;
}

async function main() {
  const cred = resolveAscCredentials();
  if (cred.error) {
    console.error(`asc-auth: ${cred.error}`);
    process.exit(1);
  }
  if (!cred.privateKeyPem) {
    const missing = [];
    if (!cred.keyId) missing.push("ASC_KEY_ID");
    if (!cred.issuerId) missing.push("ASC_ISSUER_ID");
    const named = missing.length ? ` (${missing.join(" and ")} missing)` : "";
    console.error(
      `asc-auth: no App Store Connect credential found${named}.  Tried, in order:\n` +
      "  1) APPLE_API_KEY_ID / APPLE_API_ISSUER_ID / APPLE_API_KEY_P8_BASE64 in the environment\n" +
      "  2) ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_P8 in the environment\n" +
      "  3) Fleet-OPS prod /asc through fleet-secrets\n" +
      "  A path in ASC_KEY_PATH is not a credential source:  the shell layer that owns the\n" +
      "  credential hands the key over in ASC_KEY_P8."
    );
    process.exit(1);
  }
  console.error(`asc-auth: using ${cred.source} (key id length ${cred.keyId.length})`);
  const { keyId, issuerId, privateKeyPem } = cred;
  const token = signJwt({ keyId, issuerId, privateKeyPem });

  const [method, path, body, arg4] = process.argv.slice(2);
  if (!method || !path) {
    console.error("Usage: node asc-api.mjs <METHOD> <PATH> [JSON_BODY]");
    console.error("       node asc-api.mjs ensure-tf-ready <bundleId> <buildVersion> [marketingVersion]");
    console.error("       node asc-api.mjs latest-build-seq <bundleId> <prefix>");
    process.exit(1);
  }

  async function api(methodName, apiPath, jsonBody) {
    const url = apiPath.startsWith("http") ? apiPath : `https://api.appstoreconnect.apple.com${apiPath}`;
    const res = await fetch(url, {
      method: methodName,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: jsonBody ? jsonBody : undefined
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, ok: res.ok, parsed, text };
  }

  // Highest N already used by the "<prefix>.N" MARKETING version train
  // (e.g. 1.0.7). This is what makes App Store Connect -- not a single unbacked
  // local file -- the source of truth for "what has already shipped", so a
  // lost/reset counter cannot silently reuse a version that ASC rejects as a
  // duplicate.
  //
  // WHICH ASC FIELD IS WHICH (verified against live data 2026-08-12):
  //   preReleaseVersions[].attributes.version = CFBundleShortVersionString
  //                                             (the MARKETING version, "1.0.7")
  //   builds[].attributes.version             = CFBundleVersion
  //                                             (the BUILD number, "202608120521")
  // ship-testflight.sh sequences the MARKETING version, so this must read
  // preReleaseVersions. Reading builds[].version only ever worked by accident,
  // during the window when the ship script wrote the same dotted string into
  // both fields. It was already silently wrong for socratic, whose newest
  // marketing version is 1.0.1 but whose build numbers are "2" / "1" /
  // "202608120212" -- none of which match "1.0.N", so ASC contributed 0 and
  // "verification" verified nothing.
  //
  // Build numbers are still scanned afterwards, purely so this can never report
  // a LOWER floor than the old behaviour did for an app whose build numbers do
  // happen to be dotted (congress 1.0.7/1.0.1, usage 1.0.1).
  //
  // stdout: the integer N (0 when the train has no versions yet). stderr: notes.
  // exit 0 = authoritative answer; exit 2 = could not determine (caller must
  // treat that as "unverified", NOT as zero).
  if (method === "latest-build-seq") {
    const bundleId = path;
    const prefix = body;
    if (!bundleId || !prefix) {
      console.error("Usage: node asc-api.mjs latest-build-seq <bundleId> <prefix>");
      process.exit(2);
    }
    const appId = await resolveAppId(api, bundleId);
    if (!appId) process.exit(2);

    // Escape the prefix so "1.0" cannot match "120" via the regex dot.
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}\\.(\\d+)$`);

    let best = 0;
    const consider = (value) => {
      const m = re.exec(value || "");
      if (!m) return;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > best) best = n;
    };

    // 1) Marketing version trains -- the authoritative record.
    // The filter[app] list is what succeeded on 2026-10-08 (asc=106).  The
    // relationship URL is the fallback when Apple rejects that filter.
    let seenVersions = 0;
    const versions = await scanPages(api, [
      `/v1/preReleaseVersions?filter[app]=${appId}&limit=200`,
      `/v1/apps/${appId}/preReleaseVersions?limit=200`,
    ], (row) => {
      // A macOS/tvOS train must not bump the iOS sequence.
      if ((row.attributes?.platform || "IOS") !== "IOS") return;
      seenVersions++;
      consider(row.attributes?.version);
    });
    if (!versions.ok) {
      console.error(`latest-build-seq: preReleaseVersions query failed (${versions.error})`);
      process.exit(2);
    }

    // 2) Build numbers, so the floor can never regress below what the previous
    //    implementation reported.  Same fallback if sort/filter is rejected.
    let seenBuilds = 0;
    const builds = await scanPages(api, [
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=200`,
      `/v1/builds?filter[app]=${appId}&limit=200`,
      `/v1/apps/${appId}/builds?limit=200`,
    ], (row) => {
      seenBuilds++;
      consider(row.attributes?.version);
    });
    if (!builds.ok) {
      console.error(`latest-build-seq: builds query failed (${builds.error})`);
      process.exit(2);
    }

    console.error(
      `latest-build-seq: ${seenVersions} marketing version(s) + ${seenBuilds} build(s) inspected; highest ${prefix}.N is N=${best}`
    );
    console.log(String(best));
    process.exit(0);
  }

  // After upload: find THE BUILD THIS RUN JUST UPLOADED, declare export
  // compliance on it, set its TestFlight "What to Test" notes, and wait until
  // internal testers can actually install it.
  //
  // WHY THE BUILD VERSION IS A REQUIRED ARGUMENT (defect found 2026-08-13):
  // this used to do
  //     GET /v1/builds?filter[app]=<id>&sort=-uploadedDate&limit=1
  // and assume "newest" was the build the run had just uploaded. It never is.
  // ASC ingestion is asynchronous, so for the first minutes after an upload the
  // new build has NO record at all -- the newest build is the PREVIOUS ship,
  // which is already VALID and already IN_BETA_TESTING. So the compliance PATCH
  // was a no-op on an old build and the readiness poll returned success on poll
  // 1, printing "TestFlight internal testers can install this build" about a
  // build it had never inspected.
  //
  // Reproduced from two ships on 2026-08-13:
  //   usage       archive CURRENT_PROJECT_VERSION=202608131759
  //               ensure-tf-ready.json version=202608130439  (13h older)
  //   usage-local archive CURRENT_PROJECT_VERSION=202608131801
  //               ensure-tf-ready.json version=202608130441  (previous ship)
  //
  // CFBundleVersion is known exactly at archive time (ship-testflight.sh passes
  // it to xcodebuild as CURRENT_PROJECT_VERSION) and ASC ingests it verbatim as
  // builds[].attributes.version, so it is an exact key. There is deliberately NO
  // "newest build" fallback: that fallback IS the defect.
  //
  // Exit codes: 0 ready | 2 usage/API error | 3 readiness timeout (build found,
  // still processing) | 4 the uploaded build never appeared within the discovery
  // budget, so compliance was NOT declared on it.
  if (method === "ensure-tf-ready") {
    const bundleId = path;
    const wantBuildVersion = body;
    const wantMarketing = arg4;
    if (!bundleId || !wantBuildVersion) {
      console.error("Usage: node asc-api.mjs ensure-tf-ready <bundleId> <buildVersion> [marketingVersion]");
      console.error("  <buildVersion> is CFBundleVersion (CURRENT_PROJECT_VERSION) of the build");
      console.error("  this run uploaded. It is required: without it there is no way to tell the");
      console.error("  new build from the previous ship, and ASC has no record of the new build");
      console.error("  for the first minutes after upload.");
      process.exit(2);
    }

    const totalTimeoutSec = (() => {
      const raw = process.env.IOS_TF_READY_TIMEOUT_SEC;
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 900;
    })();
    const deadline = Date.now() + totalTimeoutSec * 1000;
    const POLL_MS = 15000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const apps = await api("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
    if (!apps.ok || !apps.parsed.data?.[0]) {
      console.error(`ensure-tf-ready: app not found for bundle (HTTP ${apps.status})`);
      process.exit(2);
    }
    const appId = apps.parsed.data[0].id;

    // ---- Phase A: discovery. Poll until the uploaded build has an ASC record.
    let query = `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(wantBuildVersion)}`;
    if (wantMarketing) {
      query += `&filter[preReleaseVersion.version]=${encodeURIComponent(wantMarketing)}`;
    }
    query += "&limit=2&include=buildBetaDetail,preReleaseVersion";

    let build = null;
    let attempt = 0;
    let transientErrors = 0;
    while (Date.now() < deadline) {
      attempt++;
      const res = await api("GET", query);
      if (!res.ok) {
        // A rate-limit or a 5xx is exactly what a ~60-poll loop against a
        // third-party API should expect, and the whole export-compliance fix
        // hangs off this loop -- so one transient blip must not abandon it.
        // Genuine client errors (400/401/403/404) still fail fast.
        if (res.status === 429 || res.status >= 500) {
          transientErrors++;
          console.error(`ensure-tf-ready: discovery query transient HTTP ${res.status} (attempt ${attempt}); retrying`);
          await sleep(POLL_MS);
          continue;
        }
        console.error(`ensure-tf-ready: discovery query failed (HTTP ${res.status})`);
        process.exit(2);
      }
      const rows = res.parsed.data || [];
      if (rows.length > 1) {
        console.error(`ensure-tf-ready: ${rows.length} builds match version ${wantBuildVersion} -- ambiguous, refusing to guess`);
        process.exit(2);
      }
      if (rows.length === 1) {
        build = rows[0];
        build.__included = res.parsed.included || [];
        console.error(`ensure-tf-ready: discovered build ${wantBuildVersion} after ${attempt} attempt(s)`);
        break;
      }
      console.error(`ensure-tf-ready: build ${wantBuildVersion} not visible yet (attempt ${attempt}); waiting`);
      await sleep(POLL_MS);
    }

    if (!build) {
      // Name what IS present, so the log answers "then what did ASC have?".
      let newest = "unknown";
      try {
        const probe = await api("GET", `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=1`);
        newest = probe.parsed?.data?.[0]?.attributes?.version || "none";
      } catch { /* diagnostic only */ }
      console.error(
        `ensure-tf-ready: build version ${wantBuildVersion} never appeared for ${bundleId} within ${totalTimeoutSec}s; ` +
        `newest present is ${newest}. Export compliance was NOT declared on the build this run uploaded.` +
        (transientErrors ? ` (${transientErrors} transient API error(s) during discovery)` : "")
      );
      console.log(JSON.stringify({
        ok: false, wanted: wantBuildVersion, newestPresent: newest,
        discoveryTimedOut: true, transientErrors
      }));
      process.exit(4);
    }

    const buildId = build.id;
    const version = build.attributes?.version;
    const enc = build.attributes?.usesNonExemptEncryption;
    const beta = (build.__included || []).find((x) => x.type === "buildBetaDetails")?.attributes || {};
    console.error(`ensure-tf-ready: build=${version} id=${buildId} enc=${enc} internal=${beta.internalBuildState || "unknown"}`);

    // ---- Phase B: export compliance, on the DISCOVERED build.
    if (enc !== false) {
      const patch = await api("PATCH", `/v1/builds/${buildId}`, JSON.stringify({
        data: { type: "builds", id: buildId, attributes: { usesNonExemptEncryption: false } }
      }));
      if (!patch.ok) {
        console.error(`ensure-tf-ready: compliance patch failed HTTP ${patch.status}`);
        process.exit(2);
      }
      console.error("ensure-tf-ready: declared usesNonExemptEncryption=false");
    }

    // ---- Phase B2: TestFlight "What to Test". Before the readiness wait, so a
    // Phase C timeout cannot lose the notes. Never fails the caller.
    try {
      await setWhatToTest({ api, buildId, appId, marketing: wantMarketing });
    } catch (err) {
      console.error(`ensure-tf-ready: release-notes step failed (non-fatal): ${err && err.message ? err.message : err}`);
    }

    // ---- Phase C: readiness, drawing from the same overall deadline. Always
    // polls at least once: if discovery consumed nearly the whole budget, a
    // zero-poll "timed out" line would be misleading, and by this point the
    // compliance PATCH (the part that actually matters) has already landed.
    let pollNo = 0;
    while (pollNo === 0 || Date.now() < deadline) {
      pollNo++;
      const again = await api("GET", `/v1/builds/${buildId}?include=buildBetaDetail`);
      const attrs = again.parsed.data?.attributes || {};
      const detail = (again.parsed.included || []).find((x) => x.type === "buildBetaDetails")?.attributes || {};
      const state = detail.internalBuildState || "";
      console.error(`ensure-tf-ready: poll ${pollNo} enc=${attrs.usesNonExemptEncryption} internal=${state}`);
      if (state === "IN_BETA_TESTING" || state === "READY_FOR_BETA_TESTING") {
        console.log(JSON.stringify({
          ok: true,
          buildId,
          version,
          internalBuildState: state,
          usesNonExemptEncryption: attrs.usesNonExemptEncryption
        }));
        process.exit(0);
      }
      await sleep(POLL_MS);
    }
    console.error("ensure-tf-ready: timed out waiting for IN_BETA_TESTING (upload may still be processing)");
    console.log(JSON.stringify({ ok: false, buildId, version, timedOut: true }));
    process.exit(3);
  }

  const url = path.startsWith("http") ? path : `https://api.appstoreconnect.apple.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? body : undefined
  });
  const text = await res.text();
  console.error(`HTTP ${res.status}`);
  console.log(text);
  if (!res.ok) process.exit(2);
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main().catch((err) => {
    console.error(String(err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
