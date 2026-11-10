import { describe, expect, it } from "vitest";
import { sanitizeTelemetryUrl } from "../src/lib/telemetry-sanitize";

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
});
