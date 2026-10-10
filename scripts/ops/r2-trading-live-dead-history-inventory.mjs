#!/usr/bin/env node
/**
 * Read-only inventory of DEAD pre-B2-cutover Litestream objects on historic R2.
 *
 * Lists keys under trading-live/ only (candidate prune prefix).  Uses AWS_R2_HISTORIC_*.
 * Prints keys + sizes + counts.  Never prints secrets or endpoints with credentials.
 *
 * NO DELETES — this script has no object-delete path and refuses non-GET S3 methods.
 * The --i-understand-r2-dead-history flag only acknowledges you are reviewing dead
 * history; it does NOT enable deletion.
 *
 * Usage:
 *   node scripts/ops/r2-trading-live-dead-history-inventory.mjs
 *   node scripts/ops/r2-trading-live-dead-history-inventory.mjs --i-understand-r2-dead-history
 *
 * Exit:
 *   0 ok
 *   1 missing creds / usage / unexpected error
 *   2 AccessDenied
 */
import { formatBytes, isAccessDenied, parseListObjectsV2 } from "./r2-cold-snapshot-inventory.mjs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEAD_HISTORY_PREFIX = "trading-live/";
export const EXPECTED_HISTORIC_BUCKET = "socratic-trade-bucket";

const CONTROL_TIMEOUT_MS = 60_000;
const MAX_PAGES = 500;
const SUMMARY_SAMPLE_KEYS = 25;

function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, s) {
  return crypto.createHmac("sha256", key).update(s).digest();
}

function assertReadOnlyGet(method) {
  if (method !== "GET") {
    throw new Error("r2-trading-live-dead-history-inventory is read-only; refusing non-GET S3 method");
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
  const host = endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    bucket,
    host,
    region,
    accessKeyId,
    secretAccessKey,
    missing,
    endpointLooksLikeR2: /\.r2\.cloudflarestorage\.com$/i.test(host),
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

export async function listPrefixObjects(cfg, prefix, fetchPage = s3Get) {
  const objects = [];
  let continuation;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = { "list-type": "2", "max-keys": "1000", prefix };
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

export function summarizeDeadHistory(objects) {
  const totalSize = objects.reduce((n, o) => n + o.size, 0);
  const bySecondLevel = new Map();
  for (const obj of objects) {
    const rest = obj.key.slice(DEAD_HISTORY_PREFIX.length);
    const segment = rest.split("/")[0] || "(root)";
    const row = bySecondLevel.get(segment) ?? { count: 0, size: 0 };
    row.count += 1;
    row.size += obj.size;
    bySecondLevel.set(segment, row);
  }
  return {
    objectCount: objects.length,
    totalSize,
    bySecondLevel: [...bySecondLevel.entries()]
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.size - a.size),
  };
}

export function formatDeadHistoryReport(cfg, summary, objects, { fullKeyList }) {
  const lines = [
    "r2-trading-live-dead-history-inventory (read-only; NO DELETES)",
    `bucket=${cfg.bucket}`,
    `expected_historic_bucket=${EXPECTED_HISTORIC_BUCKET}`,
    `endpoint_host=${cfg.host}`,
    `endpoint_looks_like_r2=${cfg.endpointLooksLikeR2}`,
    `prefix=${DEAD_HISTORY_PREFIX}`,
    `object_count=${summary.objectCount}`,
    `prefix_size=${formatBytes(summary.totalSize)}`,
    "",
    "second_level_breakdown (name count size_bytes):",
  ];
  for (const row of summary.bySecondLevel) {
    lines.push(`  ${row.name}  count=${row.count}  size_bytes=${row.size}`);
  }
  lines.push("");
  const sorted = [...objects].sort((a, b) => a.key.localeCompare(b.key));
  if (fullKeyList) {
    lines.push("keys (full list):");
    for (const obj of sorted) {
      lines.push(`  ${obj.key}  ${obj.size}`);
    }
  } else if (sorted.length > 0) {
    lines.push(`keys (sample first ${Math.min(SUMMARY_SAMPLE_KEYS, sorted.length)} of ${sorted.length}):`);
    for (const obj of sorted.slice(0, SUMMARY_SAMPLE_KEYS)) {
      lines.push(`  ${obj.key}  ${obj.size}`);
    }
    if (sorted.length > SUMMARY_SAMPLE_KEYS) {
      lines.push(
        `  ... ${sorted.length - SUMMARY_SAMPLE_KEYS} more keys; re-run with --i-understand-r2-dead-history for full list`,
      );
    }
  } else {
    lines.push("keys: (none under prefix)");
  }
  return lines.join("\n");
}

function printHelp() {
  process.stdout.write(
    [
      "r2-trading-live-dead-history-inventory -- list dead R2 Litestream objects under trading-live/",
      "",
      "Uses AWS_R2_HISTORIC_* from the environment.  NO DELETES.",
      "--i-understand-r2-dead-history  print every key (still no delete)",
      "",
      "See docs/runbooks/r2-trading-live-dead-history-prune.md",
      "",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return 0;
  }
  const fullKeyList = argv.includes("--i-understand-r2-dead-history");
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const cfg = loadHistoricCreds();
    if (cfg.missing.length > 0) {
      process.stderr.write(
        `r2-trading-live-dead-history-inventory: missing ${cfg.missing.join(", ")}. ` +
          "Refusing to run.  No objects were listed or deleted.\n",
      );
      return 1;
    }
    if (cfg.bucket !== EXPECTED_HISTORIC_BUCKET) {
      process.stderr.write(
        `r2-trading-live-dead-history-inventory: bucket is "${cfg.bucket}", expected ` +
          `"${EXPECTED_HISTORIC_BUCKET}".  Fix AWS_R2_HISTORIC_BUCKET_NAME before listing.  ` +
          "No objects were deleted.\n",
      );
      return 1;
    }
    if (!cfg.endpointLooksLikeR2) {
      process.stderr.write(
        `r2-trading-live-dead-history-inventory: endpoint host "${cfg.host}" does not look like ` +
          "Cloudflare R2 (*.r2.cloudflarestorage.com).  STOP — you may be pointed at B2.  " +
          "No objects were listed or deleted.\n",
      );
      return 1;
    }
    let objects;
    try {
      objects = await listPrefixObjects(cfg, DEAD_HISTORY_PREFIX);
    } catch (err) {
      if (err && err.code === "AccessDenied") {
        process.stderr.write(
          `r2-trading-live-dead-history-inventory: AccessDenied listing prefix ${DEAD_HISTORY_PREFIX}. ` +
            "Check AWS_R2_HISTORIC_* permissions.  No objects were deleted.\n",
        );
        return 2;
      }
      throw err;
    }
    const summary = summarizeDeadHistory(objects);
    process.stdout.write(formatDeadHistoryReport(cfg, summary, objects, { fullKeyList }) + "\n");
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
      process.stderr.write(
        `r2-trading-live-dead-history-inventory: ${message}.  No objects were deleted.\n`,
      );
      process.exitCode = 1;
    });
}
