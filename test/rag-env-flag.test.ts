/**
 * Tests for the shared fail-closed boolean env-flag parser (R6, 2026-07-01 RAG backlog).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envFlagOn } from "../src/lib/rag/env-flag";

const FLAG = "TEST_ENV_FLAG_ON_PROBE";

describe("envFlagOn", () => {
  it("can read an explicit environment without mutating process state", () => {
    expect(envFlagOn(FLAG, false, { [FLAG]: "yes" })).toBe(true);
    expect(envFlagOn(FLAG, true, { [FLAG]: "off" })).toBe(false);
  });

  beforeEach(() => {
    delete process.env[FLAG];
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("returns the default when unset", () => {
    expect(envFlagOn(FLAG, false)).toBe(false);
    expect(envFlagOn(FLAG, true)).toBe(true);
  });

  it("returns the default when set to an empty string", () => {
    process.env[FLAG] = "";
    expect(envFlagOn(FLAG, false)).toBe(false);
    expect(envFlagOn(FLAG, true)).toBe(true);
  });

  for (const truthy of ["1", "true", "on", "yes", "TRUE", "On", " yes ", "YES"]) {
    it(`accepts "${truthy}" as truthy`, () => {
      process.env[FLAG] = truthy;
      expect(envFlagOn(FLAG, false)).toBe(true);
    });
  }

  for (const falsy of ["0", "false", "off", "no", "garbage", "2"]) {
    it(`fails closed on "${falsy}" (not in the truthy set)`, () => {
      process.env[FLAG] = falsy;
      expect(envFlagOn(FLAG, true)).toBe(false);
    });
  }
});
