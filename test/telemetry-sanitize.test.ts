import { describe, expect, it } from "vitest";
import { sanitizeTelemetryUrl, sanitizeTransactionEvent } from "../src/lib/telemetry-sanitize";

describe("sanitizeTelemetryUrl", () => {
  it("redacts ?apikey= (no separator) -- the shape this app's providers actually use", () => {
    const url = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=AAPL&apikey=SECRETVALUE123";
    const result = sanitizeTelemetryUrl(url);
    expect(result).not.toContain("SECRETVALUE123");
    expect(result).toContain("apikey=[REDACTED]");
  });

  it("still redacts the previously-supported param names (regression safety net)", () => {
    const url = "/console/orders?symbol=AAPL&proposal=abc123&account=acct_1&token=tkn9&secret=shh&password=pw&auth=bearer&api_key=k1&code=xyz&key=k2";
    const result = sanitizeTelemetryUrl(url);
    // Note: values are chosen to avoid colliding with any *surviving* param
    // name in the redacted output (e.g. a "tok" value would false-positive
    // against the intentionally-preserved "token" key name below it --
    // sanitizeTelemetryUrl redacts values, not names).
    for (const value of ["AAPL", "abc123", "acct_1", "tkn9", "shh", "pw", "bearer", "k1", "xyz", "k2"]) {
      expect(result).not.toContain(value);
    }
  });

  it("leaves non-sensitive params and the rest of the URL untouched", () => {
    const url = "/console/orders?page=2&sort=desc&symbol=AAPL#section";
    const result = sanitizeTelemetryUrl(url);
    expect(result).toBe("/console/orders?page=2&sort=desc&symbol=[REDACTED]#section");
  });

  it("is a no-op for URLs without a query string", () => {
    expect(sanitizeTelemetryUrl("/console/orders")).toBe("/console/orders");
  });

  it("handles non-string/empty input safely", () => {
    expect(sanitizeTelemetryUrl("")).toBe("");
    expect(sanitizeTelemetryUrl(undefined as unknown as string)).toBeUndefined();
  });

  it("redacts key=value params in the URL fragment", () => {
    const result = sanitizeTelemetryUrl("/auth/callback?state=ok#access_token=FRAGSECRET&token_type=bearer");
    expect(result).not.toContain("FRAGSECRET");
    expect(result).toContain("#access_token=[REDACTED]");
    expect(sanitizeTelemetryUrl("/cb#access_token=FRAG2")).toBe("/cb#access_token=[REDACTED]");
  });

  it("redacts key-suffixed param names like access_key and accessKey", () => {
    const result = sanitizeTelemetryUrl("/q?access_key=AK1VALUE&accessKey=AK2VALUE&x-key=AK3VALUE&monkey=banana");
    for (const value of ["AK1VALUE", "AK2VALUE", "AK3VALUE"]) expect(result).not.toContain(value);
    expect(result).toContain("monkey=banana");
  });
});

describe("sanitizeTransactionEvent", () => {
  it("redacts request fields and span URLs without dropping spans", () => {
    const spans = Array.from({ length: 30 }, (_, i) => ({
      description: `GET https://api.example.com/q?apikey=SPANSECRET${i}&page=${i}`,
      data: { url: `https://api.example.com/q?token=DATASECRET${i}`, "http.query": `api_key=QSECRET${i}` },
    }));
    const event = {
      request: {
        url: "/console?token=REQSECRET",
        query_string: "token=QSSECRET&page=1",
        headers: { authorization: "Bearer HDRSECRET", accept: "json" },
        cookies: { session: "COOKIESECRET" },
      },
      spans,
    };
    const out = sanitizeTransactionEvent(event);
    const json = JSON.stringify(out);
    for (const secret of ["REQSECRET", "QSSECRET", "HDRSECRET", "COOKIESECRET", "SPANSECRET", "DATASECRET", "QSECRET"]) {
      expect(json).not.toContain(secret);
    }
    expect(out.spans).toHaveLength(30);
    expect(out.spans[29].description).toContain("page=29");
    expect(out.request.query_string).toContain("page=1");
  });
});
