import { afterEach, describe, expect, it, vi } from "vitest";
import { codeCliReady, codeCliUrl, fetchCodeCli } from "../src/lib/code-cli";

const owner = "local";
function configured() {
  vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
  vi.stubEnv("CODE_CLI_ENABLED", "true");
  vi.stubEnv("CODE_CLI_OWNER_USER_ID", owner);
  vi.stubEnv("CODE_CLI_OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("CODE_CLI_BROKER_URL", "https://broker.internal/generate");
  vi.stubEnv("CODE_CLI_BROKER_TOKEN", "test-broker-token");
}
const request = (extra = {}) => ({ method: "POST", headers: { authorization: "Bearer API-KEY-MUST-NOT-LEAK" },
  body: JSON.stringify({ model: "MiniMax-M2.7", messages: [{ role: "user", content: "test input" }], max_tokens: 200, ...extra }) });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Code CLI private text-only contract", () => {
  it("defaults off and requires explicit owner, email, token and secure URL", () => {
    expect(codeCliReady(owner)).toBe(false);
    configured(); expect(codeCliReady(owner)).toBe(true); expect(codeCliReady("tenant")).toBe(false);
    expect(() => codeCliUrl("minimax", "tenant")).toThrow();
    for (const bad of ["http://broker.internal/generate", "https://user:pass@broker/generate", "https://broker/generate?token=secret", "file:///etc/passwd"]) {
      vi.stubEnv("CODE_CLI_BROKER_URL", bad); expect(codeCliReady(owner)).toBe(false);
    }
  });
  it("rechecks disabled/tenant execution before any network access", async () => {
    configured(); const url = codeCliUrl("minimax", owner); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("CODE_CLI_ENABLED", "false"); await expect(fetchCodeCli(url, request())).rejects.toThrow("denied");
    vi.stubEnv("CODE_CLI_ENABLED", "true"); await expect(fetchCodeCli("code-cli://minimax/tenant", request())).rejects.toThrow("denied");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{tools: []}, {functions: []}, {stream: true}, {messages:[{role:"tool",content:"x"}]},
    {messages:[{role:"user",content:[{type:"image_url"}]}]}, {model:"gpt-5"}, {messages:[]},
    {messages:[{role:"assistant",content:"x",tool_calls:[{}]}]}, {stream:"yes"}, {max_tokens:"many"}])("rejects agent/multimodal or unrelated model input %j", async extra => {
    configured(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(fetchCodeCli(codeCliUrl("minimax", owner), request(extra))).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reconstructs broker payload without provider keys, paths, session IDs or extra fields", async () => {
    configured(); const fetcher = vi.fn().mockResolvedValue(Response.json({version:1,text:"answer",finishReason:"stop"})); vi.stubGlobal("fetch", fetcher);
    const res = await fetchCodeCli(codeCliUrl("minimax", owner), request({cwd:"/root",sessionId:"reuse-other-user",api_key:"secret",max_tokens:90000,temperature:0.7,stream:false}));
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe("https://broker.internal/generate");
    expect(init.redirect).toBe("error"); expect(init.headers.authorization).toBe("Bearer test-broker-token");
    const payload=JSON.parse(init.body); expect(payload.maxOutputTokens).toBe(16000);
    expect(payload.capabilities).toEqual({tools:false,terminal:false,files:false,mcp:false});
    expect(payload).not.toHaveProperty("cwd"); expect(payload).not.toHaveProperty("sessionId"); expect(payload).not.toHaveProperty("temperature");
    expect(JSON.stringify(init)).not.toContain("API-KEY-MUST-NOT-LEAK"); expect(JSON.stringify(payload)).not.toContain("secret");
    expect((await res.json()).choices[0].message.content).toBe("answer");
  });
  it.each([Response.json({version:2,text:"answer",finishReason:"stop"}), Response.json({version:1,text:"",finishReason:"stop"}),
    new Response("private CLI token details",{status:502})])("fails closed on invalid/failed broker response", async response => {
    configured(); vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response));
    await expect(fetchCodeCli(codeCliUrl("minimax",owner),request())).rejects.toThrow(/Code CLI/);
  });
});

it("does not launch an already-cancelled request and bounds broker response bytes", async () => {
  configured(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const controller=new AbortController();controller.abort();
  await expect(fetchCodeCli(codeCliUrl("minimax",owner),{...request(),signal:controller.signal})).rejects.toThrow("cancelled");
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(new Response("x".repeat(1_000_001)));
  await expect(fetchCodeCli(codeCliUrl("minimax",owner),request())).rejects.toThrow("exceeds text limit");
});

it("preserves the caller timeout signal and defaults to the reasoning-safe bound", async () => {
  configured();
  const fetcher=vi.fn().mockImplementation(async () => Response.json({version:1,text:"answer",finishReason:"stop"}));
  vi.stubGlobal("fetch",fetcher);
  const controller=new AbortController();
  await fetchCodeCli(codeCliUrl("minimax",owner),{...request(),signal:controller.signal});
  expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  const timeout=vi.spyOn(AbortSignal,"timeout");
  await fetchCodeCli(codeCliUrl("minimax",owner),request());
  expect(timeout).toHaveBeenCalledWith(150_000);
  timeout.mockRestore();
});
