import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => { process.env.DATABASE_URL = `file:${join(tmpdir(), `code-cli-${randomUUID()}.db`)}`; });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function configure() {
  vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
  vi.stubEnv("CODE_CLI_ENABLED", "true"); vi.stubEnv("CODE_CLI_OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("CODE_CLI_OWNER_USER_ID", "local"); vi.stubEnv("CODE_CLI_BROKER_URL", "https://broker.internal/generate");
  vi.stubEnv("CODE_CLI_BROKER_TOKEN", "test-broker-token");
}
async function req(email: string, source="authjs-session") {
  const { NextRequest } = await import("next/server");
  return new NextRequest("https://app.invalid/api/keys", { method:"POST", headers:{"content-type":"application/json",
    "x-authenticated-user-email": email,"x-authenticated-identity-source":source},body:JSON.stringify({service:"minimax",route:"code-cli"}) });
}
describe("owner-only Code CLI route and scheduler identity", () => {
  it("allows selection only by verified configured primary, never tenant/admin/token/fallback", async () => {
    configure(); const { POST } = await import("../app/api/keys/route");
    expect((await POST(await req("owner@example.com"))).status).toBe(200);
    vi.stubEnv("ADMIN_USER_EMAILS", "tenant@example.com");
    expect((await POST(await req("tenant@example.com"))).status).toBe(403);
    expect((await POST(await req("owner@example.com","local-fallback"))).status).toBe(403);
    vi.stubEnv("CODE_CLI_ENABLED", "false");
    expect((await POST(await req("owner@example.com"))).status).toBe(403);
  });
  it("routes explicitly owned scheduled execution to broker with no provider key; copied tenant setting fails closed", async () => {
    configure(); const { setUserSetting,resolveLlmCredential } = await import("../src/lib/db");
    const { resolveLlmEndpoint, modelCredentialService }= await import("../src/lib/llm-provider");
    setUserSetting("local","llm_route_minimax","code-cli");
    const ep=resolveLlmEndpoint({llmModel:"minimax-m3.1-flash"},"local");
    expect(ep.url).toBe("code-cli://minimax/local"); expect(ep.keyRef).toBe("code-cli");
    expect(modelCredentialService("minimax-m3.1-flash","local")).toBe("minimax");
    setUserSetting("tenant","llm_route_minimax","code-cli");
    expect(resolveLlmCredential("minimax","tenant").key).toBeUndefined();
    expect(()=>resolveLlmEndpoint({llmModel:"minimax-m3.1-flash"},"tenant")).toThrow();
    vi.stubEnv("CODE_CLI_ENABLED","false");
    expect(()=>resolveLlmEndpoint({llmModel:"minimax-m3.1-flash"},"local")).toThrow();
  });
  it("uses the shared fetch boundary for scheduled/capturing calls and plain-text chat without executing tools", async () => {
    configure();const {setUserSetting}=await import("../src/lib/db");setUserSetting("local","llm_route_minimax","code-cli");
    const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(Response.json({version:1,text:"answer",finishReason:"stop"})));vi.stubGlobal("fetch",fetcher);
    const {llmFetchCapturing}=await import("../src/lib/llm-request");
    const body=JSON.stringify({model:"minimax-m3.1-flash",messages:[{role:"user",content:"hello"}]});
    await llmFetchCapturing("code-cli://minimax/local",{method:"POST",body},{softTimeoutMs:1000});
    const {llmForModel,getLLM}=await import("../src/lib/chat/llm");const executeTool=vi.fn();
    const result=await llmForModel("minimax-m3.1-flash","local").run({system:"test",message:"hello",tools:[],executeTool});
    expect(result.text).toBe("answer");expect(executeTool).not.toHaveBeenCalled();
    vi.stubEnv("CHAT_LLM","minimax");vi.stubEnv("CHAT_LLM_MODEL","minimax-m3.1-flash");
    await getLLM("local").run({system:"test",message:"hello",tools:[],executeTool});
    const {getDb}=await import("../src/lib/db");
    const usage=getDb().prepare("SELECT cost_usd, key_ref FROM llm_usage WHERE key_ref = ?").all("code-cli") as Array<{cost_usd:number|null;key_ref:string}>;
    expect(usage.length).toBeGreaterThan(0);expect(usage.every(row=>row.cost_usd===null)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for(const [url,init] of fetcher.mock.calls){expect(url).toBe("https://broker.internal/generate");expect(init.headers.authorization).toBe("Bearer test-broker-token");}
    const ids=fetcher.mock.calls.map(([,init])=>JSON.parse(init.body).requestId);expect(new Set(ids).size).toBe(3);
  });
  it("serves Code CLI-only Muse Wonder contributor ids only on a ready Code CLI route (ST-4589)", async () => {
    configure();
    const { setUserSetting } = await import("../src/lib/db");
    const provider = await import("../src/lib/llm-provider");
    setUserSetting("local", "llm_route_meta", "code-cli");
    for (const model of ["muse-wonder-1.0-contributor", "muse-wonder-full-1.0-contributor", "muse-wonder-1.0", "muse-spark-1.3"]) {
      const ep = provider.resolveLlmEndpoint({ llmModel: model }, "local");
      expect(ep.url, model).toBe("code-cli://meta/local");
      expect(ep.model, model).toBe(model);
      expect(ep.keyRef, model).toBe("code-cli");
    }
    expect(provider.codeCliOnlyModelServable("muse-wonder-1.0-contributor", "local")).toBe(true);
    // Never sent to api.meta.ai.
    expect(provider.metaNativeModelSlug("muse-wonder-1.0-contributor")).toBeUndefined();
    expect(provider.metaNativeModelSlug("muse-wonder-1.0")).toBe("muse-wonder-1.0");

    // Route off Code CLI: a clear, skippable error instead of an OpenRouter or Meta API call.
    for (const route of ["openrouter", "native"]) {
      setUserSetting("local", "llm_route_meta", route);
      let caught: unknown;
      try { provider.resolveLlmEndpoint({ llmModel: "muse-wonder-1.0-contributor" }, "local"); } catch (error) { caught = error; }
      expect(caught, route).toBeInstanceOf(provider.LlmModelUnavailableError);
      expect((caught as Error).message).toBe("muse-wonder-1.0-contributor runs only through the Code CLI route");
      expect(provider.isUnavailableModelResolutionError(caught)).toBe(true);
      expect(provider.codeCliOnlyModelServable("muse-wonder-1.0-contributor", "local")).toBe(false);
    }
    // Code CLI selected but not configured: also skippable; any other error is not.
    setUserSetting("local", "llm_route_meta", "code-cli");
    vi.stubEnv("CODE_CLI_ENABLED", "false");
    let notReady: unknown;
    try { provider.resolveLlmEndpoint({ llmModel: "muse-wonder-1.0-contributor" }, "local"); } catch (error) { notReady = error; }
    expect(provider.isUnavailableModelResolutionError(notReady)).toBe(true);
    expect(provider.codeCliOnlyModelServable("muse-wonder-1.0-contributor", "local")).toBe(false);
    expect(provider.isUnavailableModelResolutionError(new Error("database is locked"))).toBe(false);
    setUserSetting("local", "llm_route_meta", "openrouter");
  });
  it("does NOT forward reasoningEffort unless CODE_CLI_REASONING_EFFORT is on (default body unchanged)", async () => {
    configure();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ version: 1, text: "answer", finishReason: "stop" })));
    vi.stubGlobal("fetch", fetcher);
    const { llmFetch } = await import("../src/lib/llm-request");
    for (const flag of [undefined, "", "false", "0", "yes"]) {
      if (flag === undefined) vi.stubEnv("CODE_CLI_REASONING_EFFORT", undefined as unknown as string);
      else vi.stubEnv("CODE_CLI_REASONING_EFFORT", flag);
      await llmFetch("code-cli://meta/local", { method: "POST", body: JSON.stringify({ model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" }) });
      const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body) as Record<string, unknown>;
      expect("reasoningEffort" in sent, String(flag)).toBe(false);
      expect(Object.keys(sent)).toEqual(["version", "requestId", "ownerUserId", "adapter", "model", "messages", "maxOutputTokens", "capabilities"]);
    }
  });
  it("forwards an explicit reasoning effort to the broker, never none and never max for contributor models", async () => {
    configure();
    vi.stubEnv("CODE_CLI_REASONING_EFFORT", "true");
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ version: 1, text: "answer", finishReason: "stop" })));
    vi.stubGlobal("fetch", fetcher);
    const { llmFetch } = await import("../src/lib/llm-request");
    const send = async (service: string, model: string, effort?: string) => {
      await llmFetch(`code-cli://${service}/local`, { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...(effort ? { reasoning_effort: effort } : {}) }) });
      return JSON.parse(fetcher.mock.calls.at(-1)![1].body) as { reasoningEffort?: string; model: string };
    };
    expect((await send("meta", "muse-spark-1.3", "max")).reasoningEffort).toBe("max");
    expect((await send("meta", "muse-spark-1.3-contributor", "max")).reasoningEffort).toBe("xhigh");
    expect((await send("meta", "muse-wonder-1.0-contributor", "max")).reasoningEffort).toBe("xhigh");
    expect((await send("meta", "muse-wonder-full-1.0-contributor", "medium")).reasoningEffort).toBe("medium");
    expect((await send("minimax", "MiniMax-M3.1-Flash", "medium")).reasoningEffort).toBe("medium");
    expect("reasoningEffort" in (await send("minimax", "MiniMax-M3.1-Flash", "none"))).toBe(false);
    expect("reasoningEffort" in (await send("minimax", "MiniMax-M3"))).toBe(false);
    // An out-of-ladder value is dropped, not forwarded and not a failed call.
    expect("reasoningEffort" in (await send("meta", "muse-spark-1.3", "turbo"))).toBe(false);
  });
  it("rejects a mismatched deployment owner binding rather than treating local as authority", async()=>{
    configure();const {codeCliReady}=await import("../src/lib/code-cli");
    vi.stubEnv("CODE_CLI_OWNER_EMAIL","tenant@example.com");expect(codeCliReady("local")).toBe(false);
    vi.stubEnv("CODE_CLI_OWNER_EMAIL","owner@example.com");vi.stubEnv("CODE_CLI_OWNER_USER_ID","tenant");expect(codeCliReady("tenant")).toBe(false);
  });
});
