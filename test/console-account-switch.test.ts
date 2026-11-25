import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { switchAccountGuarded } from "../app/console/lib/account-switch";

/** W16 / OD-11 guard test: the account switch must rescope the console in
 *  place (activate, then refresh) — never through a full page reload, and the
 *  refresh must not run when the activation itself failed. */

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("guarded account switch (W16)", () => {
  it("activates the account first, then refreshes the snapshot, in order", async () => {
    const order: string[] = [];
    const activate = vi.fn(async (id: string) => {
      order.push(`activate:${id}`);
      return { ok: true } as const;
    });
    const refresh = vi.fn(async () => {
      order.push("refresh");
    });

    await switchAccountGuarded("acct-b", { activate, refresh });

    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith("acct-b");
    expect(refresh).toHaveBeenCalledOnce();
    expect(order).toEqual(["activate:acct-b", "refresh"]);
  });

  it("skips the refresh entirely when the activation fails", async () => {
    const activate = vi.fn(async () => {
      throw new Error("scope refused");
    });
    const refresh = vi.fn(async () => undefined);

    await expect(switchAccountGuarded("acct-b", { activate, refresh })).rejects.toThrow("scope refused");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("propagates a refresh failure after a landed activation so callers can surface it", async () => {
    const activate = vi.fn(async () => ({ ok: true }) as const);
    const refresh = vi.fn(async () => {
      throw new Error("snapshot fetch failed");
    });

    // Kody 68C716: the scope change has landed on the server, so a swallowed refresh
    // would leave Account A UI interactive against Account B — the failure must escape.
    await expect(switchAccountGuarded("acct-b", { activate, refresh })).rejects.toThrow("snapshot fetch failed");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the switch path free of any window.location escape hatch", () => {
    const hook = read("app/console/lib/use-account-switch.ts");
    const steps = read("app/console/lib/account-switch.ts");
    const chrome = read("app/console/components/chrome.tsx");
    const brokers = read("app/console/settings/brokers.tsx");

    for (const [name, source] of [
      ["hook", hook],
      ["steps", steps]
    ] as const) {
      expect(source, `${name} references window.location`).not.toMatch(/window\.location/);
      expect(source, `${name} references location.reload`).not.toMatch(/location\.reload/);
    }
    // The two call sites the W16 change rewired — a reintroduced reload here
    // would silently restore the pre-W16 behavior.
    expect(chrome, "chrome.tsx still reloads on account switch").not.toMatch(/location\.reload/);
    expect(brokers, "brokers.tsx still reloads on account switch").not.toMatch(/location\.reload/);
  });
});