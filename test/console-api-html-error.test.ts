/**
 * app/console/lib/api.ts — FIX 2 (owner-reported Cloudflare 524 bug).
 *
 * Before this fix, `messageFrom()` returned ANY non-empty string response body verbatim as the
 * error message — so a Cloudflare 524 edge-timeout page (raw HTML) landed straight in the "Run
 * once can't go ahead" sheet. The shared response-error builder (`buildResponseError`, used by
 * both `request<T>` and `fetchDashboard`) now detects an HTML error body — by content-type OR by
 * sniffing the body's leading bytes, since an edge proxy's error page can arrive with a missing
 * or misleading content-type — and replaces it with a clean, status-aware message instead of ever
 * rendering the page's markup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveProposal, ConsoleApiError, fetchDashboard, runOnce } from "../app/console/lib/api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CLOUDFLARE_524_BODY =
  "<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>cloudflare edge timeout</body></html>";

function htmlResponse(status: number, body: string, withContentType = true): Response {
  return new Response(body, {
    status,
    headers: withContentType ? { "content-type": "text/html; charset=UTF-8" } : {}
  });
}

describe("console api client — HTML error body mapping (shared response-error builder)", () => {
  it("maps a raw Cloudflare 524 HTML page to a clean, status-aware message via runOnce()", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(524, CLOUDFLARE_524_BODY)));
    try {
      await runOnce();
      throw new Error("expected runOnce() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsoleApiError);
      const apiErr = err as ConsoleApiError;
      expect(apiErr.status).toBe(524);
      expect(apiErr.message).not.toContain("<html");
      expect(apiErr.message).not.toContain("<!DOCTYPE");
      expect(apiErr.message).not.toContain("A timeout occurred");
      expect(apiErr.message.toLowerCase()).toContain("524");
      expect(apiErr.message.toLowerCase()).toContain("edge");
      expect(apiErr.message.toLowerCase()).toContain("activity");
    }
  });

  it("sniffs the body's leading bytes when content-type is missing/misleading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse(502, "<html><head><title>502 Bad Gateway</title></head><body>bad gateway</body></html>", false))
    );

    try {
      await runOnce();
      throw new Error("expected runOnce() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsoleApiError);
      const apiErr = err as ConsoleApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.message).not.toContain("<html");
      expect(apiErr.message).not.toContain("Bad Gateway");
    }
  });

  it("still surfaces a real JSON error message untouched (regression: not everything becomes a generic edge message)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ summary: "A strategy run is already in progress." }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      )
    );

    await expect(runOnce()).rejects.toMatchObject({
      message: "A strategy run is already in progress.",
      status: 400
    });
  });

  it("applies the same HTML-body mapping to fetchDashboard (shared helper — every dialog benefits)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(524, CLOUDFLARE_524_BODY)));

    try {
      await fetchDashboard();
      throw new Error("expected fetchDashboard() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsoleApiError);
      const apiErr = err as ConsoleApiError;
      expect(apiErr.status).toBe(524);
      expect(apiErr.message).not.toContain("<html");
      expect(apiErr.message.toLowerCase()).toContain("524");
    }
  });

  it("retries a side-effect-free Busy approval result until the strategy lock clears", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "busy",
            outcome: "busy",
            reasons: ["A strategy run is in progress."]
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "placed", orderId: "order-1" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = approveProposal("proposal-1");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({ status: "placed", orderId: "order-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
