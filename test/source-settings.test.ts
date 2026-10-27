import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getUserSourceSettingsMap,
  patchUserSourceSettings,
  resolveSourceBool,
  resolveSourceNumber
} from "../src/lib/source-settings";
import { SOURCE_SETTINGS_CATALOG } from "../src/lib/source-settings-catalog";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-source-settings-${randomUUID()}.db`)}`;
});

describe("source-settings", () => {
  beforeEach(() => {
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
    delete process.env.SEC_FILING_RAG_MAX_PER_RUN;
    delete process.env.SEC_FILING_INGEST_TTL_HOURS;
    patchUserSourceSettings("local", {
      WEB_SOURCE_SEC8K_FULL_BODY: null,
      SEC_FILING_RAG_MAX_PER_RUN: null,
      SEC_FILING_INGEST_TTL_HOURS: null
    });
  });

  it("catalog has SEC knobs and no FMP settings", () => {
    const ids = SOURCE_SETTINGS_CATALOG.map((s) => s.id);
    expect(ids.filter((id) => /fmp/i.test(id))).toEqual([]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "WEB_SOURCE_SEC8K_FULL_BODY",
        "SEC_FILING_RAG_MAX_PER_RUN",
        "RAG_EMBED_DISCLOSURES",
        "RAG_RUN_BUDGET_ENABLED",
        "RAG_RUN_BUDGET_CEILING",
        "RAG_RUN_BUDGET_WINDOW_MS"
      ])
    );
  });

  it("user override beats env for booleans", () => {
    process.env.WEB_SOURCE_SEC8K_FULL_BODY = "on";
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(true);
    patchUserSourceSettings("local", { WEB_SOURCE_SEC8K_FULL_BODY: false });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(false);
    expect(getUserSourceSettingsMap("local").WEB_SOURCE_SEC8K_FULL_BODY).toBe(false);
  });

  it("user override beats env for numbers", () => {
    process.env.SEC_FILING_RAG_MAX_PER_RUN = "10";
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(10);
    patchUserSourceSettings("local", { SEC_FILING_RAG_MAX_PER_RUN: 42 });
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(42);
  });

  it("reset null falls back to env/default", () => {
    patchUserSourceSettings("local", { WEB_SOURCE_SEC8K_FULL_BODY: true });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(true);
    patchUserSourceSettings("local", { WEB_SOURCE_SEC8K_FULL_BODY: null });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(false);
  });

  it("catalog default for SEC_FILING_INGEST_TTL_HOURS is the paid daily cadence", () => {
    const spec = SOURCE_SETTINGS_CATALOG.find((s) => s.id === "SEC_FILING_INGEST_TTL_HOURS");
    expect(spec?.defaultValue).toBe(24);
    delete process.env.SEC_FILING_INGEST_TTL_HOURS;
    patchUserSourceSettings("local", { SEC_FILING_INGEST_TTL_HOURS: null });
    expect(resolveSourceNumber("SEC_FILING_INGEST_TTL_HOURS")).toBe(24);
  });

  it("user override enables VECTOR_EMBED_CLEAN_TEXT / RAG_MULTIQUERY / RAG_HYDE without env", () => {
    delete process.env.VECTOR_EMBED_CLEAN_TEXT;
    delete process.env.RAG_MULTIQUERY;
    delete process.env.RAG_HYDE;
    patchUserSourceSettings("local", {
      VECTOR_EMBED_CLEAN_TEXT: null,
      RAG_MULTIQUERY: null,
      RAG_HYDE: null
    });
    expect(resolveSourceBool("VECTOR_EMBED_CLEAN_TEXT")).toBe(false);
    expect(resolveSourceBool("RAG_MULTIQUERY")).toBe(false);
    expect(resolveSourceBool("RAG_HYDE")).toBe(false);
    patchUserSourceSettings("local", {
      VECTOR_EMBED_CLEAN_TEXT: true,
      RAG_MULTIQUERY: true,
      RAG_HYDE: true
    });
    expect(resolveSourceBool("VECTOR_EMBED_CLEAN_TEXT")).toBe(true);
    expect(resolveSourceBool("RAG_MULTIQUERY")).toBe(true);
    expect(resolveSourceBool("RAG_HYDE")).toBe(true);
    patchUserSourceSettings("local", {
      VECTOR_EMBED_CLEAN_TEXT: null,
      RAG_MULTIQUERY: null,
      RAG_HYDE: null
    });
  });

  it("user override beats env for RAG run-budget knobs", () => {
    process.env.RAG_RUN_BUDGET_CEILING = "5000";
    process.env.RAG_RUN_BUDGET_ENABLED = "on";
    expect(resolveSourceNumber("RAG_RUN_BUDGET_CEILING")).toBe(5000);
    patchUserSourceSettings("local", { RAG_RUN_BUDGET_CEILING: 250, RAG_RUN_BUDGET_ENABLED: false });
    expect(resolveSourceNumber("RAG_RUN_BUDGET_CEILING", "local")).toBe(250);
    expect(resolveSourceBool("RAG_RUN_BUDGET_ENABLED", "local")).toBe(false);
    patchUserSourceSettings("local", { RAG_RUN_BUDGET_CEILING: null, RAG_RUN_BUDGET_ENABLED: null });
  });
});
