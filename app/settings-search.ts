// Settings field catalog + search index (NAV_V2 PR #3).
//
// One source of truth for "what settings exist, what they're called now, what
// they used to be called, where they live, and how deep they're disclosed." The
// search index is DERIVED from this catalog (never a parallel list) so a field
// added here is searchable without a second edit — the enrichment-drift trap
// CLAUDE.md warns about. The Essentials set and the scope classification also
// read from this catalog, so the rendered Essentials controls and the search
// results can never disagree about a field.
//
// See docs/settings-navigation-redesign/spec/08-delivery-plan-prs-and-tests.md
// (PR #3) and spec/09-copy-deck.md (§5 Guardrails, §7 Settings tree).

import { settingsTierForSection, type SettingsSection } from "./settings-scope";

// Account-scope settings live with the account (Strategy / Guardrails); user-scope
// settings are the off-rail Settings tree. Mirrors settings-scope's tier split.
export type SettingsScope = "account" | "user";

// Two-level disclosure ladder + a search-only tier for expert/env flags (which
// are reachable by search but never surfaced as a third disclosure level).
export type Disclosure = "essential" | "advanced" | "search-only";

// Where a field lives in the NAV_V2 information architecture.
export type SettingsDestination =
  | "strategy"
  | "guardrails"
  | "settings/account-security"
  | "settings/connections"
  | "settings/keys-models"
  | "settings/alert-delivery"
  | "settings/data-privacy"
  | "settings/presets"
  | "settings/appearance"
  | "settings/admin";

export interface SettingsFieldDef {
  id: string;
  label: string; // current (NAV_V2) user-facing label
  synonyms: string[]; // old names + plain-language search terms
  scope: SettingsScope;
  destination: SettingsDestination;
  // The legacy modal section this field currently renders under, when it maps to
  // one. Lets a test cross-check scope against settingsTierForSection (SSOT).
  legacySection?: SettingsSection;
  backingField: string; // policy path, e.g. "maxOrderNotional"
  disclosure: Disclosure;
  help?: string;
}

// The five Guardrails Essentials (copy deck §5.0). Order is the render order.
const GUARDRAILS_ESSENTIAL_DEFS: SettingsFieldDef[] = [
  {
    id: "guardrails.maxOrderSize",
    // Gap #4 resolution: the Essentials "position size" control binds to the
    // per-order cap `maxOrderNotional`. Label says "order", never "position";
    // the true per-symbol holding cap lives in Advanced → Exposure.
    label: "Max order size (per trade)",
    synonyms: ["max position size", "max order", "order cap", "trade size", "notional cap"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "maxOrderNotional",
    disclosure: "essential",
    help: "The most this account can put into one buy order."
  },
  {
    id: "guardrails.dailyLossStop",
    label: "Daily-loss stop",
    synonyms: ["max daily loss", "daily loss limit", "loss stop", "circuit breaker"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "riskRules.maxDailyLossNotional",
    disclosure: "essential",
    help: "If this account loses this much in a day, it stops opening new trades."
  },
  {
    id: "guardrails.stopLoss",
    label: "Stop-loss",
    synonyms: ["stop loss", "stop", "protective stop"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "riskRules.stopLossPct",
    disclosure: "essential",
    help: "Automatically sell a position if it drops this far."
  },
  {
    id: "guardrails.autonomy",
    label: "Autonomy",
    synonyms: ["propose", "decide", "authority", "auto-execute", "auto trade"],
    scope: "account",
    destination: "guardrails",
    legacySection: "operate",
    backingField: "strategyAuthority",
    disclosure: "essential",
    help: "Propose = you approve each trade. Decide = the AI trades within these limits."
  },
  {
    id: "guardrails.extendedHours",
    label: "Extended-hours trading",
    synonyms: ["extended hours", "after hours", "pre market", "premarket"],
    scope: "account",
    destination: "guardrails",
    legacySection: "operate",
    backingField: "permitExtendedHours",
    disclosure: "essential",
    help: "Allow orders outside regular market hours."
  }
];

// A representative slice of Advanced guardrails + account-scope Strategy fields,
// and the user-scope Settings tree. This is not the full field reference (that
// lives in spec/04); it is the searchable catalog the UI renders Essentials from
// and later PRs extend field-by-field.
const OTHER_FIELD_DEFS: SettingsFieldDef[] = [
  // Advanced guardrails
  {
    id: "guardrails.maxDrawdown",
    label: "Max drawdown",
    synonyms: ["drawdown", "max draw down", "peak to trough"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "riskRules.maxDrawdownPct",
    disclosure: "advanced",
    help: "If the account falls this far from its high point, it goes close-only."
  },
  {
    id: "guardrails.perSymbolCap",
    label: "Per-symbol cap",
    synonyms: ["symbol exposure", "most in one symbol", "concentration", "position cap"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "maxSymbolExposurePct",
    disclosure: "advanced",
    help: "Most of this account in any one symbol."
  },
  {
    id: "guardrails.volBrake",
    label: "Volatility brake",
    synonyms: ["vix", "vvix", "skew", "panic brake", "vol panic"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "volPanicBrakeEnabled",
    disclosure: "advanced"
  },
  {
    id: "guardrails.washSaleGuard",
    label: "Taxable-account wash-sale guard",
    synonyms: ["wash sale", "tax lock", "30 day", "cross account"],
    scope: "account",
    destination: "guardrails",
    legacySection: "tax",
    backingField: "taxSettings.washSaleGuard",
    disclosure: "advanced",
    help: "For taxable accounts, blocks rebuying a stock within 30 days of selling it at a loss. IRA replacement buys use their own account setting."
  },
  {
    id: "guardrails.washSaleHandling",
    label: "Taxable-account wash-sale rebuys",
    synonyms: ["wash sale mode", "wash sale ask", "wash sale auto", "rebuy handling", "tax cost approval"],
    scope: "account",
    destination: "guardrails",
    legacySection: "tax",
    backingField: "taxSettings.washSaleHandling",
    disclosure: "advanced",
    help: "Let the rebuy proceed with the forfeited tax cost priced into the rationale/receipt (auto — default), route it to you for approval at that price (ask), or block a wash-sale rebuy outright (a stricter opt-in). IRA rebuys are governed by the separate IRA wash-sale setting."
  },
  {
    id: "guardrails.iraWashSaleHandling",
    label: "IRA taxable-loss rebuys",
    synonyms: [
      "ira wash sale",
      "ignore wash sale",
      "disregard wash sale",
      "roth rebuy",
      "roth wash sale",
      "roth wash sale ignore",
      "roth ira wash sale ignore",
      "rev rul 2008-5",
      "audit risk"
    ],
    scope: "account",
    destination: "guardrails",
    legacySection: "tax",
    backingField: "taxSettings.iraWashSaleHandling",
    disclosure: "advanced",
    help: "Disregard (default) lets an IRA rebuy of a taxable-loss-locked stock proceed, annotated and audited: brokers don't report cross-account IRA wash sales to the IRS, so this is an explicit audit-risk acceptance made on your behalf by default. Block refuses the rebuy instead (a stricter opt-in) — Rev. Rul. 2008-5 permanently destroys the deduction."
  },
  // Strategy (account scope)
  {
    id: "strategy.scoringWeights",
    label: "Scoring weights",
    synonyms: ["factor weights", "signal weights", "tuning"],
    scope: "account",
    destination: "strategy",
    legacySection: "strategy",
    backingField: "scoringWeights",
    disclosure: "advanced"
  },
  {
    id: "strategy.model",
    label: "Green Team model",
    synonyms: ["llm model", "model", "green team", "reasoning effort"],
    scope: "account",
    destination: "strategy",
    legacySection: "strategy",
    backingField: "llmModel",
    disclosure: "advanced"
  },
  // User-scope Settings tree (off-rail)
  {
    id: "settings.deleteAccount",
    label: "Delete my account",
    synonyms: ["account", "security", "sign in", "sessions", "delete"],
    scope: "user",
    destination: "settings/account-security",
    backingField: "account",
    disclosure: "advanced"
  },
  {
    id: "settings.brokerConnections",
    label: "Broker connections",
    synonyms: ["connections", "broker", "alpaca", "robinhood", "test paper live"],
    scope: "user",
    destination: "settings/connections",
    legacySection: "connections",
    backingField: "connectedAccounts",
    disclosure: "essential"
  },
  {
    id: "settings.apiKeys",
    label: "Keys & Models",
    synonyms: ["api key", "openai", "xai", "keys", "models", "mcp tools"],
    scope: "user",
    destination: "settings/keys-models",
    legacySection: "connections",
    backingField: "apiKeys",
    disclosure: "essential"
  },
  {
    id: "settings.alertWebhook",
    label: "Alerts webhook",
    synonyms: ["notifications", "alert delivery", "webhook", "email", "sms", "push"],
    scope: "user",
    destination: "settings/alert-delivery",
    legacySection: "notifications",
    backingField: "notificationSettings.webhookUrl",
    disclosure: "advanced"
  },
  {
    id: "settings.scanBreadthCandidates",
    label: "Scan breadth — candidates per run",
    synonyms: ["market scan", "candidate limit", "scan breadth", "data privacy"],
    scope: "user",
    destination: "settings/data-privacy",
    legacySection: "data",
    backingField: "marketScanCandidateLimit",
    disclosure: "advanced",
    help: "How many candidates each scan considers. Applies to all your accounts."
  },
  {
    id: "settings.theme",
    label: "Theme",
    synonyms: ["display", "appearance", "dark mode", "density"],
    scope: "user",
    destination: "settings/appearance",
    legacySection: "display",
    backingField: "theme",
    disclosure: "essential"
  },
  {
    id: "settings.defaultLandingAccount",
    label: "Default landing account",
    synonyms: ["appearance", "landing", "default account", "startup account"],
    scope: "user",
    destination: "settings/appearance",
    legacySection: "display",
    backingField: "defaultLandingAccount",
    disclosure: "advanced",
    help: "Where you land on load. Live accounts can't be auto-selected, for safety."
  }
];

// The canonical catalog. Search, Essentials, and scope all derive from this.
export const SETTINGS_FIELDS: SettingsFieldDef[] = [
  ...GUARDRAILS_ESSENTIAL_DEFS,
  ...OTHER_FIELD_DEFS
];

// The five Guardrails Essentials, derived (not a hand-kept parallel list).
export const GUARDRAILS_ESSENTIALS: SettingsFieldDef[] = SETTINGS_FIELDS.filter(
  (f) => f.destination === "guardrails" && f.disclosure === "essential"
);

// Scope of a field, cross-checkable against settings-scope's tier function for
// any field that maps to a legacy modal section.
export function scopeOfField(field: SettingsFieldDef): SettingsScope {
  return field.scope;
}

// True when a field's declared scope agrees with the legacy section's tier — a
// guard against a field being tagged the wrong scope.
export function scopeMatchesLegacyTier(field: SettingsFieldDef): boolean {
  if (!field.legacySection) return true; // no legacy section to cross-check
  const tier = settingsTierForSection(field.legacySection); // "account" | "user"
  return tier === field.scope;
}

// ── Legacy section → new home (NAV_V2 PR #4) ──────────────────────────────────
// Where each legacy modal section relocates in the redesign. One structured
// source so the Help glossary table and (later) the openSettings call-site
// rewrites cannot drift. Total over the SettingsSection union.
export const LEGACY_SECTION_RELOCATION: Record<SettingsSection, string> = {
  strategy: "Strategy",
  operate: "Guardrails → Execution / Autonomy (+ Strategy → Signals)",
  risk: "Guardrails → Risk",
  connections: "Settings → Connections (+ Keys & Models)",
  display: "Settings → Appearance",
  tax: "Results → Tax (+ Guardrails → Tax rules)",
  tuning: "Results → Tuning (+ Guardrails → Learning params)",
  notifications: "Settings → Alert delivery",
  data: "Settings → Data & Privacy"
};

export function relocationForSection(section: SettingsSection): string {
  return LEGACY_SECTION_RELOCATION[section];
}

// ── Help "Settings Glossary" old→new mapping (copy deck §11) ───────────────────
// A returning user who knew the old names finds the new home. Rendered under
// Help → Settings Glossary when NAV_V2 is on.
export interface GlossaryEntry {
  oldName: string;
  newHome: string;
  whatChanged: string;
}

export const SETTINGS_GLOSSARY: GlossaryEntry[] = [
  { oldName: "Strategy Profile", newHome: "Preset", whatChanged: "Same thing, clearer name — a reusable, copyable template of strategy settings." },
  { oldName: "Strategy (Settings section)", newHome: "Strategy (destination)", whatChanged: "The read-only mirror is gone; Strategy is one editable home on the top nav." },
  { oldName: "Strategy Studio", newHome: "Strategy (destination)", whatChanged: "The pop-up editor folded inline into the Strategy destination." },
  { oldName: "Operate", newHome: "Guardrails → Execution / Autonomy (+ Strategy → Signals)", whatChanged: "The vague “Operate” section was dissolved: order types/hours/cadence → Guardrails; universe/scan → Strategy." },
  { oldName: "Safety", newHome: "Guardrails → Risk", whatChanged: "Renamed. Stops, take-profit, and trailing live here; the five most-used surface as Essentials." },
  { oldName: "Tuning", newHome: "Results → Tuning (+ Guardrails → Learning params)", whatChanged: "The AI's proposed changes are reviewed in Results; the learning knobs live in Guardrails." },
  { oldName: "Tax (tab / section)", newHome: "Results → Tax (+ Guardrails → Tax rules)", whatChanged: "Split by intent: realized tax outcomes vs the decision-time tax rules." },
  { oldName: "Review (destination)", newHome: "Results", whatChanged: "Renamed. “Review” is now a verb for approving and tuning, not a place." },
  { oldName: "Notifications (feed tab)", newHome: "Results → Alert history", whatChanged: "The alerts log moved under Results." },
  { oldName: "Notifications (Settings section)", newHome: "Settings → Alert delivery", whatChanged: "Renamed. This is delivery rules only (channels/routing)." },
  { oldName: "Notifications (the dropdown)", newHome: "🔔 Alerts", whatChanged: "The live stream is now called Alerts." },
  { oldName: "Display", newHome: "Settings → Appearance", whatChanged: "Renamed. Adds “default landing account” (non-Live only)." },
  { oldName: "Data", newHome: "Settings → Data & Privacy", whatChanged: "Renamed. Houses web-source toggles and the two scan-breadth knobs (all accounts)." },
  { oldName: "Halt & Flatten", newHome: "STOP (+ a separate Flatten)", whatChanged: "STOP halts new activity in one click and never sells. Selling is a separate, deliberate action." },
  { oldName: "Connections", newHome: "Settings → Connections (+ Keys & Models)", whatChanged: "Keys split into their own section; broker links stay in Connections." },
  { oldName: "/admin/* (four pages)", newHome: "Settings → Admin", whatChanged: "The four admin pages consolidated into one role-gated section." },
  { oldName: "/strategy (public page)", newHome: "/how-it-works", whatChanged: "The marketing explainer was renamed; linked from the editor footer and Help." }
];

export const GLOSSARY_RULE_OF_THUMB =
  "Rule of thumb: if a setting changes how a trade is decided or placed, it lives with the account (Strategy or Guardrails). Everything else is in Settings.";

// Search the catalog by label, synonyms, destination/group, scope word, or
// backing field. Case/whitespace-insensitive substring match; results ranked
// with label-prefix hits first, then label hits, then synonym/other hits.
export function searchSettings(query: string): SettingsFieldDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ field: SettingsFieldDef; rank: number }> = [];
  for (const field of SETTINGS_FIELDS) {
    const label = field.label.toLowerCase();
    const haystacks = [
      ...field.synonyms.map((s) => s.toLowerCase()),
      field.destination.toLowerCase(),
      field.scope,
      field.backingField.toLowerCase()
    ];
    let rank = Infinity;
    if (label.startsWith(q)) rank = 0;
    else if (label.includes(q)) rank = 1;
    else if (haystacks.some((h) => h.includes(q))) rank = 2;
    if (rank !== Infinity) scored.push({ field, rank });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.field.label.localeCompare(b.field.label))
    .map((s) => s.field);
}
