#!/usr/bin/env node
/**
 * Read-only inventory of the historic R2 weekly cold-snapshot bucket.
 *
 * Lists prefixes/keys/sizes using AWS_R2_HISTORIC_* when present.
 * Prints ONLY keys + sizes + counts.  Never prints secrets, endpoints,
 * access keys, or raw XML.
 *
 * NO DELETES.  Jay has not approved deleting cold-snapshots/app-2026-08-30.db.
 * This script has no object-delete path and refuses non-GET S3 methods.
 *
 * Usage (creds in env; never pass secrets on argv):
 *   node scripts/ops/r2-cold-snapshot-inventory.mjs
 *
 * Exit:
 *   0 ok
 *   1 missing creds / usage / unexpected error
 *   2 AccessDenied (or other 403 auth failure)
 */
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const TRACKED_PREFIXES = ["cold-snapshots/", "trading-live/", "weekly/"];

const CONTROL_TIMEOUT_MS = 60_000;
const MAX_PAGES = 20;

export function isAccessDenied(status, body) {
  if (status === 401 || status === 403) return true;
  const text = String(body ?? "");
  return /<Code>\s*AccessDenied\s*<\/Code>/i.test(text) || /\bAccessDenied\b/.test(text);
}

export function parseListObjectsV2(xml) {
  const objects = [];
  for (const m of String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = /<Key>([^<]+)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    const sizeRaw = /<Size>([^<]+)<\/Size>/.exec(block)?.[1];
    const size = Number(sizeRaw);
    objects.push({ key, size: Number.isFinite(size) ? size : 0 });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, truncated, continuation: continuation || null };
}

export function summarizeInventory(objects) {
  const byPrefix = Object.fromEntries(
    TRACKED_PREFIXES.map((p) => [p, { count: 0, size: 0, keys: [] }]),
  );
  const other = { count: 0, size: 0, keys: [] };
  for (const obj of objects) {
    const tracked = TRACKED_PREFIXES.find((p) => obj.key.startsWith(p));
    const bucket = tracked ? byPrefix[tracked] : other;
    bucket.count += 1;
    bucket.size += obj.size;
    bucket.keys.push(obj);
  }
  return {
    objectCount: objects.length,
    bucketSize: objects.reduce((n, o) => n + o.size, 0),
    byPrefix,
    other,
  };
}

export function formatBytes(n) {
  const gb = n / 1e9;
  const gib = n / (1024 ** 3);
  return `${n} bytes  (${gb.toFixed(2)} GB / ${gib.toFixed(2)} GiB)`;
}

export function formatInventoryReport(bucket, summary) {
  const lines = [
    `bucket=${bucket}`,
    `object_count=${summary.objectCount}`,
    `bucket_size=${formatBytes(summary.bucketSize)}`,
    "",
  ];
  for (const prefix of TRACKED_PREFIXES) {
    const row = summary.byPrefix[prefix];
    lines.push(`prefix=${prefix} count=${row.count} size_bytes=${row.size}`);
    for (const obj of row.keys.sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(`  ${obj.key}  ${obj.size}`);
    }
  }
  if (summary.other.count > 0) {
    lines.push(`prefix=(other) count=${summary.other.count} size_bytes=${summary.other.size}`);
    for (const obj of summary.other.keys.sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(`  ${obj.key}  ${obj.size}`);
    }
  }
  return lines.join("\n");
}

function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, s) {
  return crypto.createHmac("sha256", key).update(s).digest();
}

function assertReadOnlyGet(method) {
  if (method !== "GET") {
    throw new Error("r2-cold-snapshot-inventory is read-only; refusing non-GET S3 method");
  }
}

function loadHistoricCreds() {
  const bucket = process.env.AWS_R2_HISTORIC_BUCKET_NAME?.trim() ?? "";
  const endpoint = process.env.AWS_R2_HISTORIC_ENDPOINT?.trim() ?? "";
  const region = process.env.AWS_R2_HISTORIC_REGION?.trim() || "auto";
  const accessKeyId = process.env.AWS_R2_HISTORIC_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY?.trim() ?? "";
  const missing = [];
  if (!bucket) missing.push("AWS_R2_HISTORIC_BUCKET_NAME");
  if (!endpoint) missing.push("AWS_R2_HISTORIC_ENDPOINT");
  if (!accessKeyId) missing.push("AWS_R2_HISTORIC_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("AWS_R2_HISTORIC_SECRET_ACCESS_KEY");
  return {
    bucket,
    host: endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    region,
    accessKeyId,
    secretAccessKey,
    missing,
  };
}

async function s3Get(cfg, query) {
  const method = "GET";
  assertReadOnlyGet(method);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = "/" + encodeURIComponent(cfg.bucket);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const payloadHash = sha256hex("");
  const canonicalHeaders = `host:${cfg.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + cfg.secretAccessKey, dateStamp), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${cfg.host}${canonicalUri}?${canonicalQuery}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
    });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listAllObjects(cfg, fetchPage = s3Get) {
  const objects = [];
  let continuation;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = { "list-type": "2", "max-keys": "1000" };
    if (continuation) query["continuation-token"] = continuation;
    const res = await fetchPage(cfg, query);
    if (isAccessDenied(res.status, res.body)) {
      const err = new Error("AccessDenied");
      err.code = "AccessDenied";
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`ListObjectsV2 HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const parsed = parseListObjectsV2(res.body);
    objects.push(...parsed.objects);
    if (!parsed.truncated || !parsed.continuation) break;
    continuation = parsed.continuation;
  }
  return objects;
}

function printHelp() {
  process.stdout.write(
    [
      "r2-cold-snapshot-inventory -- read-only list of historic R2 weekly DR objects",
      "",
      "Uses AWS_R2_HISTORIC_* from the environment.  Prints keys, sizes, and counts.",
      "Never prints secrets.  Never deletes.  Jay has not approved deleting",
      "cold-snapshots/app-2026-08-30.db.",
      "",
      "Usage: node scripts/ops/r2-cold-snapshot-inventory.mjs",
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return 0;
  }
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const cfg = loadHistoricCreds();
    if (cfg.missing.length > 0) {
      process.stderr.write(
        `r2-cold-snapshot-inventory: missing ${cfg.missing.join(", ")}. ` +
          "Refusing to run.  No objects were listed or deleted.\n",
      );
      return 1;
    }
    let objects;
    try {
      objects = await listAllObjects(cfg);
    } catch (err) {
      if (err && err.code === "AccessDenied") {
        process.stderr.write(
          `r2-cold-snapshot-inventory: AccessDenied listing bucket ${cfg.bucket}. ` +
            "Check AWS_R2_HISTORIC_* permissions.  No objects were deleted.\n",
        );
        return 2;
      }
      throw err;
    }
    const summary = summarizeInventory(objects);
    process.stdout.write(formatInventoryReport(cfg.bucket, summary) + "\n");
    return 0;
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

const isDirect = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirect) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`r2-cold-snapshot-inventory: ${message}.  No objects were deleted.\n`);
      process.exitCode = 1;
    });
}
