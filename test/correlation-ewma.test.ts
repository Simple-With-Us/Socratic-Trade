import { describe, expect, it } from "vitest";
import { downsideCorrelation, ewmaCorrelation, pearson } from "../src/lib/correlation";

describe("ewmaCorrelation", () => {
  it("matches hand-computed EWMA correlation for identical/negated series (any lambda)", () => {
    const ra = Array.from({ length: 20 }, (_, i) => Math.sin(i * 0.7) / 50);
    const identical = ra.slice();
    const negated = ra.map((x) => -x);
    expect(ewmaCorrelation(ra, identical, 0.5)).toBeCloseTo(1, 6);
    expect(ewmaCorrelation(ra, negated, 0.5)).toBeCloseTo(-1, 6);
  });

  it("is MORE responsive to a recent correlation shift than plain Pearson (lambda=0.5)", () => {
    // First 15 samples: candidate moves OPPOSITE the holding (anti-correlated). Last 5 samples: a
    // recent regime shift — candidate now moves WITH the holding. A short-memory EWMA (lambda=0.5,
    // easy math: weight halves each step back) should swing decisively positive on the recent tail,
    // while the equal-weight Pearson over the whole window stays anti-correlated.
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < 15; i++) {
      const v = Math.sin(i * 0.9) / 40;
      ra.push(v);
      rb.push(-v);
    }
    for (let i = 0; i < 5; i++) {
      const v = Math.cos(i * 0.5) / 40 + 0.001 * i;
      ra.push(v);
      rb.push(v);
    }
    const p = pearson(ra, rb);
    const e = ewmaCorrelation(ra, rb, 0.5);
    expect(p).toBeCloseTo(-0.5509425790588672, 6);
    expect(e).toBeCloseTo(0.8921852425751022, 6);
    expect(e as number).toBeGreaterThan(p as number);
  });

  it("undefined below MIN_CORRELATION_SAMPLES (20)", () => {
    const short = Array.from({ length: 19 }, (_, i) => i * 0.001);
    expect(ewmaCorrelation(short, short, 0.94)).toBeUndefined();
  });

  it("undefined on (near-)zero variance in either series", () => {
    const varying = Array.from({ length: 25 }, (_, i) => Math.sin(i * 0.7) / 50);
    const constant = Array(25).fill(0.01);
    expect(ewmaCorrelation(varying, constant, 0.94)).toBeUndefined();
    expect(ewmaCorrelation(constant, constant, 0.94)).toBeUndefined();
  });

  it("clamps tiny float overshoot into [-1, 1]", () => {
    const ra = Array.from({ length: 20 }, (_, i) => Math.sin(i * 0.7) / 50);
    const rb = ra.slice();
    const r = ewmaCorrelation(ra, rb, 0.94);
    expect(r).toBeLessThanOrEqual(1);
    expect(r).toBeGreaterThanOrEqual(-1);
  });

  it("rejects an out-of-range lambda", () => {
    const ra = Array.from({ length: 25 }, (_, i) => Math.sin(i * 0.7) / 50);
    expect(ewmaCorrelation(ra, ra, 0)).toBeUndefined();
    expect(ewmaCorrelation(ra, ra, 1)).toBeUndefined();
    expect(ewmaCorrelation(ra, ra, -0.1)).toBeUndefined();
  });
});

describe("downsideCorrelation", () => {
  it("conditions only on the HOLDING's down days (rb < 0) and can exceed the full-sample Pearson", () => {
    // 18 "up" days where the candidate looks diversifying (moves opposite the holding), then 12
    // "down" days where the candidate ALSO falls hard with the holding — the real drawdown risk a
    // full-sample average-return correlation would miss. Small deterministic noise keeps it off a
    // perfectly linear 1.0 while remaining hand-verifiable.
    const upNoise = [0.0007, -0.0003, 0.0009, -0.0006, 0.0002, 0.0011, -0.0008, 0.0004, 0.0006, -0.0002, 0.0003, -0.0009, 0.0001, -0.0004, 0.0005, 0.0008, -0.0007, 0.0002];
    const downNoise = [0.0006, -0.0004, 0.0003, 0.0007, -0.0002, 0.0005, -0.0006, 0.0001, 0.0004, -0.0003, 0.0002, -0.0005];
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < 18; i++) {
      const h = 0.01 + 0.001 * i;
      rb.push(h);
      ra.push(-0.008 - 0.0005 * i + upNoise[i]);
    }
    for (let i = 0; i < 12; i++) {
      const h = -0.01 - 0.001 * i;
      rb.push(h);
      ra.push(-0.009 - 0.0009 * i + downNoise[i]);
    }
    const p = pearson(ra, rb);
    const d = downsideCorrelation(ra, rb, 10);
    expect(p).toBeCloseTo(0.19293485648984698, 6);
    expect(d).toBeCloseTo(0.992363186406626, 6);
    expect(d as number).toBeGreaterThan(p as number);
  });

  it("undefined below minSamples down-day pairs", () => {
    // Only 3 down days among 25 samples; default minSamples=10 should reject this.
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < 22; i++) {
      ra.push(0.001 * (i + 1));
      rb.push(0.001 * (i + 1));
    }
    for (let i = 0; i < 3; i++) {
      ra.push(-0.002);
      rb.push(-0.001 * (i + 1));
    }
    expect(downsideCorrelation(ra, rb, 10)).toBeUndefined();
  });

  it("respects a custom minSamples floor", () => {
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < 5; i++) {
      ra.push(-0.01 - 0.001 * i);
      rb.push(-0.01 - 0.0011 * i);
    }
    expect(downsideCorrelation(ra, rb, 10)).toBeUndefined();
    expect(downsideCorrelation(ra, rb, 5)).not.toBeUndefined();
  });

  it("undefined on zero variance among the down-day subset", () => {
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < 15; i++) {
      ra.push(0.01); // constant → zero variance once conditioned
      rb.push(-0.01 - 0.001 * i);
    }
    expect(downsideCorrelation(ra, rb, 10)).toBeUndefined();
  });

  it("perfect correlation on the down-day subset clamps to 1", () => {
    const ra: number[] = [];
    const rb: number[] = [];
    for (let i = 0; i < 15; i++) {
      const h = -0.01 - 0.001 * i;
      rb.push(h);
      ra.push(h * 2); // perfectly linear, positive slope
    }
    expect(downsideCorrelation(ra, rb, 10)).toBeCloseTo(1, 6);
  });
});
