import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESIDENTIAL_PROXY_URL,
  formatProxyUrl,
  isProxyLegError,
  isProxyOffSentinel,
  resolveProxyFailureMode,
  resolveResidentialProxyUrl,
  safeProxyHostForLog
} from "../src/lib/proxy-fetch";

describe("formatProxyUrl", () => {
  it("formats host and port with the http default protocol", () => {
    expect(formatProxyUrl({ host: "10.99.0.2", port: 8888 })).toBe("http://10.99.0.2:8888");
  });
  it("embeds credentials url-encoded", () => {
    expect(formatProxyUrl({ host: "proxy.example.com", port: 3128, username: "u@x", password: "p w" })).toBe(
      "http://u%40x:p%20w@proxy.example.com:3128"
    );
  });
  it("returns undefined without a host", () => {
    expect(formatProxyUrl({})).toBeUndefined();
  });
  it("strips a trailing colon from the protocol", () => {
    expect(formatProxyUrl({ host: "h", protocol: "https:" })).toBe("https://h");
  });
});

describe("resolveResidentialProxyUrl", () => {
  it("prefers RESIDENTIAL_PROXY_URL", () => {
    expect(
      resolveResidentialProxyUrl({ RESIDENTIAL_PROXY_URL: "http://a:1", RESIDENTIAL_PROXY_HOST: "b" })
    ).toBe("http://a:1");
  });
  it("builds from host/port/auth parts", () => {
    expect(
      resolveResidentialProxyUrl({
        RESIDENTIAL_PROXY_HOST: "10.99.0.2",
        RESIDENTIAL_PROXY_PORT: 8888,
        RESIDENTIAL_PROXY_USERNAME: "u",
        RESIDENTIAL_PROXY_PASSWORD: "p"
      })
    ).toBe("http://u:p@10.99.0.2:8888");
  });
  it("honors HTTPS_PROXY / HTTP_PROXY as a last env fallback", () => {
    expect(resolveResidentialProxyUrl({ HTTPS_PROXY: "http://legacy:8080" })).toBe("http://legacy:8080");
    expect(resolveResidentialProxyUrl({ HTTP_PROXY: "http://legacy:8080" })).toBe("http://legacy:8080");
  });
  it("falls back to the Mango default when nothing is configured", () => {
    expect(resolveResidentialProxyUrl({})).toBe(DEFAULT_RESIDENTIAL_PROXY_URL);
  });
  it("allowDefault:false distinguishes 'configured' from 'defaulted'", () => {
    expect(resolveResidentialProxyUrl({}, { allowDefault: false })).toBeUndefined();
  });
  it("off-sentinels disable proxying including the default", () => {
    for (const sentinel of ["off", "OFF", " none ", "direct"]) {
      expect(resolveResidentialProxyUrl({ RESIDENTIAL_PROXY_URL: sentinel })).toBeUndefined();
    }
    expect(isProxyOffSentinel("off")).toBe(true);
    expect(isProxyOffSentinel("http://x")).toBe(false);
  });
});

describe("resolveProxyFailureMode", () => {
  it("defaults to fail_soft and honors fail_closed", () => {
    // Plain env literals, not casts to NodeJS.ProcessEnv: these fixtures describe
    // a ResidentialProxyEnv override, and ProcessEnv carries a required NODE_ENV
    // that a fixture has no business asserting.
    expect(resolveProxyFailureMode({})).toBe("fail_soft");
    expect(resolveProxyFailureMode({ RESIDENTIAL_PROXY_FAILURE_MODE: "fail_closed" })).toBe("fail_closed");
  });
  it("accepts a real process.env source without a cast", () => {
    // Pins the weak-type regression: process.env is an index-signature type and
    // must stay assignable to the resolver parameter (src/lib/proxy-fetch.ts).
    expect(["fail_soft", "fail_closed"]).toContain(resolveProxyFailureMode(process.env));
    expect(["fail_soft", "fail_closed"]).toContain(resolveProxyFailureMode());
  });
});

describe("isProxyLegError", () => {
  it("detects proxy-leg socket codes through the undici cause chain", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }) });
    expect(isProxyLegError(err)).toBe(true);
  });
  it("classifies a bare DOMException AbortError as proxy-down (the FRED regression fix)", () => {
    // Regression: a proxied fetch that aborted mid-flight (e.g. residential
    // proxy stalled past the proxy-leg timeout, or the call-site signal
    // fired while still on the proxy leg) was silently never classified as
    // a proxy-leg failure. Without classification, fail_soft never engaged
    // and every FRED series fetch returned undefined with no log line.
    expect(isProxyLegError(new DOMException("aborted", "AbortError"))).toBe(true);
  });
  it("classifies an AbortError nested in a cause chain as proxy-down", () => {
    const err = new TypeError("fetch failed", { cause: new DOMException("aborted", "AbortError") });
    expect(isProxyLegError(err)).toBe(true);
  });
  it("does not classify non-AbortError errors or unrelated errors as proxy-down", () => {
    // A bare Error("aborted") has name "Error", not "AbortError" — it must
    // not be classified. Only DOMException/TimeoutError-style aborts
    // (which carry the abort name as `.name`) qualify.
    expect(isProxyLegError(new Error("aborted"))).toBe(false);
    expect(isProxyLegError(new TypeError("fetch failed", { cause: new Error("boom") }))).toBe(false);
  });
});

describe("safeProxyHostForLog", () => {
  it("never leaks embedded credentials", () => {
    expect(safeProxyHostForLog("http://user:secret@10.99.0.2:8888")).toBe("10.99.0.2:8888");
  });
});
