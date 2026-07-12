// Pre-flight live-order guard.
//
// A last-line, default-SAFE assertion that runs immediately BEFORE the strategy loop hands an order
// to a real (production-broker) placement call. The per-trade policy gate and the account circuit
// breaker bound risk on the assumption that the code paths themselves are wired correctly; this
// guard defends against the code path *itself* being misconfigured — e.g. a run that has somehow
// reached the live-placement branch while the operator never explicitly enabled live trading.
//
// Design contract:
//   - For a broker *paper* sandbox account (`mode === "broker/paper"`) this is a hard NO-OP:
//     `assertLivePreflight` returns immediately. It can never block a paper run.
//   - On the real-capital path (`mode === "broker/live"`, real money) it REFUSES to proceed unless
//     live trading is EXPLICITLY enabled by the operator via the `ALLOW_LIVE_TRADING=true`
//     environment flag (or the caller passes `allowLive: true`). Absent that opt-in, even a
//     correctly-configured live run is blocked — real capital is never touched by default.
//   - It NEVER places, mutates, or enables a trade. It only throws (blocks) or returns (allows).
//
// This module has no I/O and no DB access so it is trivially unit-testable and safe to import
// anywhere in the execution path.

export interface LivePreflightInput {
  /** Execution mode for this run. Only "broker/live" reaches real capital. */
  mode: "broker/paper" | "broker/live";
  /**
   * Explicit per-call live opt-in. When omitted, the guard falls back to the `ALLOW_LIVE_TRADING`
   * environment flag. Provided mainly so tests don't have to mutate process.env.
   */
  allowLive?: boolean;
  /** Symbol/side for a clearer error message. Optional. */
  symbol?: string;
  side?: string;
}

/** Thrown when the live-order pre-flight assertion fails. Distinct type so callers can catch it. */
export class LivePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivePreflightError";
  }
}

/** Whether the operator has explicitly enabled live trading via env. Default OFF. */
export function liveTradingEnabledByEnv(): boolean {
  return process.env.ALLOW_LIVE_TRADING === "true";
}

/**
 * Assert the invariants that MUST hold before a real (production-broker) order is placed. No-op on
 * the broker/paper path. Throws `LivePreflightError` on the live path when live trading isn't
 * explicitly enabled. Returns normally when it is safe to proceed (or when the path is paper and the
 * guard does not apply).
 */
export function assertLivePreflight(input: LivePreflightInput): void {
  // No-op for any broker paper sandbox — never blocks a paper run.
  if (input.mode !== "broker/live") return;

  const where = input.symbol ? ` for ${input.side ?? "order"} ${input.symbol}` : "";

  // Live trading must be explicitly enabled. Default-off: even a correctly-configured live run is
  // blocked until the operator opts in, so no code path can silently reach real capital.
  const allowLive = input.allowLive ?? liveTradingEnabledByEnv();
  if (!allowLive) {
    throw new LivePreflightError(
      `Live-order pre-flight BLOCKED${where}: real-capital (broker/live) order attempted but live trading is not ` +
      `explicitly enabled. Set ALLOW_LIVE_TRADING=true to permit live order placement. (Paper mode is unaffected.)`
    );
  }
}

/**
 * Non-throwing form of {@link assertLivePreflight}: returns `true` when placing a live order would be
 * blocked, `false` otherwise (incl. paper — never blocks). Use in cancel-THEN-place workflows to
 * skip the CANCEL phase when the subsequent place would be blocked, so the operation fails with no
 * orphaned cancel — WITHOUT blocking standalone risk-reducing cancels.
 */
export function livePreflightBlocks(input: LivePreflightInput): boolean {
  try {
    assertLivePreflight(input);
    return false;
  } catch {
    return true;
  }
}
