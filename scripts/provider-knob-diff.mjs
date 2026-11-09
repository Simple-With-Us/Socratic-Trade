#!/usr/bin/env node
// Pure diff/plan helper for scripts/sync-provider-knobs.sh.
//
// The API-Usage-Monitor app is the source of truth for which market-data
// subscription plans we are on. This module turns its /api/subscriptions payload
// into the exact set of provider env-knob values the trading app should have in
// Infisical prod, then diffs that desired state against what Infisical currently
// holds so the shell wrapper can write ONLY the changes.
//
// EVERYTHING here is a pure function of its inputs (no network, no fs at module
// scope, no process.env reads) so it is unit-testable — see
// test/provider-knob-diff.test.ts. The thin CLI at the bottom (run directly) is
// the only impure part: it reads stdin/files and prints line-oriented records the
// bash 3.2 wrapper consumes with `cut -f` (tab-delimited, never empty fields).
//
// SECURITY: this payload comes from another app over the network. Treat it as
// hostile. Two guards bound what can ever be written to Infisical:
//   1. Key allow-list (ALLOWED_KEY_RE) — only provider-quota / rate-limit / a few
//      named boolean knobs. Anything else is REJECTED, never written.
//   2. Value charset (isSafeValue) — quota numbers / true|false / feed names only;
//      no whitespace, quotes, or shell metacharacters (defends the value that is
//      later passed to `infisical secrets set KEY=VALUE` over SSH).
// The shell re-applies the key guard on the box before every write (defense in
// depth); this module is the primary gate.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keys the monitor is ever allowed to drive. Prefixes (PROVIDER_QUOTA_,
// PROVIDER_RATE_LIMIT_, MASSIVE_) plus three exactly-anchored boolean/enum knobs.
// Mirrors docs/market-data-provider-pricing.md "Where the dials live" and the
// grep the shell uses to filter Infisical export output on the box. Keep the two
// in sync if this ever changes.
export const ALLOWED_KEY_RE =
  /^(PROVIDER_QUOTA_|PROVIDER_RATE_LIMIT_|MASSIVE_|TIINGO_DROP_NEWS$|FINNHUB_DROP_RECOMMENDATION$|ALPACA_DATA_FEED$)/;

// A value we are willing to write. Non-empty, <=256 chars, and drawn from a
// conservative charset that covers every real knob value (10000, true, false,
// sip, iex, 0.5, etc.) while excluding whitespace, quotes, $, ;, backticks, and
// anything else that could misbehave when interpolated into a shell command.
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:+/-]+$/;

export function isAllowedKey(key) {
  return typeof key === "string" && ALLOWED_KEY_RE.test(key);
}

export function isSafeValue(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && SAFE_VALUE_RE.test(value);
}

// Coerce a knobEnv value to the string Infisical would store. Returns null for
// anything that is not a clean scalar (objects/arrays/null/NaN) so the caller
// skips it rather than guessing.
export function coerceValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null; // object / array / symbol / bigint -> reject
}

// Which knob map a subscription contributes, by status:
//   active            -> knobEnv        (the plan we pay for is live)
//   canceled | paused -> freeTierKnobEnv (fall back to the free-tier limits)
//   considering       -> null           (not bought; leave knobs untouched)
//   anything else     -> null           (unknown status; fail safe, skip)
// A null/absent map for the chosen status also yields null (skip).
export function desiredMapForStatus(sub) {
  if (!sub || typeof sub !== "object") return null;
  const status = sub.status;
  let map;
  if (status === "active") map = sub.knobEnv;
  else if (status === "canceled" || status === "paused") map = sub.freeTierKnobEnv;
  else return null; // considering / unknown
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  return map;
}

// Human label for a subscription in log/slack lines. Prefers displayName, then
// the raw name; strips tabs/newlines so it is safe in the TSV the shell parses.
function planLabel(sub) {
  const p = sub && sub.provider;
  const raw =
    (p && (p.displayName || p.name)) ||
    (sub && sub.name) ||
    (p && p.id) ||
    "unknown";
  return String(raw).replace(/[\t\r\n]+/g, " ").trim() || "unknown";
}

function statusLabel(sub) {
  return String((sub && sub.status) || "unknown").replace(/[\t\r\n]+/g, " ").trim() || "unknown";
}

// Build the merged desired KEY->value map across all subscriptions, filtered to
// allowed keys and safe values. Returns everything the caller needs to both act
// and explain:
//   desired   { KEY: VALUE }               keys we WANT set in Infisical
//   origins   { KEY: { plan, status } }    which subscription set each key
//   rejected  [ { key, value, reason, plan } ]   dropped by a guard
//   conflicts [ { key, plan, status, existing, incoming } ]  two plans disagree
//   skipped   [ { plan, status, reason } ] subscription contributed nothing
// Conflict policy: if two subscriptions assert the SAME key with DIFFERENT
// values, we do NOT guess — the key is removed from desired and recorded. Same
// key + same value is fine (idempotent).
export function computeDesired(subs) {
  const desired = {};
  const origins = {};
  const rejected = [];
  const conflicts = [];
  const skipped = [];
  const conflicted = new Set();

  if (!Array.isArray(subs)) {
    return { desired, origins, rejected, conflicts, skipped, invalid: true };
  }

  for (const sub of subs) {
    const plan = planLabel(sub);
    const status = statusLabel(sub);
    const map = desiredMapForStatus(sub);
    if (!map) {
      skipped.push({ plan, status, reason: "no applicable knob map for status" });
      continue;
    }
    let contributed = 0;
    for (const rawKey of Object.keys(map)) {
      const key = String(rawKey);
      if (!isAllowedKey(key)) {
        rejected.push({ key, value: "", reason: "key not in allow-list", plan });
        continue;
      }
      const value = coerceValue(map[rawKey]);
      if (value === null) {
        rejected.push({ key, value: "", reason: "value not a clean scalar", plan });
        continue;
      }
      if (!isSafeValue(value)) {
        rejected.push({ key, value, reason: "value failed charset guard", plan });
        continue;
      }
      if (conflicted.has(key)) {
        // already poisoned by an earlier disagreement; keep recording
        conflicts.push({ key, plan, status, existing: desired[key] ?? null, incoming: value });
        continue;
      }
      if (key in desired && desired[key] !== value) {
        conflicts.push({ key, plan, status, existing: desired[key], incoming: value });
        conflicted.add(key);
        delete desired[key];
        delete origins[key];
        continue;
      }
      desired[key] = value;
      origins[key] = { plan, status };
      contributed += 1;
    }
    if (contributed === 0 && !skipped.some((s) => s.plan === plan && s.status === status)) {
      // contributed nothing usable (all keys rejected/conflicted) — note it once
      skipped.push({ plan, status, reason: "no usable allowed knobs" });
    }
  }

  return { desired, origins, rejected, conflicts, skipped, invalid: false };
}

// Parse KEY=VALUE lines (Infisical `export --format dotenv` output, or our own
// desired dump). Tolerates a leading `export `, surrounding quotes, blank/comment
// lines. Later lines win. Returns a plain { KEY: VALUE } object.
export function parseEnvLines(text) {
  const out = {};
  if (!text) return out;
  for (let line of String(text).split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val[0] === "'" && val[val.length - 1] === "'") || (val[0] === '"' && val[val.length - 1] === '"'))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Diff desired against current (both { KEY: VALUE }). A key is a change when its
// desired value differs from current, OR the key is absent from current (old is
// then null -> a first-time write). We NEVER emit removals: keys present in
// current but not desired are left exactly as they are. Sorted by key for stable
// output.
export function computeDiff(desired, current) {
  const cur = current || {};
  const changes = [];
  for (const key of Object.keys(desired).sort()) {
    const want = desired[key];
    const have = key in cur ? String(cur[key]) : null;
    if (have !== String(want)) {
      changes.push({ key, old: have, new: String(want) });
    }
  }
  return changes;
}

// Full plan: desired from subs, diffed against current, with per-change origin.
export function computePlan(subs, current) {
  const d = computeDesired(subs);
  const changes = computeDiff(d.desired, current).map((c) => ({
    ...c,
    plan: (d.origins[c.key] && d.origins[c.key].plan) || "unknown",
    status: (d.origins[c.key] && d.origins[c.key].status) || "unknown",
  }));
  return {
    invalid: d.invalid,
    desiredCount: Object.keys(d.desired).length,
    changes,
    rejected: d.rejected,
    conflicts: d.conflicts,
    skipped: d.skipped,
  };
}

// ---- line-oriented TSV emitters for the shell (never emit an empty field) -----
const TAB = "\t";
function safeField(s) {
  const v = String(s === null || s === undefined ? "" : s).replace(/[\t\r\n]+/g, " ").trim();
  return v.length ? v : "-";
}

// One record per line, first field is the record type. The shell reads fields
// with `cut -f`, so empty fields are replaced with "-" and the "(unset)" token
// stands in for a missing prior value.
export function formatPlanRecords(plan) {
  const lines = [];
  for (const c of plan.changes) {
    lines.push(
      ["CHANGE", safeField(c.key), c.old === null ? "(unset)" : safeField(c.old), safeField(c.new), safeField(c.plan), safeField(c.status)].join(TAB)
    );
  }
  for (const r of plan.rejected) {
    lines.push(["REJECT", safeField(r.key), safeField(r.reason), safeField(r.plan)].join(TAB));
  }
  for (const cf of plan.conflicts) {
    lines.push(["CONFLICT", safeField(cf.key), safeField(cf.plan), safeField(cf.status)].join(TAB));
  }
  for (const s of plan.skipped) {
    lines.push(["SKIP", safeField(s.plan), safeField(s.status), safeField(s.reason)].join(TAB));
  }
  lines.push(
    ["SUMMARY", String(plan.desiredCount), String(plan.changes.length), String(plan.rejected.length), String(plan.conflicts.length), String(plan.skipped.length)].join(TAB)
  );
  return lines.join("\n");
}

// ---- CLI (impure) -------------------------------------------------------------
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const mode = argv[0];
  if (mode === "--plan") {
    // node provider-knob-diff.mjs --plan <currentEnvFile>   (subscriptions JSON on stdin)
    const currentFile = argv[1];
    let current = {};
    if (currentFile) {
      try {
        current = parseEnvLines(readFileSync(currentFile, "utf8"));
      } catch (e) {
        process.stderr.write(`[knob-diff] could not read current env file ${currentFile}: ${e.message}\n`);
        process.exit(3);
      }
    }
    let subs;
    try {
      subs = JSON.parse(readStdin() || "null");
    } catch (e) {
      process.stderr.write(`[knob-diff] subscriptions payload is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
    const plan = computePlan(subs, current);
    if (plan.invalid) {
      process.stderr.write("[knob-diff] subscriptions payload was not a JSON array\n");
      process.exit(2);
    }
    process.stdout.write(formatPlanRecords(plan) + "\n");
    return;
  }
  if (mode === "--desired") {
    // node provider-knob-diff.mjs --desired   (subscriptions JSON on stdin)
    // prints allowed desired KEY=VALUE lines; diagnostics to stderr.
    let subs;
    try {
      subs = JSON.parse(readStdin() || "null");
    } catch (e) {
      process.stderr.write(`[knob-diff] subscriptions payload is not valid JSON: ${e.message}\n`);
      process.exit(2);
    }
    const d = computeDesired(subs);
    if (d.invalid) {
      process.stderr.write("[knob-diff] subscriptions payload was not a JSON array\n");
      process.exit(2);
    }
    const out = Object.keys(d.desired)
      .sort()
      .map((k) => `${k}=${d.desired[k]}`)
      .join("\n");
    if (out) process.stdout.write(out + "\n");
    for (const r of d.rejected) process.stderr.write(`[knob-diff] rejected ${r.key} (${r.reason}) from plan ${r.plan}\n`);
    for (const c of d.conflicts) process.stderr.write(`[knob-diff] conflict ${c.key}: ${c.existing} vs ${c.incoming} (plan ${c.plan})\n`);
    return;
  }
  process.stderr.write("Usage: provider-knob-diff.mjs --plan <currentEnvFile> < subscriptions.json\n       provider-knob-diff.mjs --desired < subscriptions.json\n");
  process.exit(64);
}

// Run main only when invoked directly (not when imported by the test suite).
let invokedDirectly = false;
try {
  invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) {
  // A downstream reader (head, a closed pipe) can close stdout early; don't crash.
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
    throw e;
  });
  main(process.argv.slice(2));
}
