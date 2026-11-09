import { afterEach, describe, expect, it } from "vitest";
import {
  beginConsoleMutation,
  consoleMutationBusyCount,
  endConsoleMutation,
  isConsoleMutationMethod,
  subscribeConsoleMutationBusy
} from "../app/console/lib/mutation-busy";

describe("console mutation busy", () => {
  afterEach(() => {
    while (consoleMutationBusyCount() > 0) endConsoleMutation();
  });

  it("treats POST/PATCH/PUT/DELETE as mutations and GET/HEAD/OPTIONS as reads", () => {
    expect(isConsoleMutationMethod("POST")).toBe(true);
    expect(isConsoleMutationMethod("patch")).toBe(true);
    expect(isConsoleMutationMethod("PUT")).toBe(true);
    expect(isConsoleMutationMethod("DELETE")).toBe(true);
    expect(isConsoleMutationMethod("GET")).toBe(false);
    expect(isConsoleMutationMethod(undefined)).toBe(false);
    expect(isConsoleMutationMethod("HEAD")).toBe(false);
  });

  it("counts overlapping writes and notifies subscribers", () => {
    const seen: number[] = [];
    const stop = subscribeConsoleMutationBusy((n) => seen.push(n));
    beginConsoleMutation();
    beginConsoleMutation();
    endConsoleMutation();
    endConsoleMutation();
    stop();
    expect(seen).toContain(1);
    expect(seen).toContain(2);
    expect(consoleMutationBusyCount()).toBe(0);
  });
});
