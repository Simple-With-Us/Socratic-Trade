import { describe, expect, it } from "vitest";
import { proxyProbePort } from "../src/lib/proxy-fetch";

describe("proxyProbePort", () => {
  it("keeps an explicit non-default port", () => {
    expect(proxyProbePort(new URL("http://proxy.example:8888"))).toBe(8888);
  });

  it("defaults an https URL with no port to 443", () => {
    expect(proxyProbePort(new URL("https://proxy.example"))).toBe(443);
  });

  it("defaults an http URL with no port to 80", () => {
    expect(proxyProbePort(new URL("http://proxy.example"))).toBe(80);
  });

  it("treats the elided https default port as 443", () => {
    // URL.port is "" for https://host:443, same as a missing port.
    expect(new URL("https://proxy.example:443").port).toBe("");
    expect(proxyProbePort(new URL("https://proxy.example:443"))).toBe(443);
  });

  it("treats the elided http default port as 80", () => {
    expect(new URL("http://proxy.example:80").port).toBe("");
    expect(proxyProbePort(new URL("http://proxy.example:80"))).toBe(80);
  });
});
