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
  | "settings/llm-budget"
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
  // Hash on the destination page (no '#'). Palette deep-links via
  // hrefForSettingsField — keep these in sync with the live section ids
  // (#data-sources, #confirmation, #autonomy, …).
  anchor?: string;
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
    help: "Propose = you approve each trade.  Decide = the AI trades within these limits.",
    anchor: "autonomy"
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
    id: "guardrails.accuracyBreaker",
    label: "Consecutive-loss breaker",
    synonyms: ["accuracy breaker", "losing streak", "consecutive losses", "hit rate", "wrong calls", "nofx"],
    scope: "account",
    destination: "guardrails",
    legacySection: "risk",
    backingField: "riskRules.accuracyBreakerConsecutiveLosses",
    disclosure: "advanced",
    help: "Flags the account after this many matured losses in a row — advisory by default; the agent decides."
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
    id: "guardrails.volTargeting",
    label: "Volatility-target sizing",
    synonyms: ["volatile", "wild names", "vol target", "size taper", "volatility taper", "position sizing volatility"],
    scope: "account",
    destination: "guardrails",
    legacySection: "tuning",
    backingField: "tuning.volTargeting",
    disclosure: "advanced",
    help: "Tapers opening order size down when a name's realized volatility exceeds your target."
  },
  {
    id: "guardrails.heatBudget",
    label: "Portfolio heat budget",
    synonyms: ["heat", "risk budget", "portfolio heat", "size taper", "distance to stop", "total risk"],
    scope: "account",
    destination: "guardrails",
    legacySection: "tuning",
    backingField: "tuning.portfolioHeatBudgetPct",
    disclosure: "advanced",
    help: "Caps the book's total distance-to-stop dollar risk; openings taper to fit what's left."
  },
  {
    id: "guardrails.riskReceipts",
    label: "Risk receipts",
    synonyms: ["risk receipt", "correlation receipt", "stress scenario", "pre-trade stress"],
    scope: "account",
    destination: "guardrails",
    legacySection: "tuning",
    backingField: "tuning.riskReceipts",
    disclosure: "advanced",
    help: "Inform-only correlation + stress notes appended to every opening proposal."
  },
  {
    id: "guardrails.eventTriggers",
    label: "Event-triggered runs",
    synonyms: ["event trigger", "signal", "regime flip run", "trigger engine", "event driven", "8-k trigger", "material event"],
    scope: "account",
    destination: "guardrails",
    legacySection: "operate",
    backingField: "triggerSettings.enabled",
    disclosure: "advanced",
    help: "Let material events (filings, regime flips, signals) fire a run instead of waiting for the interval."
  },
  {
    id: "guardrails.triggerFallbackInterval",
    label: "Event-mode fallback interval",
    synonyms: ["fallback interval", "event mode fallback", "cadence fallback", "safety floor", "trigger mode"],
    scope: "account",
    destination: "guardrails",
    legacySection: "operate",
    backingField: "triggerSettings.fallbackIntervalMinutes",
    disclosure: "advanced",
    help: "Event-only mode: still run the fixed cadence at least this often so a quiet tape can't strand the account."
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
    help: "For taxable accounts, blocks rebuying a stock within 30 days of selling it at a loss.  IRA replacement buys use their own account setting.",
    anchor: "tax"
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
    help: "Let the rebuy proceed with the forfeited tax cost priced into the rationale/receipt (auto — default), route it to you for approval at that price (ask), or block a wash-sale rebuy outright (a stricter opt-in).  IRA rebuys are governed by the separate IRA wash-sale setting.",
    anchor: "tax"
  },
  {
    id: "guardrails.iraWashSaleHandling",
    label: "IRA taxable-loss rebuys",
    synonyms: [
      "ira wash sale",
      "ignore wash sale",
      "auto wash sale",
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
    help: "Ignore (default) does not constrain this IRA.  Auto lets Green weigh the priced forfeited deduction, then proceeds.  Block refuses.  Minimum loss is optional (blank = every loss).",
    anchor: "tax"
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
    disclosure: "advanced",
    anchor: "scoring"
  },
  {
    id: "strategy.model",
    label: "Green Team model",
    synonyms: ["llm model", "model", "green team", "reasoning effort"],
    scope: "account",
    destination: "strategy",
    legacySection: "strategy",
    backingField: "llmModel",
    disclosure: "advanced",
    anchor: "models"
  },
  // User-scope Settings tree (off-rail)
  {
    id: "settings.deleteAccount",
    label: "Delete my account",
    synonyms: ["account", "security", "sign in", "sessions", "delete"],
    scope: "user",
    destination: "settings/account-security",
    backingField: "account",
    disclosure: "advanced",
    anchor: "danger"
  },
  {
    id: "settings.brokerConnections",
    label: "Broker connections",
    synonyms: ["connections", "broker", "alpaca", "robinhood", "tradier", "test paper live"],
    scope: "user",
    destination: "settings/connections",
    legacySection: "connections",
    backingField: "connectedAccounts",
    disclosure: "essential",
    anchor: "brokers"
  },
  {
    id: "settings.apiKeys",
    label: "Keys & Models",
    synonyms: ["api key", "openai", "xai", "keys", "models", "mcp tools"],
    scope: "user",
    destination: "settings/keys-models",
    legacySection: "connections",
    backingField: "apiKeys",
    disclosure: "essential",
    anchor: "api-keys"
  },
  {
    id: "settings.alertWebhook",
    label: "Alerts webhook",
    synonyms: ["notifications", "alert delivery", "webhook", "email", "sms", "push"],
    scope: "user",
    destination: "settings/alert-delivery",
    legacySection: "notifications",
    backingField: "notificationSettings.webhookUrl",
    disclosure: "advanced",
    anchor: "delivery"
  },
  {
    id: "settings.dataPool",
    label: "Shared market-data pool",
    synonyms: ["data pool", "consent", "sharing", "market data pool", "research corpus"],
    scope: "user",
    destination: "settings/data-privacy",
    legacySection: "data",
    backingField: "dataPoolConsent",
    disclosure: "advanced",
    help: "Required.  General market data is pooled; personal account data is not.",
    anchor: "sharing"
  },
  {
    id: "settings.legalNotice",
    label: "Legal notice",
    synonyms: ["terms", "privacy", "disclaimer", "not investment advice"],
    scope: "user",
    destination: "settings/data-privacy",
    legacySection: "data",
    backingField: "legalNoticeConsent",
    disclosure: "advanced",
    help: "Terms and privacy you accepted.  You will be asked again only if they change.",
    anchor: "legal"
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
    help: "How many candidates each scan considers.  Applies to all your accounts.",
    anchor: "scan-shape"
  },
  {
    id: "settings.llmDailyTokenBudget",
    label: "Daily AI token cap",
    synonyms: ["llm budget", "AI budget", "token budget", "daily token ceiling", "TRIGGER_LLM_DAILY_TOKEN_BUDGET"],
    scope: "user",
    destination: "settings/llm-budget",
    backingField: "llm_daily_budget.tokenBudget",
    disclosure: "essential",
    help: "Daily token limit for model and research spend.  When set, spend pauses for the rest of the day.",
    anchor: "llm-budget"
  },
  {
    id: "settings.llmDailyCostBudget",
    label: "Daily AI cost cap",
    synonyms: ["llm cost cap", "AI cost cap", "daily usd budget", "cost budget", "TRIGGER_LLM_DAILY_COST_BUDGET_USD"],
    scope: "user",
    destination: "settings/llm-budget",
    backingField: "llm_daily_budget.costBudgetUsd",
    disclosure: "essential",
    help: "Daily dollar limit for model and research spend.  When set, spend pauses for the rest of the day.",
    anchor: "llm-budget"
  },
  {
    id: "settings.theme",
    label: "Theme",
    synonyms: ["display", "appearance", "dark mode", "density"],
    scope: "user",
    destination: "settings/appearance",
    legacySection: "display",
    backingField: "theme",
    disclosure: "essential",
    anchor: "appearance"
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

/** Console path for a catalog destination (no hash). Exhaustive so a new
 *  SettingsDestination fails the build until it has a real page. */
export function pathForSettingsDestination(destination: SettingsDestination): string {
  switch (destination) {
    case "strategy":
      return "/console/strategy";
    case "guardrails":
      return "/console/guardrails";
    case "settings/account-security":
      return "/console/settings";
    case "settings/connections":
      return "/console/connections";
    case "settings/keys-models":
      return "/console/connections";
    case "settings/alert-delivery":
      return "/console/settings";
    case "settings/data-privacy":
      return "/console/settings";
    case "settings/llm-budget":
      return "/console/settings";
    case "settings/presets":
      return "/console/strategy";
    case "settings/appearance":
      return "/console/settings";
    case "settings/admin":
      return "/console/settings";
    default: {
      const _exhaustive: never = destination;
      return _exhaustive;
    }
  }
}

/** Short location label shown as the palette hint. */
export function settingsDestinationLabel(destination: SettingsDestination): string {
  switch (destination) {
    case "strategy":
      return "Strategy";
    case "guardrails":
      return "Guardrails";
    case "settings/account-security":
      return "Settings · Account";
    case "settings/connections":
      return "Connections";
    case "settings/keys-models":
      return "Connections · Keys";
    case "settings/alert-delivery":
      return "Settings · Delivery";
    case "settings/data-privacy":
      return "Settings · Data sources";
    case "settings/llm-budget":
      return "Settings · AI budget";
    case "settings/presets":
      return "Strategy · Presets";
    case "settings/appearance":
      return "Settings · Appearance";
    case "settings/admin":
      return "Settings · Admin";
    default: {
      const _exhaustive: never = destination;
      return _exhaustive;
    }
  }
}

/** Deep-link for a catalog field: destination path + optional live section hash. */
export function hrefForSettingsField(field: SettingsFieldDef): string {
  const path = pathForSettingsDestination(field.destination);
  return field.anchor ? `${path}#${field.anchor}` : path;
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
  { oldName: "Safety", newHome: "Guardrails → Risk", whatChanged: "Renamed.  Stops, take-profit, and trailing live here; the five most-used surface as Essentials." },
  { oldName: "Tuning", newHome: "Results → Tuning (+ Guardrails → Learning params)", whatChanged: "The AI's proposed changes are reviewed in Results; the learning knobs live in Guardrails." },
  { oldName: "Tax (tab / section)", newHome: "Results → Tax (+ Guardrails → Tax rules)", whatChanged: "Split by intent: realized tax outcomes vs the decision-time tax rules." },
  { oldName: "Review (destination)", newHome: "Results", whatChanged: "Renamed.  “Review” is now a verb for approving and tuning, not a place." },
  { oldName: "Notifications (feed tab)", newHome: "Results → Alert history", whatChanged: "The alerts log moved under Results." },
  { oldName: "Notifications (Settings section)", newHome: "Settings → Alert delivery", whatChanged: "Renamed.  This is delivery rules only (channels/routing)." },
  { oldName: "Notifications (the dropdown)", newHome: "🔔 Alerts", whatChanged: "The live stream is now called Alerts." },
  { oldName: "Display", newHome: "Settings → Appearance", whatChanged: "Renamed.  Theme, fonts, and ticker-logo display live here." },
  { oldName: "Data", newHome: "Settings → Data & Privacy", whatChanged: "Renamed.  Houses web-source toggles and the two scan-breadth knobs (all accounts)." },
  { oldName: "Halt & Flatten", newHome: "STOP (+ a separate Flatten)", whatChanged: "STOP halts new activity in one click and never sells.  Selling is a separate, deliberate action." },
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

/** Palette-ready hits: same ranking as searchSettings, plus the live href. */
export interface SettingsPaletteHit {
  id: string;
  label: string;
  hint: string;
  href: string;
  help?: string;
}

export function settingsPaletteHits(query: string): SettingsPaletteHit[] {
  return searchSettings(query).map((field) => ({
    id: field.id,
    label: field.label,
    hint: settingsDestinationLabel(field.destination),
    href: hrefForSettingsField(field),
    help: field.help
  }));
}
