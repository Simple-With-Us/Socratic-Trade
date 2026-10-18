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
    const ep=resolveLlmEndpoint({llmModel:"minimax-m3"},"local");
    expect(ep.url).toBe("code-cli://minimax/local"); expect(ep.keyRef).toBe("code-cli");
    expect(modelCredentialService("minimax-m3","local")).toBe("minimax");
    setUserSetting("tenant","llm_route_minimax","code-cli");
    expect(resolveLlmCredential("minimax","tenant").key).toBeUndefined();
    expect(()=>resolveLlmEndpoint({llmModel:"minimax-m3"},"tenant")).toThrow();
    vi.stubEnv("CODE_CLI_ENABLED","false");
    expect(()=>resolveLlmEndpoint({llmModel:"minimax-m3"},"local")).toThrow();
  });
  it("uses the shared fetch boundary for scheduled/capturing calls and plain-text chat without executing tools", async () => {
    configure();const {setUserSetting}=await import("../src/lib/db");setUserSetting("local","llm_route_minimax","code-cli");
    const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(Response.json({version:1,text:"answer",finishReason:"stop"})));vi.stubGlobal("fetch",fetcher);
    const {llmFetchCapturing}=await import("../src/lib/llm-request");
    const body=JSON.stringify({model:"minimax-m3",messages:[{role:"user",content:"hello"}]});
    await llmFetchCapturing("code-cli://minimax/local",{method:"POST",body},{softTimeoutMs:1000});
    const {llmForModel,getLLM}=await import("../src/lib/chat/llm");const executeTool=vi.fn();
    const result=await llmForModel("minimax-m3","local").run({system:"test",message:"hello",tools:[],executeTool});
    expect(result.text).toBe("answer");expect(executeTool).not.toHaveBeenCalled();
    vi.stubEnv("CHAT_LLM","minimax");vi.stubEnv("CHAT_LLM_MODEL","minimax-m3");
    await getLLM("local").run({system:"test",message:"hello",tools:[],executeTool});
    const {getDb}=await import("../src/lib/db");
    const usage=getDb().prepare("SELECT cost_usd, key_ref FROM llm_usage WHERE key_ref = ?").all("code-cli") as Array<{cost_usd:number|null;key_ref:string}>;
    expect(usage.length).toBeGreaterThan(0);expect(usage.every(row=>row.cost_usd===null)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for(const [url,init] of fetcher.mock.calls){expect(url).toBe("https://broker.internal/generate");expect(init.headers.authorization).toBe("Bearer test-broker-token");}
    const ids=fetcher.mock.calls.map(([,init])=>JSON.parse(init.body).requestId);expect(new Set(ids).size).toBe(3);
  });
  it("rejects a mismatched deployment owner binding rather than treating local as authority", async()=>{
    configure();const {codeCliReady}=await import("../src/lib/code-cli");
    vi.stubEnv("CODE_CLI_OWNER_EMAIL","tenant@example.com");expect(codeCliReady("local")).toBe(false);
    vi.stubEnv("CODE_CLI_OWNER_EMAIL","owner@example.com");vi.stubEnv("CODE_CLI_OWNER_USER_ID","tenant");expect(codeCliReady("tenant")).toBe(false);
  });
});
