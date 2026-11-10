import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isBlockedFrameworkClient } from "../app/framework/ua-gate";
import { FRAMEWORK_CONTENT } from "../app/framework/content";
import { GET as getFrameworkContent } from "../app/api/framework/content/route";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

function contentRequest(opts: { ua?: string; proof?: boolean; fetchSite?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.ua !== undefined) headers["user-agent"] = opts.ua;
  if (opts.proof) headers["x-framework-viewer"] = "1";
  if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite;
  return new NextRequest("https://socratictrade.com/api/framework/content", { headers });
}

describe("framework UA gate", () => {
  it("blocks AI crawlers, HTTP libraries, and automation signatures", () => {
    const blocked = [
      "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
      "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "Mozilla/5.0 (compatible; PerplexityBot/1.0)",
      "CCBot/2.0 (https://commoncrawl.org/faq/)",
      "Bytespider; spider-feedback@bytedance.com",
      "curl/8.6.0",
      "Wget/1.21.4",
      "python-requests/2.32.0",
      "python-urllib/3.12",
      "Scrapy/2.11 (+https://scrapy.org)",
      "Go-http-client/2.0",
      "axios/1.7.2",
      "node-fetch/1.0",
      "okhttp/4.12.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36"
    ];
    for (const ua of blocked) {
      expect(isBlockedFrameworkClient(ua), `should block: ${ua}`).toBe(true);
    }
  });

  it("blocks empty, missing, and whitespace user agents", () => {
    expect(isBlockedFrameworkClient("")).toBe(true);
    expect(isBlockedFrameworkClient("   ")).toBe(true);
    expect(isBlockedFrameworkClient(null)).toBe(true);
    expect(isBlockedFrameworkClient(undefined)).toBe(true);
  });

  it("allows real desktop and mobile browsers", () => {
    for (const ua of [CHROME_UA, IPHONE_UA, FIREFOX_UA]) {
      expect(isBlockedFrameworkClient(ua), `should allow: ${ua}`).toBe(false);
    }
  });
});

describe("framework content API", () => {
  it("returns 404 for blocked user agents even with the proof header", async () => {
    const res = await getFrameworkContent(contentRequest({ ua: "curl/8.6.0", proof: true }));
    expect(res.status).toBe(404);
  });

  it("returns 404 without the proof header", async () => {
    const res = await getFrameworkContent(contentRequest({ ua: CHROME_UA }));
    expect(res.status).toBe(404);
  });

  it("returns 404 for cross-origin fetch metadata", async () => {
    const res = await getFrameworkContent(
      contentRequest({ ua: CHROME_UA, proof: true, fetchSite: "cross-site" })
    );
    expect(res.status).toBe(404);
  });

  it("serves content to a same-origin browser fetch with anti-indexing and no-store headers", async () => {
    const res = await getFrameworkContent(
      contentRequest({ ua: CHROME_UA, proof: true, fetchSite: "same-origin" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("x-robots-tag")).toContain("noai");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("tdm-reservation")).toBe("1");
    const body = (await res.json()) as { content: typeof FRAMEWORK_CONTENT };
    expect(body.content.title).toBe(FRAMEWORK_CONTENT.title);
    expect(body.content.pipeline.length).toBe(8);
  });

  it("tolerates absent fetch metadata when the proof header is present (older browsers)", async () => {
    const res = await getFrameworkContent(contentRequest({ ua: FIREFOX_UA, proof: true }));
    expect(res.status).toBe(200);
  });
});

describe("framework content shape", () => {
  it("has every section populated", () => {
    expect(FRAMEWORK_CONTENT.intro.length).toBeGreaterThan(0);
    expect(FRAMEWORK_CONTENT.pipeline.length).toBe(8);
    expect(FRAMEWORK_CONTENT.pipelineDiagram.length).toBe(8);
    expect(FRAMEWORK_CONTENT.principles.length).toBeGreaterThanOrEqual(4);
    expect(FRAMEWORK_CONTENT.layers.length).toBe(7);
    expect(FRAMEWORK_CONTENT.decisionCore.length).toBe(4);
    expect(FRAMEWORK_CONTENT.flywheelNodes.length).toBeGreaterThanOrEqual(5);
    expect(FRAMEWORK_CONTENT.learningLanes.length).toBe(5);
    expect(FRAMEWORK_CONTENT.autonomy.length).toBeGreaterThanOrEqual(3);
    expect(FRAMEWORK_CONTENT.invariants.length).toBeGreaterThanOrEqual(8);
    expect(FRAMEWORK_CONTENT.limits.length).toBeGreaterThanOrEqual(4);
    expect(FRAMEWORK_CONTENT.disclosures.length).toBeGreaterThanOrEqual(3);
  });
});
