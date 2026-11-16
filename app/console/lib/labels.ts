/** Plain-English label maps for console surfaces — the decided vocabulary from
 *  the UI-label sweep, applied verbatim. Centralizes what used to be scattered
 *  ad-hoc Title-Case / raw-enum renders so the same underlying value reads the
 *  same way everywhere. Every lookup falls back to a defensive Title-Case
 *  de-underscore (`plainLabel`) so a raw snake_case/kebab-case string never
 *  reaches the user, even for a value this map doesn't know about yet.
 *
 *  Feed/notification labels live in src/lib/dashboard-ui.ts (shared with the
 *  server-side feed builder) and are re-exported here so console call sites
 *  have ONE import path for every display label. */

import type { SocraticDecisionStatus, SocraticEvidenceItem, SocraticFrameworkProposalStatus, StrategyAuthority } from "@/lib/types";
import { feedStatusLabel } from "@/lib/dashboard-ui";

export { feedStatusLabel, notificationTypeLabel, notificationStatusLabel } from "@/lib/dashboard-ui";

/** Defensive Title-Case de-underscore/de-hyphenate. The last-resort fallback
 *  for any enum value that reaches the UI without an explicit label below —
 *  never a raw snake_case/kebab-case string in front of the user. */
export function plainLabel(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Trade-thesis-tag display. Same defensive Title-Case treatment as
 *  `plainLabel`, named separately so call sites read intent ("this is a
 *  thesis tag") instead of a generic string formatter. */
export function thesisTagLabel(raw?: string | null): string {
  return plainLabel(raw);
}

// ── Socratic evidence kinds ──────────────────────────────────────────────────

const EVIDENCE_KIND_LABELS: Record<SocraticEvidenceItem["kind"], string> = {
  market_scan: "Market scan",
  candidate: "Candidate",
  rag: "Retrieved evidence",
  red_team: "Red team",
  policy: "Policy gate",
  outcome: "Outcome",
  learning: "Learning",
  coaching: "Coaching",
  framework: "Framework",
  override: "Owner override",
  safety: "Safety"
};

export function evidenceKindLabel(kind?: string | null): string {
  if (!kind) return "";
  return EVIDENCE_KIND_LABELS[kind as SocraticEvidenceItem["kind"]] ?? plainLabel(kind);
}

// ── Socratic decision status ─────────────────────────────────────────────────

const DECISION_STATUS_LABELS: Record<SocraticDecisionStatus, string> = {
  planned: "Planned",
  proposed: "Proposed",
  placing: "Placement pending",
  placed: "Placed",
  filled: "Filled",
  blocked: "Blocked",
  rejected: "Rejected",
  rejected_by_broker: "Rejected by broker",
  not_placed: "Not placed",
  expired: "Expired",
  withdrawn: "Withdrawn",
  error: "Failed",
  observed: "Observed (no action)"
};

/** Decision-case status. `DecisionRowData.status` on the home page is a mixed
 *  bag — sometimes a persisted `SocraticDecisionStatus`, sometimes a raw
 *  proposal-review status string ("approved", "pending", ...) — so unknown
 *  values fall back through the feed-status vocabulary before the generic
 *  Title-Case fallback. */
export function decisionStatusLabel(status?: string | null): string {
  if (!status) return "";
  return DECISION_STATUS_LABELS[status as SocraticDecisionStatus] ?? feedStatusLabel(status);
}

// ── Framework proposals ──────────────────────────────────────────────────────

const FRAMEWORK_STATUS_LABELS: Record<SocraticFrameworkProposalStatus, string> = {
  pending: "Pending review",
  accepted: "Accepted",
  rejected: "Rejected",
  applied: "Applied"
};

export function frameworkStatusLabel(status?: string | null): string {
  if (!status) return "";
  return FRAMEWORK_STATUS_LABELS[status as SocraticFrameworkProposalStatus] ?? plainLabel(status);
}

/** Subsystem and priority are already short, undecorated words — Title Case
 *  is the full "decided" treatment, no synonym map needed. */
export function frameworkSubsystemLabel(raw?: string | null): string {
  return plainLabel(raw);
}

export function frameworkPriorityLabel(raw?: string | null): string {
  return plainLabel(raw);
}

// ── Strategy authority ───────────────────────────────────────────────────────

// These match the run-state vocabulary the rest of the app uses for the same two
// authority modes ("Ask-first"/"Autopilot" — see derive.ts authorityWord). The
// trace header renders this chip right next to the decision-STATUS chip, so the
// old "Propose"/"Decide" labels collided with the status word "Proposed" and read
// like a typo. "Ask-first"/"Autopilot" are different concepts, worded differently.
const AUTHORITY_LABELS: Record<StrategyAuthority, { label: string; title: string }> = {
  propose: { label: "Ask-first", title: "Proposals wait for your approval" },
  decide: { label: "Autopilot", title: "The agent may act autonomously within policy" }
};

export function authorityLabel(authority?: string | null): { label: string; title: string } {
  if (authority && authority in AUTHORITY_LABELS) return AUTHORITY_LABELS[authority as StrategyAuthority];
  return { label: plainLabel(authority ?? undefined), title: "" };
}

// ── Login provider (Auth.js provider ids: "google", "github", "apple") ──────
// plainLabel's defensive Title-Case would render "github" as "Github" — wrong,
// GitHub's brand casing has an inner capital. Explicit map for the providers
// this app actually wires up (src/lib/auth/auth.ts); falls back to plainLabel
// for anything unrecognized so a raw provider id never reaches the user.
const LOGIN_PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  apple: "Apple"
};

export function loginProviderLabel(raw?: string | null): string {
  if (!raw) return "";
  return LOGIN_PROVIDER_LABELS[raw.toLowerCase()] ?? plainLabel(raw);
}

// ── Account capabilities sheet (Connected / Disabled / Whole Shares / …) ────
// These chips sit next to Title Case row labels.  Connected / Disabled /
// Enabled already take a capital first letter, so the rest of the values
// follow the same Title Case (not sentence case).

export function accountFractionalSharesLabel(fractional: boolean | undefined): string {
  return fractional ? "Enabled" : "Whole Shares";
}

export function accountSessionHoursLabel(caps: {
  overnightHours?: boolean;
  extendedHours?: boolean;
} | null | undefined): string {
  if (caps?.overnightHours) return "Regular + Extended + Overnight";
  if (caps?.extendedHours) return "Regular + Extended";
  return "Regular Only";
}

export function accountOptionsTradingLabel(caps: {
  optionsOrders?: boolean;
  optionsTrading?: boolean;
  optionsLevel?: number | string | null;
} | null | undefined): string {
  const level = caps?.optionsLevel ?? "?";
  if (caps?.optionsOrders) return `Orders · Level ${level}`;
  if (caps?.optionsTrading) return `Positions Only · Level ${level}`;
  return "Disabled";
}
