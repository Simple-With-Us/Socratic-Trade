// Tests for multi-user credential tiering: env API keys are the operator's keys, not a silent
// global fallback for tenants. per-user-only services (broker + LLM, and any unlisted service)
// serve env to `local` only; shared-operator-infra services (market data, RAG, macro, scraper)
// keep a global env fallback. LLM keys add an operator-funded failover with per-user usage tracking.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tiering-${randomUUID()}.db`)}`;
});

describe("credential tiering — generic resolver", () => {
  it("per-user-only (alpaca): no env fallback for anyone; migrated into local's store at boot", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "env-alpaca");
    const { resolveApiKeyWithSource, migrateLocalEnvCredentials } = await import("../src/lib/db");

    // No special `local` env branch — even the primary user does not get the env key from the resolver.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "local").source).toBe("none");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");

    // The boot migration moves the operator's env key into local's per-user store → resolves "user".
    expect(migrateLocalEnvCredentials().migrated).toContain("alpaca_paper_api_key");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "local")).toMatchObject({ key: "env-alpaca", source: "user" });
    // A tenant still has nothing — `local` is not privileged, just migrated.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");
  });

  it("a tenant's own stored key always wins over env", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "env-alpaca");
    const { upsertUserApiKey, resolveApiKeyWithSource } = await import("../src/lib/db");
    upsertUserApiKey("u_tenant", "alpaca_paper_api_key", "tenant-key");
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant")).toMatchObject({ key: "tenant-key", source: "user" });
  });

  it("shared-operator-infra (market data): local user key serves ANY user before env fallback", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "env-finnhub");
    const { resolveApiKeyWithSource, upsertUserApiKey } = await import("../src/lib/db");
    
    // Without a local key, it falls back to env
    expect(resolveApiKeyWithSource("finnhub", "local").source).toBe("env");
    expect(resolveApiKeyWithSource("finnhub", "u_tenant")).toMatchObject({ key: "env-finnhub", source: "env" });
    expect(resolveApiKeyWithSource("finnhub", undefined).source).toBe("env");

    // With a local key, the local user's own key still wins for them (returns "user" source)
    upsertUserApiKey("local", "finnhub", "local-finnhub");
    expect(resolveApiKeyWithSource("finnhub", "local")).toMatchObject({ key: "local-finnhub", source: "user" });

    // But for a tenant/background caller, the configured env key still takes precedence over local fallback
    expect(resolveApiKeyWithSource("finnhub", "u_tenant")).toMatchObject({ key: "env-finnhub", source: "env" });
    expect(resolveApiKeyWithSource("finnhub", undefined)).toMatchObject({ key: "env-finnhub", source: "env" });

    // When the env key is absent, they fall back to the local database key (source "env")
    vi.unstubAllEnvs();
    delete process.env.FINNHUB_API_KEY;
    expect(resolveApiKeyWithSource("finnhub", "u_tenant")).toMatchObject({ key: "local-finnhub", source: "env" });
    expect(resolveApiKeyWithSource("finnhub", undefined)).toMatchObject({ key: "local-finnhub", source: "env" });
  });

  it("an unlisted service defaults to per-user-only (fail closed for a tenant)", async () => {
    vi.stubEnv("FRED_API_KEY", "env-fred"); // fred IS shared — control
    const { resolveApiKeyWithSource, credTierForService } = await import("../src/lib/db");
    expect(credTierForService("some_new_provider")).toBe("per-user-only");
    expect(credTierForService("finnhub")).toBe("shared-operator-infra");
    // fred (shared) serves the tenant; an unknown per-user-only service would not.
    expect(resolveApiKeyWithSource("fred", "u_tenant").source).toBe("env");
  });
});

describe("LLM credential — operator-funded failover", () => {
  it("a tenant's own key wins (source=user)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const { upsertUserApiKey, resolveLlmCredential } = await import("../src/lib/db");
    upsertUserApiKey("u_tenant", "openai", "tenant-openai");
    expect(resolveLlmCredential("openai", "u_tenant")).toMatchObject({ key: "tenant-openai", source: "user" });
  });

  it("any user (incl. local) without their own key uses the operator failover when ON (default)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    const { resolveLlmCredential } = await import("../src/lib/db");
    // No local carve-out — local and tenants alike reach the operator-funded failover.
    expect(resolveLlmCredential("openai", "local")).toMatchObject({ key: "env-openai", source: "operator" });
    expect(resolveLlmCredential("openai", "u_tenant")).toMatchObject({ key: "env-openai", source: "operator" });
  });

  it("with the failover OFF, every user (incl. local) needs their own key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
    const { resolveLlmCredential, upsertUserApiKey } = await import("../src/lib/db");
    // No local special case: with the failover off and no stored key, even local fails closed.
    expect(resolveLlmCredential("openai", "u_tenant")).toEqual({ source: "none" });
    expect(resolveLlmCredential("openai", "local")).toEqual({ source: "none" });
    // A stored key works for either (this is what the boot migration gives local).
    upsertUserApiKey("local", "openai", "local-openai");
    expect(resolveLlmCredential("openai", "local")).toMatchObject({ key: "local-openai", source: "user" });
  });
});

describe("LLM usage ledger", () => {
  it("extractLlmUsage normalizes OpenAI and Anthropic usage shapes", async () => {
    const { extractLlmUsage } = await import("../src/lib/llm-usage");
    expect(extractLlmUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(extractLlmUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    expect(extractLlmUsage({})).toEqual({});
  });

  it("records per-user usage and isolates operator-funded tenant spend", async () => {
    const { recordLlmUsage, getLlmUsageSummary } = await import("../src/lib/llm-usage");
    recordLlmUsage({ userId: "local", provider: "openai", model: "openai/gpt-4o-mini", context: "strategy", keySource: "user", promptTokens: 1000, completionTokens: 500 });
    recordLlmUsage({ userId: "u_tenant", provider: "openai", model: "openai/gpt-4o-mini", context: "chat", keySource: "operator", promptTokens: 2000, completionTokens: 1000 });

    const all = getLlmUsageSummary();
    expect(all.length).toBe(2);

    const operatorFunded = getLlmUsageSummary({ operatorFundedOnly: true });
    expect(operatorFunded.length).toBe(1);
    expect(operatorFunded[0].userId).toBe("u_tenant");
    expect(operatorFunded[0].calls).toBe(1);
    expect(operatorFunded[0].totalTokens).toBe(3000);
    expect(operatorFunded[0].costUsd).toBeGreaterThan(0); // gpt-4o-mini is priced
  });

  it("end-to-end: an LLM run() records a usage row with the userId + keySource it was built with", async () => {
    const { OpenAILLM } = await import("../src/lib/chat/llm");
    const { getLlmUsageSummary } = await import("../src/lib/llm-usage");

    // Transport that returns a usage block (operator-funded tenant call).
    const transport = async () => ({
      choices: [{ message: { content: "ack" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 30 }
    });
    const llm = new OpenAILLM("sk-test", "openai/gpt-4o-mini", transport, { userId: "u_tenant", keySource: "operator", context: "chat" });
    await llm.run({ system: "s", message: "hi", tools: [], executeTool: async () => ({}), history: [] });

    const rows = getLlmUsageSummary();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ userId: "u_tenant", provider: "openai", keySource: "operator", promptTokens: 120, completionTokens: 30 });
  });

  it("attributes usage PER ATTACHED KEY via a non-secret fingerprint", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-operator-key");
    const { resolveLlmCredential, upsertUserApiKey } = await import("../src/lib/db");
    const { recordLlmUsage, getLlmUsageSummary, keyFingerprint } = await import("../src/lib/llm-usage");

    upsertUserApiKey("u_tenant", "openai", "tenant-own-key");
    const own = resolveLlmCredential("openai", "u_tenant"); // user's own key
    const op = resolveLlmCredential("openai", "u_other"); // operator failover
    expect(own.keyRef).toBe(keyFingerprint("tenant-own-key"));
    expect(op.keyRef).toBe(keyFingerprint("env-operator-key"));
    expect(own.keyRef).not.toBe(op.keyRef);
    expect(own.keyRef).not.toContain("tenant-own-key"); // fingerprint, not the secret

    // Two calls on the operator key + one on the tenant's own key → grouped per key.
    recordLlmUsage({ userId: "u_other", provider: "openai", model: "openai/gpt-4o-mini", keySource: "operator", keyRef: op.keyRef, promptTokens: 100, completionTokens: 10 });
    recordLlmUsage({ userId: "u_third", provider: "openai", model: "openai/gpt-4o-mini", keySource: "operator", keyRef: op.keyRef, promptTokens: 100, completionTokens: 10 });
    recordLlmUsage({ userId: "u_tenant", provider: "openai", model: "openai/gpt-4o-mini", keySource: "user", keyRef: own.keyRef, promptTokens: 50, completionTokens: 5 });

    const byKey = getLlmUsageSummary();
    const opRows = byKey.filter((r) => r.keyRef === op.keyRef);
    const ownRows = byKey.filter((r) => r.keyRef === own.keyRef);
    expect(opRows.reduce((s, r) => s + r.calls, 0)).toBe(2); // both operator-key calls share a keyRef
    expect(ownRows.reduce((s, r) => s + r.calls, 0)).toBe(1);
    expect(byKey.every((r) => r.keyRef !== null)).toBe(true);
  });

  it("describeUsageKey resolves a human label + irreversible fingerprint from the live key store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-operator-key-ABCD");
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { describeUsageKey, displayKeyFingerprint, keyFingerprint } = await import("../src/lib/llm-usage");

    upsertUserApiKey("u_tenant", "openai", "tenant-own-key-WXYZ");
    upsertUserApiKey("local", "openai", "local-key-7788");

    // A tenant's own key → labeled by user + an irreversible fingerprint (never a raw-key
    // prefix/suffix — Connections promises a stored key is never displayed again).
    expect(describeUsageKey({ keyRef: keyFingerprint("tenant-own-key-WXYZ")!, userId: "u_tenant", provider: "openai" })).toEqual({
      fingerprint: displayKeyFingerprint("tenant-own-key-WXYZ"),
      label: "u_tenant (openai)"
    });
    // The `local` primary user's own key is not an operator failover key.
    expect(describeUsageKey({ keyRef: keyFingerprint("local-key-7788")!, userId: "local", provider: "openai" })).toEqual({
      fingerprint: displayKeyFingerprint("local-key-7788"),
      label: "primary user (openai)"
    });
    // A tenant served by server failover gets the env key's fingerprint.
    vi.stubEnv("OPENAI_API_KEY", "env-operator-key-ABCD");
    expect(describeUsageKey({ keyRef: keyFingerprint("env-operator-key-ABCD")!, userId: "u_other", provider: "openai" })).toEqual({
      fingerprint: displayKeyFingerprint("env-operator-key-ABCD"),
      label: "server failover (openai)"
    });
    // The fingerprint never contains any substring of the raw key (irreversible, safe to ship to the client).
    const desc = describeUsageKey({ keyRef: keyFingerprint("tenant-own-key-WXYZ")!, userId: "u_tenant", provider: "openai" });
    expect(desc?.fingerprint).not.toContain("tenant");
    expect(desc?.fingerprint).not.toContain("WXYZ");
    expect(desc?.fingerprint).toHaveLength(8);
    // A detached/unknown key (no longer in the store) → no label, fingerprint still in the ledger.
    expect(describeUsageKey({ keyRef: keyFingerprint("deleted-key")!, userId: "u_tenant", provider: "openai" })).toBeUndefined();
    expect(describeUsageKey({ keyRef: null, userId: "u_tenant", provider: "openai" })).toBeUndefined();
  });
});

describe("Alpaca market-data credential (shared data, per-user trading)", () => {
  it("a user's own Alpaca key gives individual data; otherwise the operator's paper key is shared", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "op-alpaca-key");
    vi.stubEnv("ALPACA_PAPER_SECRET_KEY", "op-alpaca-secret");
    const { resolveAlpacaMarketData, upsertUserApiKey } = await import("../src/lib/db");

    // No userId (background refresh) → operator's paper key as the SHARED source (source "env").
    expect(resolveAlpacaMarketData()).toMatchObject({ apiKey: "op-alpaca-key", secretKey: "op-alpaca-secret", source: "env" });
    // A tenant with no own key → operator's shared key.
    expect(resolveAlpacaMarketData("u_tenant").source).toBe("env");

    // A tenant WITH their own key → their individual data (source "user", private/pooled).
    upsertUserApiKey("u_tenant", "alpaca_paper_api_key", "tenant-alpaca-key");
    upsertUserApiKey("u_tenant", "alpaca_paper_secret_key", "tenant-alpaca-secret");
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({ apiKey: "tenant-alpaca-key", secretKey: "tenant-alpaca-secret", source: "user" });
  });

  it("resolves from connected_accounts if present, preferring active and live", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    // Add a paper account (inactive)
    upsertConnectedAccount({
      id: "acc-paper",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST-1",
      label: "Paper Acc",
      apiKey: "conn-paper-key",
      apiSecret: "conn-paper-secret",
      isActive: false
    });

    // Add a live account (inactive)
    upsertConnectedAccount({
      id: "acc-live",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "live",
      accountNumber: "LA-TEST-1",
      label: "Live Acc",
      apiKey: "conn-live-key",
      apiSecret: "conn-live-secret",
      isActive: false
    });

    // Should prefer live over paper when neither is active
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "conn-live-key",
      secretKey: "conn-live-secret",
      source: "user"
    });

    // Now make the paper account active (re-upserting changes active status)
    upsertConnectedAccount({
      id: "acc-paper",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST-1",
      label: "Paper Acc",
      apiKey: "conn-paper-key",
      apiSecret: "conn-paper-secret",
      isActive: true
    });

    // Should prefer active over live
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "conn-paper-key",
      secretKey: "conn-paper-secret",
      source: "user"
    });
  });

  it("uses the operator connected Alpaca account for shared background and tenant market data", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-alpaca",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator Paper",
      apiKey: "local-connected-key",
      apiSecret: "local-connected-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData()).toMatchObject({
      apiKey: "local-connected-key",
      secretKey: "local-connected-secret",
      source: "env"
    });
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "local-connected-key",
      secretKey: "local-connected-secret",
      source: "env"
    });
  });

  it("falls through incomplete tenant Alpaca credentials to the operator shared account", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant OAuth",
      apiKey: "tenant-oauth-token",
      isActive: true
    });

    upsertConnectedAccount({
      id: "local-alpaca",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator Paper",
      apiKey: "local-connected-key",
      apiSecret: "local-connected-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "local-connected-key",
      secretKey: "local-connected-secret",
      source: "env"
    });
  });

  it("preserves a tenant key-only Alpaca credential when no shared fallback exists", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant OAuth",
      apiKey: "tenant-oauth-token",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-oauth-token",
      source: "user"
    });
    expect(resolveAlpacaMarketData("u_tenant").secretKey).toBeUndefined();
  });

  it("preserves a tenant key-only Alpaca credential over an operator key-only connected account", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant OAuth",
      apiKey: "tenant-oauth-token",
      isActive: true
    });
    upsertConnectedAccount({
      id: "local-oauth-only",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator OAuth",
      apiKey: "local-oauth-token",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-oauth-token",
      source: "user"
    });
    expect(resolveAlpacaMarketData("u_tenant").secretKey).toBeUndefined();
  });

  it("checks another connected Alpaca account before falling back from a key-only preferred account", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "tenant-live-oauth-only",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "live",
      accountNumber: "LA-TENANT",
      label: "Tenant Live OAuth",
      apiKey: "tenant-live-token",
      isActive: true
    });
    upsertConnectedAccount({
      id: "tenant-paper-complete",
      userId: "u_tenant",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TENANT",
      label: "Tenant Paper",
      apiKey: "tenant-paper-key",
      apiSecret: "tenant-paper-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "tenant-paper-key",
      secretKey: "tenant-paper-secret",
      source: "user"
    });
  });

  it("preserves an operator key-only connected Alpaca credential for shared news enrichment", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-oauth-only",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator OAuth",
      apiKey: "local-oauth-token",
      isActive: true
    });

    expect(resolveAlpacaMarketData()).toMatchObject({
      apiKey: "local-oauth-token",
      source: "env"
    });
    expect(resolveAlpacaMarketData().secretKey).toBeUndefined();
    expect(resolveAlpacaMarketData("u_tenant")).toMatchObject({
      apiKey: "local-oauth-token",
      source: "env"
    });
  });

  it("prefers an operator connected key-only Alpaca credential over stored operator keys for news", async () => {
    const { resolveAlpacaMarketData, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-oauth-current",
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-LOCAL",
      label: "Operator OAuth",
      apiKey: "local-current-token",
      isActive: true
    });
    upsertUserApiKey("local", "alpaca_paper_api_key", "stale-operator-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "stale-operator-secret");

    expect(resolveAlpacaMarketData()).toMatchObject({
      apiKey: "local-current-token",
      source: "env"
    });
    expect(resolveAlpacaMarketData().secretKey).toBeUndefined();
  });

  it("ignores Alpaca MCP connected accounts for REST market-data resolution", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "op-alpaca-key");
    vi.stubEnv("ALPACA_PAPER_SECRET_KEY", "op-alpaca-secret");
    const { resolveAlpacaMarketData, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-alpaca-mcp",
      userId: "local",
      broker: "alpaca-mcp",
      environment: "paper",
      accountNumber: "MCP-LOCAL",
      label: "Operator MCP",
      apiKey: "mcp-token",
      apiSecret: "mcp-secret",
      isActive: true
    });

    expect(resolveAlpacaMarketData()).toMatchObject({
      apiKey: "op-alpaca-key",
      secretKey: "op-alpaca-secret",
      source: "env"
    });
  });

  it("trading resolution is unaffected — a tenant never gets the operator's Alpaca key to trade", async () => {
    vi.stubEnv("ALPACA_PAPER_API_KEY", "op-alpaca-key");
    const { resolveApiKeyWithSource } = await import("../src/lib/db");
    // The trading path (alpaca.ts uses resolveApiKey, per-user-only) fails closed for a tenant.
    expect(resolveApiKeyWithSource("alpaca_paper_api_key", "u_tenant").source).toBe("none");
  });
});

describe("resolveAlpacaStreamAccount (background WebSocket stream workers)", () => {
  it("prefers the active connected Alpaca account and reports its real environment", async () => {
    const { resolveAlpacaStreamAccount, upsertConnectedAccount } = await import("../src/lib/db");

    upsertConnectedAccount({
      id: "local-alpaca-live",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "LIVE-1",
      label: "Live Acc",
      apiKey: "live-key",
      apiSecret: "live-secret",
      isActive: true
    });

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "live-key",
      apiSecret: "live-secret",
      environment: "live"
    });
  });

  it("falls back to the legacy standalone key pair (as 'paper') when no connected Alpaca account exists", async () => {
    const { resolveAlpacaStreamAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "alpaca_paper_api_key", "legacy-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "legacy-secret");

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "legacy-key",
      apiSecret: "legacy-secret",
      environment: "paper"
    });
  });

  it("does not use a stale legacy key when a connected account is active — regression for the production incident", async () => {
    // Production incident: the legacy alpaca_paper_api_key/secret pair went stale (last
    // touched 2026-06-22) after the user rotated keys via Settings -> Accounts on 2026-06-29,
    // which only updates connected_accounts. The stream workers used to read the stale legacy
    // pair exclusively and got HTTP 401 from Alpaca. The active connected account must win.
    const { resolveAlpacaStreamAccount, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "alpaca_paper_api_key", "stale-legacy-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "stale-legacy-secret");
    upsertConnectedAccount({
      id: "local-alpaca-fresh",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "FRESH-1",
      label: "Fresh Acc",
      apiKey: "fresh-key",
      apiSecret: "fresh-secret",
      isActive: true
    });

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "fresh-key",
      apiSecret: "fresh-secret",
      environment: "live"
    });
  });

  it("returns undefined when neither a connected Alpaca account nor a legacy key exists", async () => {
    const { resolveAlpacaStreamAccount } = await import("../src/lib/db");
    expect(resolveAlpacaStreamAccount("brand-new-user")).toBeUndefined();
  });

  it("prefers a connected Alpaca account over legacy keys even when another broker is active", async () => {
    const { resolveAlpacaStreamAccount, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey("local", "alpaca_paper_api_key", "stale-legacy-key");
    upsertUserApiKey("local", "alpaca_paper_secret_key", "stale-legacy-secret");
    upsertConnectedAccount({
      id: "local-robinhood",
      userId: "local",
      broker: "robinhood",
      environment: "live",
      accountNumber: "RH-1",
      label: "Robinhood Acc",
      isActive: true
    });
    upsertConnectedAccount({
      id: "local-alpaca-inactive",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "ALPACA-1",
      label: "Alpaca Acc",
      apiKey: "fresh-connected-key",
      apiSecret: "fresh-connected-secret",
      isActive: false
    });

    expect(resolveAlpacaStreamAccount("local")).toMatchObject({
      apiKey: "fresh-connected-key",
      apiSecret: "fresh-connected-secret",
      environment: "live"
    });
  });
});
