import { describe, expect, it } from "vitest";
import { ALPACA_BROKER_IO_DEADLINE_MS } from "../src/lib/inflight-deadline";
import { buildAlpacaV5ClientOptions, createLegacyAlpacaRestClient } from "../src/lib/alpaca-sdk-legacy-client";
import type { LegacyAlpacaConstructorOptions } from "../src/lib/alpaca-sdk-legacy-client";

// The v5 Alpaca SDK uses fetch (not axios), so a half-open broker socket can still hang a
// request indefinitely unless the client is constructed with a timeout.  src/lib/alpaca.ts
// bounds every broker call with withDeadline/trackHealth AND the legacy client passes the
// same broker I/O deadline as the v5 client's per-request `timeoutMs`.  This pins that the
// deadline is actually wired into the client options the SDK sees.
describe("Alpaca SDK client timeout", () => {
  it("passes the broker I/O deadline as the v5 client's per-request timeout", () => {
    const opts = buildAlpacaV5ClientOptions({ paper: true, keyId: "key", secretKey: "secret" });
    expect(opts.timeoutMs).toBe(ALPACA_BROKER_IO_DEADLINE_MS);
    expect(ALPACA_BROKER_IO_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("does not import the node 'module' builtin (unresolvable in the edge instrumentation bundle)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Strip comments first: alpaca.ts explains this very pitfall in a comment that names createRequire.
    const code = readFileSync(join(process.cwd(), "src/lib/alpaca.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["'](?:node:)?module["']/);
    expect(code).not.toMatch(/createRequire\s*\(/);
  });

  it("keeps the last print and its time and drops a trade size", async () => {
    const fake = {
      marketData: {
        stocks: {
          stockLatestTrades: async () => ({
            trades: {
              NVDA: { p: 505, s: 100, t: "2026-08-15T14:00:00.000Z" },
              BAD: { p: "nope", s: 4 }
            }
          })
        }
      }
    };
    const opts: LegacyAlpacaConstructorOptions = { paper: true };
    const client = createLegacyAlpacaRestClient(fake as never, opts);
    const trades = await client.getLatestTrades?.(["NVDA", "BAD"]);
    expect(trades?.NVDA).toEqual({ p: 505, t: "2026-08-15T14:00:00.000Z" });
    expect(trades?.NVDA).not.toHaveProperty("s");
    expect(trades?.BAD).toBeUndefined();
  });
});

// Kody review on PR #5005: the `stockLatestQuotes` response is UNTRUSTED vendor
// data.  It must be validated before `resp.quotes` is used, and the schema
// must stay NON-STRICT so vendor fields we do not model are preserved.
describe("Alpaca legacy client — latest quotes validation", () => {
  const opts: LegacyAlpacaConstructorOptions = { paper: true };

  const clientWithQuotes = (quotes: unknown) =>
    createLegacyAlpacaRestClient(
      {
        marketData: {
          stocks: {
            stockLatestQuotes: async () => ({ quotes })
          }
        }
      } as never,
      opts
    );

  it("keeps the quote fields and PRESERVES vendor fields", async () => {
    const client = clientWithQuotes({
      AAPL: {
        ap: 201,
        bp: 199,
        as: 5,
        bs: 10,
        t: "2026-11-05T19:45:00.000Z",
        x: "D",
        z: "C"
      }
    });
    const quotes = await client.getLatestQuotes(["AAPL"]);
    expect(quotes.AAPL?.ap).toBe(201);
    expect(quotes.AAPL?.bp).toBe(199);
    expect(quotes.AAPL?.t).toBe("2026-11-05T19:45:00.000Z");
    // Unknown-to-us vendor fields survive the validation.
    expect(quotes.AAPL?.x).toBe("D");
    expect(quotes.AAPL?.z).toBe("C");
  });

  it("fails closed on a malformed quotes envelope", async () => {
    const client = clientWithQuotes("not-a-map");
    expect(await client.getLatestQuotes(["AAPL"])).toEqual({});
  });

  it("drops only the malformed row, not the whole batch", async () => {
    const client = clientWithQuotes({
      AAPL: { ap: 201, bp: 199, t: "2026-11-05T19:45:00.000Z" },
      BAD: null
    });
    const quotes = await client.getLatestQuotes(["AAPL", "BAD"]);
    expect(quotes.AAPL?.ap).toBe(201);
    expect(quotes.BAD).toBeUndefined();
  });

  it("returns no quotes when the response has no quotes map", async () => {
    const client = createLegacyAlpacaRestClient(
      { marketData: { stocks: { stockLatestQuotes: async () => ({}) } } } as never,
      opts
    );
    expect(await client.getLatestQuotes(["AAPL"])).toEqual({});
  });
});
