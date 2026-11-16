// r2-cold-snapshot-inventory.test.ts — read-only historic R2 inventory script.
//
// Covers XML parse, AccessDenied detection, prefix summaries, and the
// no-delete contract of scripts/ops/r2-cold-snapshot-inventory.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The inventory helper is a standalone .mjs ops script; tsc has no types for it.
// @ts-expect-error TS7016 — scripts/ops/*.mjs is untyped on purpose
import * as inventory from "../scripts/ops/r2-cold-snapshot-inventory.mjs";

const {
  TRACKED_PREFIXES,
  formatInventoryReport,
  isAccessDenied,
  listAllObjects,
  parseListObjectsV2,
  summarizeInventory,
} = inventory;

describe("r2-cold-snapshot-inventory parse + summarize", () => {
  it("parses keys and sizes from ListObjectsV2 XML", () => {
    const xml = `
      <ListBucketResult>
        <Contents><Key>cold-snapshots/app-2026-08-30.db</Key><Size>9679310848</Size></Contents>
        <Contents><Key>cold-snapshots/app-2026-08-31.db.gz</Key><Size>3000000000</Size></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>
    `;
    const parsed = parseListObjectsV2(xml);
    expect(parsed.truncated).toBe(false);
    expect(parsed.continuation).toBeNull();
    expect(parsed.objects).toEqual([
      { key: "cold-snapshots/app-2026-08-30.db", size: 9679310848 },
      { key: "cold-snapshots/app-2026-08-31.db.gz", size: 3000000000 },
    ]);
  });

  it("summarizes tracked prefixes including empty trading-live/ and weekly/", () => {
    expect(TRACKED_PREFIXES).toEqual(["cold-snapshots/", "trading-live/", "weekly/"]);
    const summary = summarizeInventory([
      { key: "cold-snapshots/app-2026-08-30.db", size: 9679310848 },
    ]);
    expect(summary.objectCount).toBe(1);
    expect(summary.bucketSize).toBe(9679310848);
    expect(summary.byPrefix["cold-snapshots/"].count).toBe(1);
    expect(summary.byPrefix["trading-live/"].count).toBe(0);
    expect(summary.byPrefix["weekly/"].count).toBe(0);
    const report = formatInventoryReport("socratic-trade-bucket", summary);
    expect(report).toContain("bucket=socratic-trade-bucket");
    expect(report).toContain("object_count=1");
    expect(report).toContain("cold-snapshots/app-2026-08-30.db  9679310848");
    expect(report).toContain("prefix=trading-live/ count=0");
    expect(report).toContain("prefix=weekly/ count=0");
    expect(report).not.toMatch(/AKIA|secret|token|Authorization/i);
  });

  it("treats HTTP 403 / AccessDenied XML as access denied", () => {
    expect(isAccessDenied(403, "")).toBe(true);
    expect(isAccessDenied(200, "<Error><Code>AccessDenied</Code></Error>")).toBe(true);
    expect(isAccessDenied(200, "<ListBucketResult></ListBucketResult>")).toBe(false);
  });

  it("listAllObjects throws AccessDenied on 403 without deleting", async () => {
    await expect(
      listAllObjects(
        {
          bucket: "socratic-trade-bucket",
          host: "acct.r2.cloudflarestorage.com",
          region: "auto",
          accessKeyId: "AKIATEST",
          secretAccessKey: "secret",
        },
        async () => ({ status: 403, ok: false, body: "<Error><Code>AccessDenied</Code></Error>" }),
      ),
    ).rejects.toMatchObject({ code: "AccessDenied", status: 403 });
  });
});

describe("r2-cold-snapshot-inventory source contract", () => {
  it("is GET-only and does not call DeleteObject", () => {
    const src = readFileSync(
      join(process.cwd(), "scripts/ops/r2-cold-snapshot-inventory.mjs"),
      "utf8",
    );
    expect(src).toMatch(/refusing non-GET S3 method/);
    expect(src).toMatch(/NO DELETES/);
    expect(src).not.toMatch(/DeleteObject/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(src).not.toMatch(/method === "DELETE"/);
  });
});
