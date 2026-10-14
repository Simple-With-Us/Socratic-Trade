import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRetrievalSlot,
  countsTowardRetrievalBackoff,
  noteRetrievalPressureFailure,
  noteRetrievalPressureSuccess,
  resetRetrievalPressureForTests,
  retrievalBackoffRemainingMs,
  retrievalPressureEpoch
} from "../src/lib/rag/retrieval-pressure";

const PRIOR_BACKOFF = process.env.RAG_RETRIEVAL_BACKOFF;
const PRIOR_CONCURRENCY = process.env.RAG_RETRIEVAL_CONCURRENCY;

beforeEach(() => {
  resetRetrievalPressureForTests();
  delete process.env.RAG_RETRIEVAL_BACKOFF;
  delete process.env.RAG_RETRIEVAL_CONCURRENCY;
});

afterEach(() => {
  resetRetrievalPressureForTests();
  if (PRIOR_BACKOFF === undefined) delete process.env.RAG_RETRIEVAL_BACKOFF;
  else process.env.RAG_RETRIEVAL_BACKOFF = PRIOR_BACKOFF;
  if (PRIOR_CONCURRENCY === undefined) delete process.env.RAG_RETRIEVAL_CONCURRENCY;
  else process.env.RAG_RETRIEVAL_CONCURRENCY = PRIOR_CONCURRENCY;
});

describe("retrieval pressure", () => {
  it("queues past the concurrency cap and still runs everyone", async () => {
    process.env.RAG_RETRIEVAL_CONCURRENCY = "2";
    const first = await acquireRetrievalSlot();
    const second = await acquireRetrievalSlot();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    let thirdStarted = false;
    const third = acquireRetrievalSlot().then((slot) => {
      thirdStarted = true;
      return slot;
    });
    await Promise.resolve();
    expect(thirdStarted).toBe(false);
    first!.release();
    const thirdSlot = await third;
    expect(thirdSlot).not.toBeNull();
    second!.release();
    thirdSlot!.release();
  });

  it("does not open backoff in vitest unless the test opts in", async () => {
    noteRetrievalPressureFailure(1_000);
    expect(retrievalBackoffRemainingMs(1_000)).toBe(0);
    const slot = await acquireRetrievalSlot(undefined, 1_000);
    expect(slot).not.toBeNull();
    slot!.release();
  });

  it("returns a null slot during backoff and still runs after a success", async () => {
    process.env.RAG_RETRIEVAL_BACKOFF = "1";
    noteRetrievalPressureFailure(1_000);
    expect(retrievalBackoffRemainingMs(1_500)).toBeGreaterThan(0);
    expect(await acquireRetrievalSlot(undefined, 1_500)).toBeNull();
    noteRetrievalPressureSuccess();
    const slot = await acquireRetrievalSlot(undefined, 1_500);
    expect(slot).not.toBeNull();
    slot!.release();
  });

  it("drops queued callers when a timeout opens backoff", async () => {
    process.env.RAG_RETRIEVAL_BACKOFF = "1";
    process.env.RAG_RETRIEVAL_CONCURRENCY = "1";
    const held = await acquireRetrievalSlot(undefined, 5_000);
    const queued = acquireRetrievalSlot(undefined, 5_000);
    noteRetrievalPressureFailure(5_000);
    expect(await queued).toBeNull();
    held!.release();
    expect(await acquireRetrievalSlot(undefined, 5_000)).toBeNull();
  });

  it("does not let a stale success clear a backoff opened after the slot was taken", () => {
    process.env.RAG_RETRIEVAL_BACKOFF = "1";
    const seen = retrievalPressureEpoch();
    noteRetrievalPressureFailure(1_000);
    expect(retrievalPressureEpoch()).toBe(seen + 1);
    noteRetrievalPressureSuccess(seen);
    expect(retrievalBackoffRemainingMs(1_500)).toBeGreaterThan(0);
    noteRetrievalPressureSuccess(retrievalPressureEpoch());
    expect(retrievalBackoffRemainingMs(1_500)).toBe(0);
  });

  it("treats the strategy retrieval deadline as backoff pressure", () => {
    expect(countsTowardRetrievalBackoff(new Error("strategy RAG retrieval timed out"))).toBe(true);
    expect(countsTowardRetrievalBackoff(new Error("embedding credential is missing"))).toBe(false);
  });
});
