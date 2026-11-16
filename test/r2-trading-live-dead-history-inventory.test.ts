// r2-trading-live-dead-history-inventory.test.ts — dead R2 trading-live/ inventory script.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error TS7016 — scripts/ops/*.mjs is untyped on purpose
import * as deadHistory from "../scripts/ops/r2-trading-live-dead-history-inventory.mjs";

const {
  DEAD_HISTORY_PREFIX,
  EXPECTED_HISTORIC_BUCKET,
  formatDeadHistoryReport,
  listPrefixObjects,
  summarizeDeadHistory,
} = deadHistory;

describe("r2-trading-live-dead-history-inventory summarize", () => {
  it("tracks trading-live/app.db second-level segment", () => {
    const objects = [
      { key: "trading-live/app.db/0001/00000001-00000002.ltx", size: 100 },
      { key: "trading-live/app.db/0001/00000003-00000004.ltx", size: 200 },
    ];
    const summary = summarizeDeadHistory(objects);
    expect(summary.objectCount).toBe(2);
    expect(summary.totalSize).toBe(300);
    expect(summary.bySecondLevel[0]).toMatchObject({ name: "app.db", count: 2, size: 300 });
  });

  it("formats report without secrets", () => {
    const cfg = {
      bucket: "socratic-trade-bucket",
      host: "abc123.r2.cloudflarestorage.com",
      endpointLooksLikeR2: true,
    };
    const summary = summarizeDeadHistory([{ key: "trading-live/app.db/0001/a.ltx", size: 42 }]);
    const report = formatDeadHistoryReport(cfg, summary, [{ key: "trading-live/app.db/0001/a.ltx", size: 42 }], {
      fullKeyList: false,
    });
    expect(report).toContain("NO DELETES");
    expect(report).toContain("bucket=socratic-trade-bucket");
    expect(report).toContain("endpoint_looks_like_r2=true");
    expect(report).toContain("trading-live/app.db/0001/a.ltx  42");
    expect(report).not.toMatch(/secret|Authorization/i);
  });
});

describe("r2-trading-live-dead-history-inventory listPrefixObjects", () => {
  it("passes prefix to ListObjectsV2", async () => {
    const seen: string[] = [];
    const objects = await listPrefixObjects(
      {
        bucket: EXPECTED_HISTORIC_BUCKET,
        host: "acct.r2.cloudflarestorage.com",
        region: "auto",
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret",
      },
      DEAD_HISTORY_PREFIX,
      async (_cfg: { bucket: string }, query: Record<string, string>) => {
        seen.push(String(query.prefix));
        return {
          status: 200,
          ok: true,
          body: `<ListBucketResult>
            <Contents><Key>trading-live/app.db/0001/a.ltx</Key><Size>1</Size></Contents>
            <IsTruncated>false</IsTruncated>
          </ListBucketResult>`,
        };
      },
    );
    expect(seen).toEqual([DEAD_HISTORY_PREFIX]);
    expect(objects).toHaveLength(1);
  });
});

describe("r2-trading-live-dead-history-inventory source contract", () => {
  it("is GET-only and has no object-delete path", () => {
    const src = readFileSync(
      join(process.cwd(), "scripts/ops/r2-trading-live-dead-history-inventory.mjs"),
      "utf8",
    );
    expect(src).toMatch(/NO DELETES/);
    expect(src).toMatch(/refusing non-GET S3 method/);
    expect(src).not.toMatch(/DeleteObject/);
    expect(src).not.toMatch(/method:\s*"DELETE"/);
    expect(src).toMatch(/--i-understand-r2-dead-history/);
    expect(src).toMatch(/does NOT enable deletion/);
  });
});
