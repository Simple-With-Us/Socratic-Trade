import type { RiskRules, ScoringWeights, StrategyTuningPatch, StrategyTuningProposal, TradingPolicy } from "./types";

export type StrategyReviewChangeSection = "studio" | "risk";

export interface StrategyReviewPromptChange {
  current: string;
  proposed: string;
  changed: boolean;
}

export interface StrategyReviewChange {
  id: string;
  label: string;
  location: string;
  current: string;
  proposed: string;
  changed: boolean;
  section: StrategyReviewChangeSection;
}

export interface StrategyReviewDisplay {
  promptChange?: StrategyReviewPromptChange;
  studioChanges: StrategyReviewChange[];
  riskChanges: StrategyReviewChange[];
  allChanges: StrategyReviewChange[];
  hasEffectiveChanges: boolean;
}

type PolicyPatch = NonNullable<StrategyTuningPatch["policy"]>;
type PolicyScalarKey = Exclude<keyof PolicyPatch, "riskRules" | "sectorCaps">;

type ScalarFieldSpec = {
  key: PolicyScalarKey;
  label: string;
  location: string;
  current: (policy: TradingPolicy) => unknown;
  format: (value: unknown) => string;
};

type RiskFieldSpec = {
  key: keyof RiskRules;
  label: string;
  location: string;
  current: (policy: TradingPolicy) => unknown;
  format: (value: unknown) => string;
};

const SCORING_WEIGHT_LABELS: Record<keyof ScoringWeights, string> = {
  liquidity: "Liquidity weight",
  momentum: "Momentum weight",
  value: "Value weight",
  quality: "Quality weight",
  volatility: "Volatility weight",
  sentiment: "Sentiment weight",
  positioning: "Smart-money positioning weight",
  diversification: "Diversification weight"
};

const POLICY_FIELD_SPECS: ScalarFieldSpec[] = [
  {
    key: "maxOrderNotional",
    label: "Max order notional",
    location: "Key Parameters",
    current: (policy) => policy.maxOrderNotional,
    format: formatCurrency
  },
  {
    key: "maxDailyNotional",
    label: "Max daily notional",
    location: "Key Parameters",
    current: (policy) => policy.maxDailyNotional,
    format: formatCurrency
  },
  {
    key: "maxHourlyNotional",
    label: "Max hourly notional",
    location: "Key Parameters",
    current: (policy) => policy.maxHourlyNotional,
    format: formatCurrency
  },
  {
    key: "maxSymbolExposurePct",
    label: "Max symbol exposure",
    location: "Key Parameters",
    current: (policy) => policy.maxSymbolExposurePct,
    format: formatPercent
  },
  {
    key: "maxDailyOrders",
    label: "Max daily orders",
    location: "Key Parameters",
    current: (policy) => policy.maxDailyOrders,
    format: formatWholeNumber
  },
  {
    key: "maxProposalsPerRun",
    label: "Max proposals per run",
    location: "Key Parameters",
    current: (policy) => policy.maxProposalsPerRun,
    format: formatWholeNumber
  },
  {
    key: "runCadenceMinutes",
    label: "Run cadence",
    location: "Key Parameters",
    current: (policy) => policy.runCadenceMinutes,
    format: formatMinutes
  },
  {
    key: "strategyAuthority",
    label: "Strategy authority",
    location: "Operate",
    current: (policy) => policy.strategyAuthority,
    format: formatStrategyAuthority
  },
  {
    key: "runDuringExtendedHours",
    label: "Run during extended hours",
    location: "Key Parameters",
    current: (policy) => policy.runDuringExtendedHours,
    format: formatBoolean
  }
];

const RISK_FIELD_SPECS: RiskFieldSpec[] = [
  {
    key: "stopLossPct",
    label: "Stop loss",
    location: "Key Parameters",
    current: (policy) => policy.riskRules.stopLossPct,
    format: formatPercent
  },
  {
    key: "takeProfitPct",
    label: "Take profit",
    location: "Key Parameters",
    current: (policy) => policy.riskRules.takeProfitPct,
    format: formatPercent
  },
  {
    key: "trailingStopPct",
    label: "Trailing stop",
    location: "Risk & Safety",
    current: (policy) => policy.riskRules.trailingStopPct,
    format: formatPercent
  }
];

export function buildStrategyReviewDisplay(
  proposal: StrategyTuningProposal,
  current: { policy: TradingPolicy; strategyPrompt: string }
): StrategyReviewDisplay {
  const patch = proposal.proposedPatch;
  const promptChange = buildPromptChange(patch.prompt, current.strategyPrompt);
  const studioChanges = buildScoringWeightChanges(patch.scoringWeights, current.policy);
  const riskChanges = [
    ...buildPolicyChanges(patch.policy, current.policy),
    ...buildSectorCapChanges(patch.policy?.sectorCaps, current.policy)
  ];
  const allChanges = [...studioChanges, ...riskChanges];

  return {
    ...(promptChange ? { promptChange } : {}),
    studioChanges,
    riskChanges,
    allChanges,
    hasEffectiveChanges: Boolean(promptChange?.changed) || allChanges.some((change) => change.changed)
  };
}

function buildPromptChange(proposedPrompt: string | undefined, currentPrompt: string): StrategyReviewPromptChange | undefined {
  const proposed = proposedPrompt?.trim();
  if (!proposed) return undefined;
  const current = currentPrompt.trim();
  return {
    current,
    proposed,
    changed: proposed !== current
  };
}

function buildScoringWeightChanges(scoringWeights: StrategyTuningPatch["scoringWeights"], policy: TradingPolicy): StrategyReviewChange[] {
  return (Object.entries(scoringWeights ?? {}) as Array<[keyof ScoringWeights, number | undefined]>)
    .filter((entry): entry is [keyof ScoringWeights, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .map(([key, proposed]) =>
      makeChange({
        id: `weight-${key}`,
        label: SCORING_WEIGHT_LABELS[key] ?? `${String(key)} weight`,
        location: "Scoring Weights",
        currentValue: policy.scoringWeights[key],
        proposedValue: proposed,
        format: formatWeight,
        section: "studio"
      })
    );
}

function buildPolicyChanges(policyPatch: PolicyPatch | undefined, policy: TradingPolicy): StrategyReviewChange[] {
  if (!policyPatch) return [];
  const changes: StrategyReviewChange[] = [];
  for (const spec of POLICY_FIELD_SPECS) {
    const proposed = policyPatch[spec.key];
    if (proposed === undefined) continue;
    changes.push(
      makeChange({
        id: `policy-${String(spec.key)}`,
        label: spec.label,
        location: spec.location,
        currentValue: spec.current(policy),
        proposedValue: proposed,
        format: spec.format,
        section: "risk"
      })
    );
  }

  for (const spec of RISK_FIELD_SPECS) {
    const proposed = policyPatch.riskRules?.[spec.key];
    if (proposed === undefined) continue;
    changes.push(
      makeChange({
        id: `risk-${String(spec.key)}`,
        label: spec.label,
        location: spec.location,
        currentValue: spec.current(policy),
        proposedValue: proposed,
        format: spec.format,
        section: "risk"
      })
    );
  }
  return changes;
}

function buildSectorCapChanges(sectorCaps: Record<string, number> | undefined, policy: TradingPolicy): StrategyReviewChange[] {
  if (!sectorCaps) return [];
  return [
    makeChange({
      id: "policy-sectorCaps",
      label: "Sector caps",
      location: "Risk & Safety",
      currentValue: policy.sectorCaps,
      proposedValue: sectorCaps,
      format: formatSectorCaps,
      section: "risk"
    })
  ];
}

function makeChange(input: {
  id: string;
  label: string;
  location: string;
  currentValue: unknown;
  proposedValue: unknown;
  format: (value: unknown) => string;
  section: StrategyReviewChangeSection;
}): StrategyReviewChange {
  const current = input.format(input.currentValue);
  const proposed = input.format(input.proposedValue);
  return {
    id: input.id,
    label: input.label,
    location: input.location,
    current,
    proposed,
    changed: current !== proposed,
    section: input.section
  };
}

function formatCurrency(value: unknown): string {
  if (!isFiniteNumber(value)) return "Not set";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2
  }).format(value);
}

function formatPercent(value: unknown): string {
  if (!isFiniteNumber(value)) return "Not set";
  return `${formatNumber(value)}%`;
}

function formatWholeNumber(value: unknown): string {
  if (!isFiniteNumber(value)) return "Not set";
  return String(Math.round(value));
}

function formatMinutes(value: unknown): string {
  if (!isFiniteNumber(value)) return "Not set";
  const rounded = Math.round(value);
  return `${rounded} min`;
}

function formatWeight(value: unknown): string {
  if (!isFiniteNumber(value)) return "Not set";
  return value.toFixed(2);
}

function formatBoolean(value: unknown): string {
  if (typeof value !== "boolean") return "Not set";
  return value ? "On" : "Off";
}

function formatStrategyAuthority(value: unknown): string {
  if (value === "decide") return "Decide (auto-execute)";
  if (value === "propose") return "Propose (manual approval)";
  if (value === "close_only") return "Close only";
  return "Not set";
}

function formatSectorCaps(value: unknown): string {
  if (!value || typeof value !== "object") return "None";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return "None";
  return entries.map(([sector, cap]) => `${sector}: ${formatNumber(cap)}%`).join(", ");
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
