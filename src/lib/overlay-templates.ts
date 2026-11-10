import type { OverlayRegimeTag } from "./overlay-router";

export interface OverlayStarterTemplate {
  name: string;
  marketRegimes: OverlayRegimeTag[];
  instructions: string;
  priority: number;
}

export const OVERLAY_STARTER_TEMPLATES: OverlayStarterTemplate[] = [
  {
    name: "Earnings Season",
    marketRegimes: ["any"],
    priority: 20,
    instructions:
      "When a candidate reports earnings within five sessions, prefer waiting for the print unless the existing thesis already prices a gap.  Size new entries smaller than usual.  Do not treat a pre-print run as confirmation."
  },
  {
    name: "Choppy Tape",
    marketRegimes: ["neutral"],
    priority: 30,
    instructions:
      "In a neutral or range-bound regime, prefer pullbacks toward support over breakouts.  Fade extended names unless volume confirms.  Favor mean-reversion setups and tighter invalidation."
  },
  {
    name: "Risk-Off Posture",
    marketRegimes: ["crisis", "risk-off", "cautious-inverted"],
    priority: 10,
    instructions:
      "In risk-off, crisis, or inverted-curve regimes, favor quality balance sheets and cut size.  Demand a clearer catalyst before adding risk.  Shorts may be more useful than chasing dips in cyclicals."
  },
  {
    name: "Trend Continuation",
    marketRegimes: ["risk-on"],
    priority: 40,
    instructions:
      "In a risk-on regime, let confirmed leaders work and avoid fading strength without a thesis break.  Add on constructive pullbacks rather than all-in at highs.  Still size from conviction, not from the cap."
  }
];
