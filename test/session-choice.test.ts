import { describe, expect, it, vi } from "vitest";
import { createSessionChoiceStore, scanTabChoiceKey } from "../app/console/lib/session-choice";

function setup(key: string | null = "scan:a") {
  const values = new Map<string, string>();
  const storage = { getItem: vi.fn((k: string) => values.get(k) ?? null), setItem: vi.fn((k: string, v: string) => { values.set(k, v); }) };
  const events = new EventTarget();
  const create = (k = key) => createSessionChoiceStore({ key: k, choices: ["scan", "smart"] as const, defaultValue: "scan", storage: () => storage, events });
  return { values, storage, events, create, store: create() };
}

describe("validated account-scoped session choice", () => {
  it("defaults safely and supplies a deterministic server snapshot", () => {
    const { store, values } = setup(); values.set("scan:a", "smart");
    expect(store.getSnapshot()).toBe("smart"); expect(store.getServerSnapshot()).toBe("scan");
  });
  it.each(["", "removed-tab", "SMART", "undefined", "{broken}"])("rejects stored value %j", (value) => {
    const { store, values } = setup(); values.set("scan:a", value); expect(store.getSnapshot()).toBe("scan");
  });
  it("remounts with the saved session choice", () => {
    const { store, create } = setup(); store.set("smart"); expect(create().getSnapshot()).toBe("smart");
  });
  it("does not leak a choice between account keys", () => {
    const { store, create } = setup(); store.set("smart"); expect(create("scan:b").getSnapshot()).toBe("scan");
    expect(create("scan:a").getSnapshot()).toBe("smart");
  });
  it("notifies same-window subscribers and cleans up", () => {
    const { store } = setup(); const notify = vi.fn(); const off = store.subscribe(notify);
    store.set("smart"); expect(notify).toHaveBeenCalledTimes(1); off(); store.set("scan"); expect(notify).toHaveBeenCalledTimes(1);
  });
  it("ignores invalid caller values without writing", () => {
    const { store, storage } = setup(); store.set("bad" as "scan"); expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("keeps a mounted tab usable if storage is blocked or full", () => {
    const { store, storage } = setup(); storage.getItem.mockImplementation(() => { throw Error("blocked"); });
    storage.setItem.mockImplementation(() => { throw Error("full"); });
    expect(store.getSnapshot()).toBe("scan"); store.set("smart"); expect(store.getSnapshot()).toBe("smart");
  });
  it("responds only to relevant storage events", () => {
    const { store, events } = setup(); const notify = vi.fn(); store.subscribe(notify);
    const fire = (key: string | null) => { const event = new Event("storage"); Object.defineProperty(event, "key", { value: key }); events.dispatchEvent(event); };
    fire("scan:b"); expect(notify).not.toHaveBeenCalled(); fire("scan:a"); fire(null); expect(notify).toHaveBeenCalledTimes(2);
  });
  it("does not touch storage before an account scope exists", () => {
    const { store, storage } = setup(null); expect(store.getSnapshot()).toBe("scan"); store.set("smart");
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
  });
});


describe("scan tab storage identity", () => {
  it("uses only the opaque account ID even when a brokerage account number is present", () => {
    const account = { id: "opaque-account-a", accountNumber: "987654321" };
    expect(scanTabChoiceKey(account)).toBe("console:scan:tab:opaque-account-a");
    expect(scanTabChoiceKey(account)).not.toContain(account.accountNumber);
    const changed = { ...account, accountNumber: "another-number" };
    expect(scanTabChoiceKey(changed)).toBe(scanTabChoiceKey(account));
  });
  it("does not persist a legacy or missing account without an opaque ID", () => {
    expect(scanTabChoiceKey(undefined)).toBeNull();
    expect(scanTabChoiceKey({ id: "" })).toBeNull();
  });
});
