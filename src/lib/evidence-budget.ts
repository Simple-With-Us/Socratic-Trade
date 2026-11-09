import type { EvidenceRef, EvidenceSourceFamily } from "./evidence-pack";

export type BudgetConstraint =
  | "global_character_quota"
  | "global_token_quota"
  | "family_character_quota"
  | "family_token_quota";

export interface SourceFamilyQuota {
  readonly maxCharacters?: number;
  readonly maxTokenEstimate?: number;
}

export interface EvidenceBudget {
  readonly maxCharacters: number;
  readonly maxTokenEstimate: number;
  /** Conservative deterministic conversion. Defaults to four Unicode code points per token. */
  readonly charactersPerToken?: number;
  readonly familyQuotas?: Partial<Record<EvidenceSourceFamily, SourceFamilyQuota>>;
}

export interface EvidenceBudgetItem {
  readonly ref: EvidenceRef;
  readonly text: string;
  /** Larger numbers are kept first; ties always resolve by immutable EvidenceRef id. */
  readonly priority?: number;
}

export interface EvidenceBudgetInclusion {
  readonly evidenceId: string;
  readonly sourceFamily: EvidenceSourceFamily;
  readonly text: string;
  readonly originalCharacters: number;
  readonly includedCharacters: number;
  readonly tokenEstimate: number;
  readonly truncated: boolean;
}

export interface EvidenceBudgetReceipt {
  readonly evidenceId: string;
  readonly sourceFamily: EvidenceSourceFamily;
  readonly action: "included" | "truncated" | "omitted";
  readonly originalCharacters: number;
  readonly includedCharacters: number;
  readonly originalTokenEstimate: number;
  readonly includedTokenEstimate: number;
  readonly constraints: readonly BudgetConstraint[];
}

export interface EvidenceBudgetResult {
  readonly included: readonly EvidenceBudgetInclusion[];
  readonly receipts: readonly EvidenceBudgetReceipt[];
  readonly usedCharacters: number;
  readonly usedTokenEstimate: number;
}

interface Usage {
  characters: number;
  tokens: number;
}

function assertWholeNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

export function estimateEvidenceTokens(text: string, charactersPerToken = 4): number {
  if (!Number.isSafeInteger(charactersPerToken) || charactersPerToken < 1) {
    throw new Error("charactersPerToken must be a positive safe integer");
  }
  return Math.ceil(codePoints(text).length / charactersPerToken);
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as object)) freeze(child);
  return Object.freeze(value);
}

function quotaFor(family: EvidenceSourceFamily, quotas: Partial<Record<EvidenceSourceFamily, SourceFamilyQuota>>): SourceFamilyQuota {
  return quotas[family] ?? {};
}

function constraintsFor(
  characters: number,
  tokens: number,
  global: Usage,
  family: Usage,
  budget: Required<Pick<EvidenceBudget, "maxCharacters" | "maxTokenEstimate">>,
  quota: SourceFamilyQuota
): BudgetConstraint[] {
  const constraints: BudgetConstraint[] = [];
  if (characters > budget.maxCharacters - global.characters) constraints.push("global_character_quota");
  if (tokens > budget.maxTokenEstimate - global.tokens) constraints.push("global_token_quota");
  if (quota.maxCharacters !== undefined && characters > quota.maxCharacters - family.characters) constraints.push("family_character_quota");
  if (quota.maxTokenEstimate !== undefined && tokens > quota.maxTokenEstimate - family.tokens) constraints.push("family_token_quota");
  return constraints;
}

/**
 * Applies a single deterministic budget to prompt-ready evidence. It never drops
 * material silently: every ref receives an included, truncated, or omitted receipt.
 */
export function applyEvidenceBudget(items: readonly EvidenceBudgetItem[], budget: EvidenceBudget): EvidenceBudgetResult {
  assertWholeNonNegative(budget.maxCharacters, "maxCharacters");
  assertWholeNonNegative(budget.maxTokenEstimate, "maxTokenEstimate");
  const charactersPerToken = budget.charactersPerToken ?? 4;
  if (!Number.isSafeInteger(charactersPerToken) || charactersPerToken < 1) {
    throw new Error("charactersPerToken must be a positive safe integer");
  }
  const quotas = budget.familyQuotas ?? {};
  for (const [family, quota] of Object.entries(quotas)) {
    if (!quota) continue;
    if (quota.maxCharacters !== undefined) assertWholeNonNegative(quota.maxCharacters, `${family}.maxCharacters`);
    if (quota.maxTokenEstimate !== undefined) assertWholeNonNegative(quota.maxTokenEstimate, `${family}.maxTokenEstimate`);
  }

  const ordered = [...items].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.ref.id.localeCompare(right.ref.id));
  const seen = new Set<string>();
  const global: Usage = { characters: 0, tokens: 0 };
  const familyUsage = new Map<EvidenceSourceFamily, Usage>();
  const included: EvidenceBudgetInclusion[] = [];
  const receipts: EvidenceBudgetReceipt[] = [];

  for (const item of ordered) {
    if (seen.has(item.ref.id)) throw new Error(`Evidence budget cannot contain duplicate ref ${item.ref.id}`);
    seen.add(item.ref.id);
    const family = item.ref.source.family;
    const usage = familyUsage.get(family) ?? { characters: 0, tokens: 0 };
    familyUsage.set(family, usage);
    const quota = quotaFor(family, quotas);
    const units = codePoints(item.text);
    const originalCharacters = units.length;
    const originalTokenEstimate = estimateEvidenceTokens(item.text, charactersPerToken);
    const availableCharacters = Math.max(
      0,
      Math.min(budget.maxCharacters - global.characters, (quota.maxCharacters ?? Number.MAX_SAFE_INTEGER) - usage.characters)
    );
    const availableTokens = Math.max(
      0,
      Math.min(budget.maxTokenEstimate - global.tokens, (quota.maxTokenEstimate ?? Number.MAX_SAFE_INTEGER) - usage.tokens)
    );
    const allowedCharacters = Math.min(originalCharacters, availableCharacters, availableTokens * charactersPerToken);
    const text = units.slice(0, allowedCharacters).join("");
    const includedTokenEstimate = estimateEvidenceTokens(text, charactersPerToken);
    const constraints = constraintsFor(originalCharacters, originalTokenEstimate, global, usage, budget, quota);
    const action = allowedCharacters === 0 && originalCharacters > 0 ? "omitted" : allowedCharacters < originalCharacters ? "truncated" : "included";
    const receipt = freeze({
      evidenceId: item.ref.id,
      sourceFamily: family,
      action,
      originalCharacters,
      includedCharacters: allowedCharacters,
      originalTokenEstimate,
      includedTokenEstimate,
      constraints
    } satisfies EvidenceBudgetReceipt);
    receipts.push(receipt);
    if (action !== "omitted") {
      included.push(freeze({
        evidenceId: item.ref.id,
        sourceFamily: family,
        text,
        originalCharacters,
        includedCharacters: allowedCharacters,
        tokenEstimate: includedTokenEstimate,
        truncated: action === "truncated"
      } satisfies EvidenceBudgetInclusion));
      global.characters += allowedCharacters;
      global.tokens += includedTokenEstimate;
      usage.characters += allowedCharacters;
      usage.tokens += includedTokenEstimate;
    }
  }
  return freeze({ included, receipts, usedCharacters: global.characters, usedTokenEstimate: global.tokens });
}
