"use client";

/** Tiny cross-component channel for the intro splash -> header logo handoff.
 *  The splash (intro-canvas.tsx) owns the writes; the header chrome (shell.tsx)
 *  subscribes, so the persistent brand logo stays invisible until the intro's
 *  candles have assembled it, and the mobile brand row knows when to reveal
 *  and later slide away.
 *
 *  Module state lives per tab JS context. A fresh page load starts at
 *  "pending" — safe to treat like "playing", because whenever the phase can be
 *  pending/playing the splash overlay's opaque backdrop is covering the page,
 *  so a hidden logo is never wrongly visible. SPA remounts keep the settled
 *  phase, and the server always renders "pending", so hydration matches. */

export type IntroPhase =
  | "pending" // before the splash effect has decided anything
  | "playing" // splash animating; the real logo must stay hidden
  | "landed" // candles assembled the logo (fade starting) — reveal it
  | "done"; // splash gone (or never played) — steady state

const RANK: Record<IntroPhase, number> = { pending: 0, playing: 1, landed: 2, done: 3 };

let phase: IntroPhase = "pending";
const subs = new Set<(p: IntroPhase) => void>();

export function getIntroPhase(): IntroPhase {
  return phase;
}

export function setIntroPhase(p: IntroPhase) {
  // Never regress from a settled phase (e.g. a remounting splash instance
  // re-announcing "playing" after another instance already landed).
  if (RANK[p] < RANK[phase]) return;
  phase = p;
  for (const f of subs) f(p);
}

export function subscribeIntroPhase(f: (p: IntroPhase) => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
