// Coach/chat → durable learning (Wave D partial).
// Covers: intent detection, SSRF rejects, strong directive → pending strategy-directive,
// mild preference → fact write via ingestLearned, URL lesson with mocked fetch.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, listAudit, listLearnedContext, listPendingLearnedContext } from "../src/lib/db";
import {
  assertPublicHttpsUrl,
  captureCoachLearning,
  detectCoachLearningIntent,
  extractUrls,
  isPrivateOrReservedIp,
  stripHtmlToText,
  summarizeArticleText
} from "../src/lib/chat/coach-learning";

const USER = "coach-learning-user";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/coach-learning-test-${Date.now()}.db`;
  // Offline: keyword classifier only.
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
  getDb();
});

beforeEach(() => {
  // Isolate rows between cases without wiping schema.
  const db = getDb();
  db.prepare("DELETE FROM learned_context WHERE user_id = ?").run(USER);
  db.prepare("DELETE FROM learned_context_pending WHERE user_id = ?").run(USER);
});

describe("detectCoachLearningIntent", () => {
  it("detects strong strategy directives", () => {
    const d = detectCoachLearningIntent("From now on prefer value over growth names");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("directive");
    expect(d!.strong).toBe(true);
  });

  it("detects 'I want the system to…'", () => {
    const d = detectCoachLearningIntent("I want the system to avoid meme stocks entirely");
    expect(d?.kind).toBe("directive");
    expect(d?.strong).toBe(true);
  });

  it("detects mild prefer/avoid without strong cue", () => {
    const d = detectCoachLearningIntent("Prefer semiconductor leaders with real free cash flow");
    expect(d?.kind).toBe("directive");
    expect(d?.strong).toBe(false);
  });

  it("detects pasted https URLs", () => {
    const d = detectCoachLearningIntent("Useful read: https://example.com/strategy-notes");
    expect(d?.kind).toBe("url");
    expect(d?.urls).toEqual(["https://example.com/strategy-notes"]);
  });

  it("ignores ordinary chat", () => {
    expect(detectCoachLearningIntent("What is AAPL trading at?")).toBeNull();
    expect(detectCoachLearningIntent("hello")).toBeNull();
  });
});

describe("extractUrls + SSRF gate", () => {
  it("strips trailing punctuation from URLs", () => {
    expect(extractUrls("see https://example.com/a.")).toEqual(["https://example.com/a"]);
  });

  it("rejects http (https only)", async () => {
    const r = await assertPublicHttpsUrl("http://example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("https_only");
  });

  it("rejects localhost and loopback", async () => {
    expect((await assertPublicHttpsUrl("https://localhost/admin")).ok).toBe(false);
    expect((await assertPublicHttpsUrl("https://127.0.0.1/secret")).ok).toBe(false);
  });

  it("rejects private IPv4 literals", async () => {
    expect((await assertPublicHttpsUrl("https://10.0.0.5/x")).ok).toBe(false);
    expect((await assertPublicHttpsUrl("https://192.168.1.1/x")).ok).toBe(false);
    expect((await assertPublicHttpsUrl("https://172.16.0.1/x")).ok).toBe(false);
    expect((await assertPublicHttpsUrl("https://169.254.169.254/latest")).ok).toBe(false);
  });

  it("rejects credentials in URL", async () => {
    const r = await assertPublicHttpsUrl("https://user:pass@example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("credentials_not_allowed");
  });

  it("isPrivateOrReservedIp covers common ranges", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
  });

  it("accepts a public https host (DNS-resolvable)", async () => {
    // example.com is reserved for docs and publicly resolves to public IPs.
    const r = await assertPublicHttpsUrl("https://example.com/path");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toMatch(/^https:\/\/example\.com\//);
  });
});

describe("HTML strip + summarize", () => {
  it("pulls title and strips tags", () => {
    const text = stripHtmlToText("<html><head><title>Alpha Notes</title></head><body><p>Hello <b>world</b></p><script>evil()</script></body></html>");
    expect(text).toMatch(/Alpha Notes/);
    expect(text).toMatch(/Hello world/);
    expect(text).not.toMatch(/evil|script/i);
  });

  it("summarize prefixes source URL and caps length", () => {
    const long = "word ".repeat(200);
    const s = summarizeArticleText(long, "https://example.com/a", 80);
    expect(s.startsWith("Lesson from https://example.com/a:")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(80 + "Lesson from https://example.com/a: ".length);
  });
});

describe("captureCoachLearning — durable writes", () => {
  it("strong directive creates strategy-directive pending + audit (not silent write)", async () => {
    const r = await captureCoachLearning({
      userId: USER,
      message: "From now on I want the system to favor quality compounders",
      indexVectors: false
    });
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("directive");
    expect(r.tier).toBe("strategy-directive");
    expect(r.pendingId).toBeTruthy();
    expect(r.writtenId).toBeNull();
    expect(r.receipt).toMatch(/approval/i);

    const pending = listPendingLearnedContext(USER, "pending");
    expect(pending.some((p) => p.id === r.pendingId && p.riskTier === "strategy-directive")).toBe(true);
    expect(listLearnedContext(USER).length).toBe(0);
    expect(listAudit(20, USER).some((a) => a.kind === "learned_context.pending")).toBe(true);
  });

  it("mild preference can write a fact row (source owner-coach)", async () => {
    // "ASML is the sole supplier" shape is a clean fact; mild path uses prefer without risk knobs.
    const r = await captureCoachLearning({
      userId: USER,
      message: "Prefer companies that are the sole supplier of a critical component",
      indexVectors: false
    });
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("directive");
    // With semantic gate off, keyword classify on this prose (no risk subjects/numerics/intent
    // keywords beyond "prefer" which is not in RISK_INTENT_KEYWORDS) → fact.
    expect(r.tier).toBe("fact");
    expect(r.writtenId).toBeTruthy();
    expect(r.pendingId).toBeNull();
    expect(r.receipt).toMatch(/durable learned context/i);

    const rows = listLearnedContext(USER);
    expect(rows.some((row) => row.id === r.writtenId && row.source === "owner-coach" && row.origin === "ingest")).toBe(true);
  });

  it("risk-flavored mild preference queues pending instead of silent write", async () => {
    const r = await captureCoachLearning({
      userId: USER,
      message: "Prefer leaning harder into tech with higher position sizing",
      indexVectors: false
    });
    expect(r.detected).toBe(true);
    expect(r.pendingId).toBeTruthy();
    expect(r.writtenId).toBeNull();
    expect(r.receipt).toMatch(/approval/i);
    expect(r.tier).toBe("risk");
  });

  it("URL path: mock fetch writes fact lesson; SSRF-blocked host does not", async () => {
    const html = "<html><head><title>Edge Research</title></head><body><p>Quality moats compound.</p></body></html>";
    const mockFetch: typeof fetch = vi.fn(async () => {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }) as unknown as typeof fetch;

    const ok = await captureCoachLearning({
      userId: USER,
      message: "Please learn from https://example.com/moats",
      fetchImpl: mockFetch,
      indexVectors: false
    });
    expect(ok.detected).toBe(true);
    expect(ok.kind).toBe("url");
    expect(ok.writtenId).toBeTruthy();
    expect(ok.receipt).toMatch(/Captured a short lesson/i);
    const rows = listLearnedContext(USER);
    const row = rows.find((x) => x.id === ok.writtenId);
    expect(row?.subject).toBe("coach-url-lesson");
    expect(row?.value).toMatch(/example\.com\/moats/);
    expect(row?.value).toMatch(/Quality moats|Edge Research/i);
    expect(mockFetch).toHaveBeenCalled();

    // Clear and try SSRF reject (no fetch should be needed for private IP).
    getDb().prepare("DELETE FROM learned_context WHERE user_id = ?").run(USER);
    const bad = await captureCoachLearning({
      userId: USER,
      message: "Read https://127.0.0.1/secret",
      fetchImpl: mockFetch,
      indexVectors: false
    });
    expect(bad.detected).toBe(true);
    expect(bad.writtenId).toBeNull();
    expect(bad.receipt).toMatch(/could not fetch it safely|public https/i);
    expect(listLearnedContext(USER).length).toBe(0);
  });

  it("ordinary chat is a no-op", async () => {
    const r = await captureCoachLearning({
      userId: USER,
      message: "AAPL price please",
      indexVectors: false
    });
    expect(r.detected).toBe(false);
    expect(r.receipt).toBeNull();
    expect(listLearnedContext(USER).length).toBe(0);
  });
});
