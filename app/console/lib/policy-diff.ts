/** Pure policy-diff logic for the console's review-and-commit editor: field
 *  metadata, sparse-draft diffing, LOOSER/TIGHTER classification (the thing
 *  the typed-CONFIRM friction hangs off), and the PUT body builder. Kept free
 *  of React so the safety classification is unit-testable.
 *
 *  HONESTY CONTRACT for cleared fields: the server strips `null` back to an
 *  ABSENT key (`stripNullsDeep`), and `mergePolicy` re-applies DEFAULT_POLICY
 *  on every read. So clearing a field only means "off" when DEFAULT_POLICY has
 *  no value for it; otherwise it means "revert to the shipped default". The
 *  helpers here (`clearedFallback`, `classify`) encode exactly that, so the UI
 *  never claims "off" when the guard silently comes back at its default. */

import { DEFAULT_POLICY } from "@/lib/defaults";
import { formatIndexUniverseLabels } from "@/lib/index-universes";
import type { TradingPolicy } from "@/lib/types";

// ── Field metadata ───────────────────────────────────────────────────────────

export type FieldKind = "money" | "pct" | "int" | "minutes" | "seconds" | "bool" | "text" | "select";

export interface FieldDef {
  /** Dot path into TradingPolicy, e.g. "maxOrderNotional" or "riskRules.stopLossPct". */
  path: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  /** Direction that LOOSENS the cage (drives the typed-confirm friction on live).
   *  For booleans: "on" = enabling loosens (e.g. short selling); "off" = DISABLING
   *  loosens (e.g. turning a protective brake off). */
  looserWhen?: "up" | "down" | "on" | "off";
  /** Optional numeric: blank clears the field. What that MEANS depends on the
   *  server default — see clearedFallback. */
  optional?: boolean;
  /** kind "select": the enum choices, in render order. */
  options?: Array<{ value: string; label: string }>;
  /** kind "select": optional map from the string option value to the TYPED draft value — needed
   *  when the backing field isn't a string (e.g. a three-state boolean "Use global / On / Off"
   *  where "" must write `null` so the key clears back to the global default, and "true"/"false"
   *  must write real booleans). Keys not present map to themselves; "" MUST be mapped explicitly
   *  (to null) or the cleared state can never be committed. */
  optionValues?: Record<string, unknown>;
  /** kind "select": looseness rank per value (higher = looser). Moving to a higher-ranked
   *  value classifies as LOOSER (typed word on LIVE); lower = tighter. Blank values fall back
   *  to the DEFAULT_POLICY value at `path`. Omit for selects with no safety ordering. */
  looseRank?: Record<string, number>;
}

export function getAtPath(policy: TradingPolicy, path: string): unknown {
  let value: unknown = policy;
  for (const key of path.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** What the server actually does when this optional field is cleared.
 *  Returns the DEFAULT_POLICY value that mergePolicy will re-apply on read
 *  (the guard reverts to that default), or undefined when clearing genuinely
 *  turns the guard off (no shipped default, or a 0 default = off).
 *  `universeFloor.*` is special: the stored policy carries the whole object,
 *  which overrides the default wholesale, so a cleared floor key stays off. */
export function clearedFallback(def: FieldDef): number | undefined {
  if (!def.optional) return undefined;
  if (def.path.startsWith("universeFloor.")) return undefined;
  const d = getAtPath(DEFAULT_POLICY, def.path);
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : undefined;
}

// ── Diff + LOOSER/TIGHTER classification ─────────────────────────────────────

export interface DiffEntry {
  def: FieldDef;
  from: unknown;
  to: unknown;
  direction: "looser" | "tighter" | "changed";
}

export function classify(def: FieldDef, from: unknown, to: unknown): DiffEntry["direction"] {
  if (def.kind === "select") {
    const rank = def.looseRank;
    if (!rank) return "changed";
    // Blank means "the shipped default" (mergePolicy re-applies DEFAULT_POLICY on read).
    const fallback = String(getAtPath(DEFAULT_POLICY, def.path) ?? "");
    const fromRank = rank[isBlank(from) ? fallback : String(from)];
    const toRank = rank[isBlank(to) ? fallback : String(to)];
    if (fromRank === undefined || toRank === undefined || fromRank === toRank) return "changed";
    return toRank > fromRank ? "looser" : "tighter";
  }
  if (!def.looserWhen) return "changed";
  if (def.kind === "bool") {
    const on = to === true;
    if (def.looserWhen === "on") return on ? "looser" : "tighter";
    if (def.looserWhen === "off") return on ? "tighter" : "looser";
    return "changed";
  }
  const cleared = clearedFallback(def);
  const fromNum = typeof from === "number" && Number.isFinite(from) ? from : cleared ?? null;
  const toNum = typeof to === "number" && Number.isFinite(to) ? to : cleared ?? null;
  // Removing a guard entirely (no default comes back) is the loosest move for
  // caps AND floors alike; introducing one where none existed is tightening.
  if (toNum === null && fromNum !== null) return "looser";
  if (fromNum === null && toNum !== null) return "tighter";
  if (fromNum === null || toNum === null || fromNum === toNum) return "changed";
  const up = toNum > fromNum;
  // looserWhen "up": a BIGGER number loosens (raising a cap). "down": a SMALLER number loosens —
  // e.g. a universe floor, where lowering the min price/cap/volume lets MORE names in. The two
  // cases invert; a prior version used the same `up ? looser : tighter` for both, so lowering a
  // floor was mislabeled "Locks Down" when it actually widens the universe.
  return def.looserWhen === "up" ? (up ? "looser" : "tighter") : (up ? "tighter" : "looser");
}

export interface SparseDraftValues {
  [path: string]: unknown;
}

export function computeDiff(policy: TradingPolicy, values: SparseDraftValues, defs: FieldDef[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const def of defs) {
    if (!(def.path in values)) continue;
    const from = getAtPath(policy, def.path);
    const to = values[def.path];
    const same = (isBlank(from) && isBlank(to)) || from === to;
    if (same) continue;
    entries.push({ def, from, to, direction: classify(def, from, to) });
  }
  return entries;
}

export type PolicyPatchBody = Record<string, unknown> & { strategyPrompt?: string };

/** Nest sparse dot-path values into the PUT body shape. Sends null for cleared
 *  optional fields — the server's stripNullsDeep turns that into "absent".
 *  Nested parents are SEEDED from the current policy so untouched siblings
 *  survive server-side whole-object replacement (e.g. `universeFloor`, which
 *  /api/policy does NOT deep-merge — a sparse {universeFloor:{minPrice:5}}
 *  would silently wipe the other two floors). Harmless for deep-merged parents
 *  like riskRules. */
export function buildPatch(diff: DiffEntry[], policy: TradingPolicy): PolicyPatchBody {
  const patch: Record<string, unknown> = {};
  for (const entry of diff) {
    const parts = entry.def.path.split(".");
    let target = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof target[key] !== "object" || target[key] === null) {
        const current = getAtPath(policy, parts.slice(0, i + 1).join("."));
        target[key] = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
      }
      target = target[key] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = entry.to === undefined || entry.to === "" ? null : entry.to;
  }
  return patch;
}

// ── Extra-patch (whole-array / enum fields) classification ──────────────────
// Universe, blocklist, permitted order types, and sell-to-fund-buy travel via
// extraPatch (replace-whole-value), so they never hit computeDiff — but they
// absolutely can loosen the cage. Classify them so LIVE loosening still costs
// the typed word.

export interface ExtraDiffEntry {
  key: string;
  label: string;
  direction: DiffEntry["direction"];
  summary: string;
}

const SELL_TO_FUND_RANK: Record<string, number> = { off: 0, suggest: 1, propose: 2, automated: 3 };
const SELL_TO_FUND_LABELS: Record<string, string> = {
  off: "Off",
  suggest: "Suggest Only",
  propose: "Propose",
  automated: "Automated"
};

function sellToFundLabel(value: unknown): string {
  const key = String(value ?? "off");
  return SELL_TO_FUND_LABELS[key] ?? key;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function setDiff(from: string[], to: string[]): { added: string[]; removed: string[] } {
  const f = new Set(from);
  const t = new Set(to);
  return { added: to.filter((x) => !f.has(x)), removed: from.filter((x) => !t.has(x)) };
}

function listSummary(added: string[], removed: string[]): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`adds ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removes ${removed.join(", ")}`);
  return parts.join(" · ") || "reordered";
}

export function classifyExtraPatch(policy: TradingPolicy, extraPatch: PolicyPatchBody | undefined): ExtraDiffEntry[] {
  if (!extraPatch) return [];
  const entries: ExtraDiffEntry[] = [];
  for (const [key, value] of Object.entries(extraPatch)) {
    switch (key) {
      case "includedIndices": {
        const { added, removed } = setDiff(toStringArray(policy.includedIndices), toStringArray(value));
        entries.push({
          key,
          label: "Indices",
          // Any broadening of the tradable universe is a loosening, even mixed with removals.
          direction: added.length > 0 ? "looser" : removed.length > 0 ? "tighter" : "changed",
          summary: listSummary(formatIndexUniverseLabels(added), formatIndexUniverseLabels(removed))
        });
        break;
      }
      case "additionalSymbols": {
        const { added, removed } = setDiff(toStringArray(policy.additionalSymbols), toStringArray(value));
        entries.push({
          key,
          label: "Always-include symbols",
          // Added symbols become tradable AND skip the universe floor — looser.
          direction: added.length > 0 ? "looser" : removed.length > 0 ? "tighter" : "changed",
          summary: listSummary(added, removed)
        });
        break;
      }
      case "blocklist": {
        const { added, removed } = setDiff(toStringArray(policy.blocklist), toStringArray(value));
        entries.push({
          key,
          label: "Blocklist",
          // REMOVING a blocklist entry re-opens that name — looser. Adding one tightens.
          direction: removed.length > 0 ? "looser" : added.length > 0 ? "tighter" : "changed",
          summary: listSummary(added, removed)
        });
        break;
      }
      case "permittedOrderTypes": {
        const { added, removed } = setDiff(toStringArray(policy.permittedOrderTypes), toStringArray(value));
        entries.push({
          key,
          label: "Permitted order types",
          direction: added.length > 0 ? "looser" : removed.length > 0 ? "tighter" : "changed",
          summary: listSummary(added, removed)
        });
        break;
      }
      case "sellToFundBuy": {
        const from = SELL_TO_FUND_RANK[String(policy.sellToFundBuy ?? "off")] ?? 0;
        const to = SELL_TO_FUND_RANK[String(value)] ?? 0;
        entries.push({
          key,
          label: "Sell to Fund Buys",
          direction: to > from ? "looser" : to < from ? "tighter" : "changed",
          summary: `${sellToFundLabel(policy.sellToFundBuy)} → ${sellToFundLabel(value)}`
        });
        break;
      }
      default:
        entries.push({ key, label: key, direction: "changed", summary: "updated" });
    }
  }
  return entries;
}
