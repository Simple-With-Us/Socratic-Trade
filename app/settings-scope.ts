// Scope taxonomy for the Settings surface.
//
// Extracted from `dashboard-client.tsx` so the account-vs-user tier split — and
// the "THIS ACCOUNT" / "ALL ACCOUNTS" scope tag derived from it — has a single
// source of truth shared by the dashboard client and its tests. The tier data
// was already coded but invisible; PR #1 surfaces it as a header tag without
// moving a panel or touching a data path.
//
// See docs/settings-navigation-redesign/spec/08-delivery-plan-prs-and-tests.md
// (PR #1) and docs/settings-navigation-redesign/spec/09-copy-deck.md.

export type SettingsSection =
  | "strategy"
  | "operate"
  | "risk"
  | "connections"
  | "display"
  | "tax"
  | "tuning"
  | "notifications"
  | "data";

export type SettingsTier = "user" | "account";

// Sections whose settings bind to the selected account (vs. the user-global
// tier). This is the tier source of truth the scope tag reads from.
export const ACCOUNT_SETTINGS_SECTIONS = new Set<SettingsSection>([
  "strategy",
  "operate",
  "risk",
  "tax",
  "tuning"
]);

export function settingsTierForSection(section: SettingsSection): SettingsTier {
  return ACCOUNT_SETTINGS_SECTIONS.has(section) ? "account" : "user";
}

// Scope tag surfaced on each settings-section header so the tier split is
// legible. Derived from `settingsTierForSection` so the tag copy can never
// drift from the tier logic (one source of truth — the enrichment-drift trap
// CLAUDE.md warns about).
export const SCOPE_TAG_LABEL: Record<SettingsTier, string> = {
  account: "THIS ACCOUNT",
  user: "ALL ACCOUNTS"
};

export function scopeTagForSection(section: SettingsSection): string {
  return SCOPE_TAG_LABEL[settingsTierForSection(section)];
}
