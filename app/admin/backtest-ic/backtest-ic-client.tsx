"use client";

// Admin > Factor Backtest — read-only GET /api/admin/backtest-ic.  Suggestion only;
// never applies weights.

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Btn, Card, Chip, Field, NumInput, Toggle } from "../../console/ui/primitives";
import { SENTENCE_GAP } from "../../console/lib/format";
import {
  BACKTEST_IC_DEFAULTS,
  FACTOR_LABELS,
  fetchBacktestIc,
  formatIc,
  formatWeight,
  OperatorDiagnosticError,
  weightCompareRows,
  type BacktestIcQuery,
  type BacktestIcResponse,
  type FactorIcRow
} from "../../console/lib/operator-diagnostics";
import type { ScoringWeights } from "@/lib/types";

export function BacktestIcClient() {
  const [query, setQuery] = useState<BacktestIcQuery>(BACKTEST_IC_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestIcResponse | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await fetchBacktestIc(query));
    } catch (err) {
      setResult(null);
      setError(err instanceof OperatorDiagnosticError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Factor Backtest</h1>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Information coefficients for scan factor weights against realized forward
            returns.{SENTENCE_GAP}Suggestion only — apply through the strategy tuner.
          </p>
        </div>
        <Btn variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? "Running..." : "Run Backtest"}
        </Btn>
      </div>

      <Card title="Query">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField
            id="horizonDays"
            label="Horizon Days"
            value={query.horizonDays}
            onChange={(horizonDays) => setQuery((current) => ({ ...current, horizonDays }))}
          />
          <NumberField
            id="auditLimit"
            label="Audit Limit"
            value={query.auditLimit}
            onChange={(auditLimit) => setQuery((current) => ({ ...current, auditLimit }))}
          />
          <NumberField
            id="trainFraction"
            label="Train Fraction"
            value={query.trainFraction}
            step="0.05"
            onChange={(trainFraction) => setQuery((current) => ({ ...current, trainFraction }))}
          />
          <NumberField
            id="costRoundTripBps"
            label="Round-Trip Cost (bps)"
            value={query.costRoundTripBps}
            onChange={(costRoundTripBps) => setQuery((current) => ({ ...current, costRoundTripBps }))}
          />
          <NumberField
            id="taxRate"
            label="Tax Rate"
            value={query.taxRate}
            step="0.01"
            onChange={(taxRate) => setQuery((current) => ({ ...current, taxRate }))}
          />
          <NumberField
            id="topK"
            label="Top K"
            value={query.topK}
            onChange={(topK) => setQuery((current) => ({ ...current, topK }))}
          />
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Toggle
            checked={query.oos}
            onChange={(oos) => setQuery((current) => ({ ...current, oos }))}
            label="Include walk-forward OOS"
          />
          <span className="text-[length:var(--con-fs-sm)]">Include Walk-Forward OOS</span>
        </div>
      </Card>

      {error && (
        <div className="rounded-[var(--con-radius)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4">
          <div className="flex items-start gap-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {result && <BacktestResult result={result} />}
    </div>
  );
}

function BacktestResult({ result }: { result: BacktestIcResponse }) {
  const compare = weightCompareRows(result.currentWeights, result.suggestedWeights);
  const gated = result.suggestedWeightsGated ?? {};

  return (
    <div className="space-y-4">
      <Card title="Summary">
        <div className="grid gap-2 sm:grid-cols-3">
          <Stat label="Horizon Days" value={String(result.horizonDays)} />
          <Stat label="Observations" value={String(result.observationCount)} />
          <Stat label="OOS" value={result.oos ? "included" : "omitted"} />
        </div>
        {result.note && (
          <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{result.note}</p>
        )}
      </Card>

      <Card title="Information Coefficients">
        <IcTable rows={result.informationCoefficients} />
      </Card>

      <Card title="Weights">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[length:var(--con-fs-xs)]">
            <thead className="text-[color:var(--con-faint)]">
              <tr>
                <th className="py-1 font-medium">Factor</th>
                <th className="py-1 font-medium">Current</th>
                <th className="py-1 font-medium">Suggested</th>
                <th className="py-1 font-medium">Gated</th>
              </tr>
            </thead>
            <tbody>
              {compare.map((row) => (
                <tr key={row.key} className="border-t border-[color:var(--con-line)]">
                  <td className="py-1.5">{row.label}</td>
                  <td className="con-num py-1.5">{formatWeight(row.before)}</td>
                  <td className="con-num py-1.5">{formatWeight(row.after)}</td>
                  <td className="con-num py-1.5">{formatWeight(finiteWeight(gated[row.key]))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {result.oos && (
        <Card title="Walk-Forward OOS">
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="OOS IC" value={formatIc(result.oos.oosIC)} />
            <Stat label="OOS ICIR" value={formatIc(result.oos.oosICIR)} />
            <Stat label="Sharpe" value={formatIc(result.oos.sharpeRatio)} />
            <Stat label="Ann. Return" value={formatIc(result.oos.annualizedReturn)} />
            <Stat label="Active Return" value={formatIc(result.oos.activeReturn)} />
            <Stat label="Max Drawdown" value={formatIc(result.oos.maxDrawdownPct)} />
            <Stat label="Train Dates" value={result.oos.trainDates === undefined ? "—" : String(result.oos.trainDates)} />
            <Stat label="Test Dates" value={result.oos.testDates === undefined ? "—" : String(result.oos.testDates)} />
          </div>
          {result.oos.note && (
            <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{result.oos.note}</p>
          )}
        </Card>
      )}

      {result.perRegimeICs.length > 0 && (
        <Card title="Per-Regime ICs">
          {result.perRegimeNote && (
            <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {result.perRegimeNote}
            </p>
          )}
          <div className="space-y-4">
            {result.perRegimeICs.map((bucket) => (
              <div key={bucket.regime}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{bucket.regime}</span>
                  <Chip tone={bucket.sufficient ? "pos" : "warn"}>
                    {bucket.sufficient ? "sufficient" : "thin sample"}
                  </Chip>
                  <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    {bucket.dates} dates · {bucket.observations} observations
                  </span>
                </div>
                <IcTable rows={bucket.ics} />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function IcTable({ rows }: { rows: FactorIcRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[length:var(--con-fs-xs)]">
        <thead className="text-[color:var(--con-faint)]">
          <tr>
            <th className="py-1 font-medium">Factor</th>
            <th className="py-1 font-medium">IC</th>
            <th className="py-1 font-medium">n</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.factor} className="border-t border-[color:var(--con-line)]">
              <td className="py-1.5">
                {row.factor in FACTOR_LABELS
                  ? FACTOR_LABELS[row.factor as keyof ScoringWeights]
                  : row.factor}
              </td>
              <td className="con-num py-1.5">{formatIc(row.ic)}</td>
              <td className="con-num py-1.5">{row.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  step,
  onChange
}: {
  id: string;
  label: string;
  value: number;
  step?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <NumInput
        id={id}
        value={String(value)}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </Field>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="con-tile">
      <div className="text-[color:var(--con-muted)]">{label}</div>
      <div className="con-num mt-0.5 font-semibold">{value}</div>
    </div>
  );
}

function finiteWeight(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
