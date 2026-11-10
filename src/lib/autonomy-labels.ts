/**
 * Human Autopilot vs Running vocabulary (owner 2026-08-13).
 *
 * Autopilot = the app is making trades (strategyAuthority === "decide").
 * Running / Active = autonomy is on (systemState === "active") but still ask-first.
 * Do not call ask-first Autopilot.
 */

export type AutonomyAuthorityWord = "Autopilot" | "Ask-first";

export function autonomyAuthorityWord(authority: string | null | undefined): AutonomyAuthorityWord {
  return authority === "decide" ? "Autopilot" : "Ask-first";
}

/** Chip / ops value for one account.  Autopilot only when both armed and auto-deciding. */
export function autonomyStatusLabel(systemState: string | null | undefined, authority: string | null | undefined): string {
  if (systemState === "close_only") return "Exit-only";
  if (systemState === "liquidating") return "Winding down";
  if (systemState !== "active") return "Stopped";
  return authority === "decide" ? "Autopilot" : "Running";
}
