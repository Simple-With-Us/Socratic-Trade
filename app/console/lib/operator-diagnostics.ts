/** Client helpers for the four previously curl-only diagnostic surfaces.
 *  Fetch wrappers call the EXISTING routes and do not invent query params
 *  the servers do not already honor. */

import type { ScoringWeights } from "@/lib/types";
import { describeProbeStatus, type ProbeErrorAudience } from "../../admin/lib/probe-error";
import { SENTENCE_GAP } from "./format";

export const TUNING_DRY_RUN_PATH = "/api/admin/tuning-dry-run";
export const LEARNING_LEDGER_PATH = "/api/admin/learning-ledger";
export const BACKTEST_IC_PATH = "/api/admin/backtest-ic";
export const AUDIT_QUERY_PATH = "/api/audit";

export const WEIGHT_FACTORS = [
  "liquidity",
  "momentum",
  "value",
  "quality",
  "volatility",
  "sentiment",
  "positioning",
  "diversification"
] as const satisfies ReadonlyArray<keyof ScoringWeights>;

export const FACTOR_LABELS: Record<keyof ScoringWeights, string> = {
  liquidity: "Liquidity",
  momentum: "Momentum",
  value: "Value",
  quality: "Quality",
  volatility: "Volatility",
  sentiment: "Sentiment",
  positioning: "Positioning",
  diversification: "Diversification"
};

export interface TuningDryRunDecision {
  wouldApply: boolean;
  reason?: string;
  before?: Partial<ScoringWeights>;
  after?: Partial<ScoringWeights>;
  oosICCandidate?: number;
  oosICBaseline?: number;
  clampedDeltas?: Partial<Record<keyof ScoringWeights, number>>;
  oosReadout?: {
    icDelta?: number;
    icir?: number;
    testDates?: number;
    pairedTStat?: number;
    pairedN?: number;
    candidateMaxDrawdownPct?: number;
    baselineMaxDrawdownPct?: number;
    trainDates?: number;
    trainObservations?: number;
    testObservations?: number;
    evidenceCutoffDate?: string;
    partiallyInSampleCaveat?: string;
  };
  changedFactors?: string[];
  confidenceScore?: number;
  generatedBy?: string;
  cautions?: string[];
  invariantViolations?: Array<{ message: string } | string>;
}

export interface TuningDryRunResponse {
  ok: boolean;
  dryRun?: boolean;
  decision: TuningDryRunDecision;
  note?: string;
}

export interface LearningLedgerEntry {
  id: string;
  subsystem: string;
  trigger?: string;
  runId?: string;
  flag?: string;
  beforeState: unknown;
  afterState: unknown;
  evidence?: unknown;
  revertedAt?: string;
  revertedBy?: string;
  createdAt: string;
}

export interface LearningLedgerResponse {
  ok: boolean;
  count: number;
  entries: LearningLedgerEntry[];
}

export interface LearningLedgerRevertResponse {
  ok: boolean;
  entryId?: string;
  restoredWeights?: Partial<ScoringWeights>;
  reason?: string;
}

export interface FactorIcRow {
  factor: keyof ScoringWeights | string;
  ic: number;
  n: number;
}

export interface PerRegimeFactorIc {
  regime: string;
  dates: number;
  observations: number;
  ics: FactorIcRow[];
  sufficient: boolean;
}

export interface BacktestIcQuery {
  horizonDays: number;
  auditLimit: number;
  oos: boolean;
  trainFraction: number;
  costRoundTripBps: number;
  taxRate: number;
  topK: number;
}

export const BACKTEST_IC_DEFAULTS: BacktestIcQuery = {
  horizonDays: 5,
  auditLimit: 500,
  oos: true,
  trainFraction: 0.7,
  costRoundTripBps: 20,
  taxRate: 0.24,
  topK: 3
};

export interface BacktestIcResponse {
  ok: boolean;
  horizonDays: number;
  observationCount: number;
  informationCoefficients: FactorIcRow[];
  currentWeights: Partial<ScoringWeights> | null;
  suggestedWeights: Partial<ScoringWeights> | null;
  suggestedWeightsGated: Partial<ScoringWeights> | null;
  perRegimeICs: PerRegimeFactorIc[];
  perRegimeNote?: string;
  note?: string;
  oos: {
    trainObservations?: number;
    testObservations?: number;
    trainDates?: number;
    testDates?: number;
    oosIC?: number;
    oosICIR?: number;
    oosICDefault?: number;
    annualizedReturn?: number;
    benchmarkAnnualizedReturn?: number;
    activeReturn?: number;
    sharpeRatio?: number;
    maxDrawdownPct?: number;
    note?: string;
  } | null;
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
  connectedAccountId?: string;
}

export class OperatorDiagnosticError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OperatorDiagnosticError";
    this.status = status;
  }
}

export function learningLedgerUrl(opts?: { subsystem?: string; limit?: number }): string {
  const params = new URLSearchParams();
  if (opts?.subsystem) params.set("subsystem", opts.subsystem);
  if (typeof opts?.limit === "number" && Number.isFinite(opts.limit)) {
    params.set("limit", String(opts.limit));
  }
  const query = params.toString();
  return query ? `${LEARNING_LEDGER_PATH}?${query}` : LEARNING_LEDGER_PATH;
}

export function backtestIcUrl(query: Partial<BacktestIcQuery> = {}): string {
  const merged = { ...BACKTEST_IC_DEFAULTS, ...query };
  const params = new URLSearchParams({
    horizonDays: String(merged.horizonDays),
    auditLimit: String(merged.auditLimit),
    oos: merged.oos ? "true" : "false",
    trainFraction: String(merged.trainFraction),
    costRoundTripBps: String(merged.costRoundTripBps),
    taxRate: String(merged.taxRate),
    topK: String(merged.topK)
  });
  return `${BACKTEST_IC_PATH}?${params.toString()}`;
}

export function describeOperatorFetchError(
  status: number,
  payload?: unknown,
  audience: ProbeErrorAudience = "operator"
): string {
  if (status === 429) {
    const retry = readRetryAfterSeconds(payload);
    return Number.isFinite(retry)
      ? `This diagnostic is rate-limited.${SENTENCE_GAP}Try again in ${retry}s.`
      : `This diagnostic is rate-limited.${SENTENCE_GAP}Try again shortly.`;
  }
  if (status === 409) {
    return `Another diagnostic is already running.${SENTENCE_GAP}Try again when it finishes.`;
  }
  if (payload && typeof payload === "object") {
    const record = payload as { error?: unknown; reason?: unknown; message?: unknown };
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (typeof record.reason === "string" && record.reason.trim()) return record.reason;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  return describeProbeStatus(status, audience).message;
}

export function filterAuditEvents(events: AuditEvent[], kindQuery: string): AuditEvent[] {
  const needle = kindQuery.trim().toLowerCase();
  if (!needle) return events;
  return events.filter((event) => event.kind.toLowerCase().includes(needle));
}

export interface WeightCompareRow {
  key: keyof ScoringWeights;
  label: string;
  before: number | undefined;
  after: number | undefined;
  delta: number | undefined;
}

export function weightCompareRows(
  before?: Partial<ScoringWeights> | null,
  after?: Partial<ScoringWeights> | null
): WeightCompareRow[] {
  return WEIGHT_FACTORS.map((key) => {
    const beforeValue = finiteNumber(before?.[key]);
    const afterValue = finiteNumber(after?.[key]);
    const delta =
      beforeValue !== undefined && afterValue !== undefined ? afterValue - beforeValue : undefined;
    return {
      key,
      label: FACTOR_LABELS[key],
      before: beforeValue,
      after: afterValue,
      delta
    };
  });
}

export function formatWeight(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(2);
}

export function formatSigned(value: number | undefined, digits = 2): string {
  if (value === undefined) return "—";
  const abs = Math.abs(value).toFixed(digits);
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return (0).toFixed(digits);
}

export function formatIc(value: number | undefined, digits = 3): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function formatAuditPayloadPreview(payload: unknown, max = 160): string {
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload);
    } catch {
      text = String(payload);
    }
  }
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function invariantViolationText(violation: { message: string } | string): string {
  return typeof violation === "string" ? violation : violation.message;
}

export async function fetchTuningDryRun(): Promise<TuningDryRunResponse> {
  return getJson<TuningDryRunResponse>(TUNING_DRY_RUN_PATH);
}

export async function fetchLearningLedger(opts?: {
  subsystem?: string;
  limit?: number;
}): Promise<LearningLedgerResponse> {
  return getJson<LearningLedgerResponse>(learningLedgerUrl(opts));
}

export async function revertLearningLedgerEntry(entryId: string): Promise<LearningLedgerRevertResponse> {
  return postJson<LearningLedgerRevertResponse>(LEARNING_LEDGER_PATH, { entryId });
}

export async function fetchBacktestIc(query: Partial<BacktestIcQuery> = {}): Promise<BacktestIcResponse> {
  return getJson<BacktestIcResponse>(backtestIcUrl(query));
}

export async function fetchAuditEvents(): Promise<AuditEvent[]> {
  const payload = await getJson<AuditEvent[] | { entries?: AuditEvent[] }>(AUDIT_QUERY_PATH, "generic");
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.entries) ? payload.entries : [];
}

async function getJson<T>(url: string, audience: ProbeErrorAudience = "operator"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new OperatorDiagnosticError("Could not reach the server to load this data.", 0);
  }
  const payload = await readJson(res);
  if (!res.ok) {
    throw new OperatorDiagnosticError(describeOperatorFetchError(res.status, payload, audience), res.status);
  }
  return payload as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new OperatorDiagnosticError("Could not reach the server to load this data.", 0);
  }
  const payload = await readJson(res);
  if (!res.ok) {
    throw new OperatorDiagnosticError(describeOperatorFetchError(res.status, payload), res.status);
  }
  return payload as T;
}

async function readJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;
  return res.json().catch(() => undefined);
}

function readRetryAfterSeconds(payload: unknown): number {
  if (!payload || typeof payload !== "object") return Number.NaN;
  const value = (payload as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === "number" ? value : Number.NaN;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
