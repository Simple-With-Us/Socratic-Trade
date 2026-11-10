import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSecUniverseManifest } from "../src/lib/rag/universe-manifest";

// This is the "validate the committed artifact in CI" gate: data/rag-universe-manifest.json is
// the real file the SEC ingest seeder reads, so it must pass the SAME validator the seeder refuses
// to run against otherwise. See docs/rollouts/2026-07-18-sec-ingest-worker-wiring.md — the manifest
// used to be a bare issuer array that failed its own schema (Codex audit items 2/3/4); this test
// carries the regression check `npm test` already runs on every PR.
describe("committed SEC/RAG universe manifest (data/rag-universe-manifest.json)", () => {
  it("validates with zero issues against the schema the ingest pipeline enforces", () => {
    const manifestPath = path.resolve("data/rag-universe-manifest.json");
    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as unknown;

    const issues = validateSecUniverseManifest(manifest);

    expect(issues).toEqual([]);
  });

  it("carries exactly 1,000 issuers", () => {
    const manifestPath = path.resolve("data/rag-universe-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { issuers: unknown[] };
    expect(manifest.issuers).toHaveLength(1000);
  });
});
