"use client";

import { useEffect, useState, useCallback } from "react";
import { Btn, Card, Select, Segmented, Stat, Toggle } from "../../console/ui/primitives";
import { llmUsageContextLabel } from "../../ui/llm-usage-labels";
import { describeProbeNetworkError, describeProbeStatus, type ProbeErrorDescription } from "../lib/probe-error";
import { aggregateUsageByModel, displayModelName, type ModelUsageAggregate } from "./model-merge";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageRow {
  userId: string;
  provider: string;
  model: string | null;
  context: string | null;
  keySource: string;
  keyRef: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Portion of costUsd taken from the transport's own billed amount (OpenRouter `usage.cost`). */
  billedCostUsd: number;
  /** Portion of costUsd derived from the app's price table — an estimate, labelled as one. */
  estimatedCostUsd: number;
  billedCalls: number;
  estimatedCalls: number;
  connectedAccountId: string | null;
  broker: string | null;
  environment: string | null;
  accountLabel: string | null;
  keyLabel: string | null;
  /** Irreversible short fingerprint (first 8 hex chars of SHA-256) — never a raw-key prefix/suffix. */
  keyFingerprint: string | null;
}

interface UsageData {
  sinceDays: number;
  operatorFallbackEnabled: boolean;
  totalCostUsd: number;
  billedCostUsd: number;
  estimatedCostUsd: number;
  operatorFundedCostUsd: number;
  operatorFundedTenants: string[];
  rows: UsageRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

// Headline totals show 2 decimals — a $34.8565 total reads as noise. Per-line-item
// costs keep fmtCost's 4dp (sub-cent precision matters for one call, not for a total).
function fmtTotalCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic (Claude)",
    xai: "xAI (Grok)",
    gemini: "Google (Gemini)",
    mistral: "Mistral",
    deepseek: "DeepSeek"
  };
  return map[provider] ?? provider;
}

function userLabel(userId: string): string {
  return userId === "local" ? "Primary User" : userId;
}

/**
 * How a cost figure was arrived at, for one row or one rollup.  "billed" means the number came
 * from the transport's own charge for that call; "estimated" means it was priced from the app's
 * model price table.  Never present a mixture as one authoritative number — say it is mixed.
 */
type CostBasis = "billed" | "estimated" | "mixed" | "none";

function costBasisOf(billedCalls: number, estimatedCalls: number): CostBasis {
  if (billedCalls > 0 && estimatedCalls > 0) return "mixed";
  if (billedCalls > 0) return "billed";
  if (estimatedCalls > 0) return "estimated";
  return "none";
}

const COST_BASIS_LABEL: Record<CostBasis, string> = {
  billed: "billed",
  estimated: "estimated",
  mixed: "part billed",
  none: ""
};

const COST_BASIS_TITLE: Record<CostBasis, string> = {
  billed: "Charged amount reported by OpenRouter for these calls.",
  estimated: "Estimated from the app's model price table.  Not a billed amount.",
  mixed: "Some calls report a charged amount; the rest are priced from the app's model price table.",
  none: ""
};

/** Small inline provenance tag.  Renders nothing when there is no cost to qualify. */
function CostBasisTag({ basis }: { basis: CostBasis }) {
  if (basis === "none") return null;
  return (
    <span className="con-chip" title={COST_BASIS_TITLE[basis]}>
      {COST_BASIS_LABEL[basis]}
    </span>
  );
}

function keySourceLabel(source: string): string {
  const map: Record<string, string> = {
    user: "User Key",
    operator: "Server Failover"
  };
  return map[source] ?? source;
}

// Human label for the account a usage row is attributed to. Account-less rows (e.g. chat, or
// pre-attribution history) read "Unattributed" rather than being hidden or mislabeled.
function accountLabelText(row: UsageRow): string {
  if (!row.connectedAccountId) return "Unattributed";
  const name = row.accountLabel ?? `acct ${row.connectedAccountId.slice(0, 8)}`;
  const broker = row.broker ? (row.environment ? `${row.broker} · ${row.environment}` : row.broker) : null;
  return broker ? `${name} (${broker})` : name;
}

// Group rows by (userId, provider, keyRef, account) → list of (model, context, ...) sub-rows, so
// spend is broken out per connected account/broker as well as per key.
function groupRows(rows: UsageRow[]): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = `${row.userId}||${row.provider}||${row.keyRef ?? "none"}||${row.connectedAccountId ?? "none"}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return groups;
}

// ── Components ────────────────────────────────────────────────────────────────

function KeyBadge({ row }: { row: UsageRow }) {
  // `keyFingerprint` is an irreversible SHA-256-derived hint, never a raw-key prefix/suffix —
  // Connections promises a stored key is never displayed again, and this view must honor that too.
  const display = row.keyFingerprint ? `#${row.keyFingerprint}` : null;
  const label = row.keyLabel ?? keySourceLabel(row.keySource);
  if (!display) {
    return (
      <span className="con-chip">
        <span className="opacity-60">key removed</span>
        <span className="text-[color:var(--con-faint)]">·</span>
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="con-chip">
      <span className="con-mono text-[color:var(--con-accent)]">{display}</span>
      <span className="text-[color:var(--con-faint)]">·</span>
      <span>{label}</span>
    </span>
  );
}

function AccountBadge({ row }: { row: UsageRow }) {
  const unattributed = !row.connectedAccountId;
  return (
    <span
      className="con-chip"
      title={unattributed ? "Not attributed to a connected account" : `Account: ${accountLabelText(row)}`}
    >
      <span className="text-[color:var(--con-faint)]">acct</span>
      <span className={unattributed ? "italic" : "font-medium text-[color:var(--con-fg)]"}>{accountLabelText(row)}</span>
    </span>
  );
}

function UsageGroupCard({ groupRows: rows }: { groupRows: UsageRow[] }) {
  const first = rows[0];
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalIn = rows.reduce((s, r) => s + r.promptTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.completionTokens, 0);
  const groupBasis = costBasisOf(
    rows.reduce((s, r) => s + r.billedCalls, 0),
    rows.reduce((s, r) => s + r.estimatedCalls, 0)
  );

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--con-fs-sm)] font-semibold">{userLabel(first.userId)}</span>
            <span className="con-chip">{providerLabel(first.provider)}</span>
            <KeyBadge row={first} />
            <AccountBadge row={first} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="con-num text-lg font-semibold">{fmtTotalCost(totalCost)}</div>
          <div className="flex items-center justify-end gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            <span>{totalCalls} call{totalCalls !== 1 ? "s" : ""}</span>
            <CostBasisTag basis={groupBasis} />
          </div>
        </div>
      </div>

      <div className="mb-2 flex gap-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        <span>In: <span className="con-mono text-[color:var(--con-fg)]">{fmtTokens(totalIn)}</span></span>
        <span>Out: <span className="con-mono text-[color:var(--con-fg)]">{fmtTokens(totalOut)}</span></span>
        <span>Total: <span className="con-mono text-[color:var(--con-fg)]">{fmtTokens(totalIn + totalOut)}</span></span>
      </div>

      {/* Per-model / per-context breakdown */}
      <div className="mt-2 space-y-1 border-t border-[color:var(--con-line)] pt-2">
        {rows
          .slice()
          .sort((a, b) => b.costUsd - a.costUsd)
          .map((r, i) => (
            <div key={i} className="flex items-center justify-between text-[length:var(--con-fs-xs)]">
              <div className="flex items-center gap-2 text-[color:var(--con-muted)]">
                {/* displayModelName strips the OpenRouter vendor prefix so a routed
                    "anthropic/claude-x" reads the same as the directly-called "claude-x". */}
                <span className="con-mono text-[color:var(--con-fg)]">{r.model ? displayModelName(r.model) : "—"}</span>
                <span className="text-[color:var(--con-faint)]">·</span>
                <span title={r.context ?? "unknown"}>{llmUsageContextLabel(r.context ?? "unknown")}</span>
                <span className="text-[color:var(--con-faint)]">·</span>
                <span>{r.calls} call{r.calls !== 1 ? "s" : ""}</span>
              </div>
              <div className="con-mono flex items-center gap-3 text-[color:var(--con-muted)]">
                <span title="prompt tokens">{fmtTokens(r.promptTokens)}↑</span>
                <span title="completion tokens">{fmtTokens(r.completionTokens)}↓</span>
                <span
                  className="text-[color:var(--con-fg)]"
                  title={COST_BASIS_TITLE[costBasisOf(r.billedCalls, r.estimatedCalls)]}
                >
                  {fmtCost(r.costUsd)}
                  {costBasisOf(r.billedCalls, r.estimatedCalls) === "billed" ? "" : "*"}
                </span>
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}

// "By model" merged view: one row per canonical model, combining OpenRouter-routed and
// direct-provider calls for the same underlying model into one total, with a per-provider
// breakdown so the pre-OpenRouter (direct) and OpenRouter portions stay visible. The raw
// ledger rows are never rewritten — this is a read-time aggregation only (see model-merge.ts).
function ModelBreakdownCard({ models }: { models: ModelUsageAggregate[] }) {
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="con-card-title">By model</span>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">merged across providers</span>
      </div>
      <p className="mb-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Calls for the same model are combined here whether they were routed through OpenRouter or sent
        directly to the provider.  The breakdown shows each route so earlier direct-provider usage stays visible.
      </p>
      <div className="space-y-1">
        {models.map((m) => {
          const multiRoute = m.providers.length > 1;
          return (
            <div key={m.canonicalId} className="border-t border-[color:var(--con-line)] pt-2 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between gap-3 text-[length:var(--con-fs-sm)]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="con-mono truncate font-medium text-[color:var(--con-fg)]">
                    {m.canonicalId === "" ? "—" : m.displayName}
                  </span>
                  {!multiRoute && (
                    <span className="con-chip" title="Only one route recorded for this model in this window">
                      {providerLabel(m.providers[0]!.provider)}
                    </span>
                  )}
                </div>
                <div className="con-num flex shrink-0 items-center gap-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                  <span>{m.calls} call{m.calls !== 1 ? "s" : ""}</span>
                  <span title="total tokens">{fmtTokens(m.totalTokens)}</span>
                  <span className="text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]">{fmtCost(m.costUsd)}</span>
                </div>
              </div>
              {multiRoute && (
                <div className="mt-1 space-y-0.5 pl-3">
                  {m.providers.map((p) => (
                    <div key={p.provider} className="flex items-center justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[color:var(--con-muted)]">
                          {p.provider === "openrouter" ? "via OpenRouter" : `${providerLabel(p.provider)} · direct`}
                        </span>
                        <span>· {p.calls} call{p.calls !== 1 ? "s" : ""}</span>
                      </span>
                      <span className="con-mono">{fmtCost(p.costUsd)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function LlmUsageClient({
  endpoint = "/api/admin/llm-usage",
  scope = "admin",
  title = "LLM Usage & Cost"
}: {
  endpoint?: string;
  scope?: "admin" | "user";
  /** h1 text. Defaults to the admin mount's own title; the console mount
   *  (/console/usage) overrides this to "Usage" so the h1 matches the nav
   *  rail label (destinationLabel in app/console/components/nav.tsx). */
  title?: string;
}) {
  const [days, setDays] = useState(30);
  const [operatorOnly, setOperatorOnly] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProbeErrorDescription | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sinceDays: String(days) });
      if (scope === "admin" && operatorOnly) params.set("operatorFundedOnly", "true");
      const res = await fetch(`${endpoint}?${params}`);
      if (!res.ok) {
        // "admin" scope hits requireAdmin-gated routes (a 403 means no admin identity);
        // "user" scope (/console/usage → /api/llm-usage) has no admin gate, so wording
        // there shouldn't claim operator access is the problem.
        setError(describeProbeStatus(res.status, scope === "admin" ? "operator" : "generic"));
        return;
      }
      setData(await res.json());
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, [days, endpoint, operatorOnly, scope]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Distinct accounts present in this window (incl. an "Unattributed" bucket) drive the filter.
  const accountOptions = data
    ? Array.from(new Map(data.rows.map((r) => [r.connectedAccountId ?? "unattributed", r] as const)).values())
        .map((r) => ({ value: r.connectedAccountId ?? "unattributed", label: accountLabelText(r) }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  const filteredRows = data
    ? data.rows.filter(
        (r) =>
          accountFilter === "all" ||
          (accountFilter === "unattributed" ? !r.connectedAccountId : r.connectedAccountId === accountFilter)
      )
    : [];
  const groups = groupRows(filteredRows);
  const groupList = Array.from(groups.entries())
    .map(([, rows]) => rows)
    .sort((a, b) =>
      b.reduce((s: number, r: UsageRow) => s + r.costUsd, 0) -
      a.reduce((s: number, r: UsageRow) => s + r.costUsd, 0)
    );
  const modelBreakdown = aggregateUsageByModel(filteredRows);
  const filteredTotalCost = filteredRows.reduce((s, r) => s + r.costUsd, 0);
  const filteredFailoverCost = filteredRows.filter((r) => r.keySource === "operator").reduce((s, r) => s + r.costUsd, 0);
  const filteredCalls = filteredRows.reduce((s, r) => s + r.calls, 0);
  const filteredTokens = filteredRows.reduce((s, r) => s + r.totalTokens, 0);
  // Cost provenance for the headline tile.  A total that mixes charged amounts with price-table
  // estimates must say so — the two are not the same kind of number and the estimate can drift
  // from real spend without limit.
  const filteredBilledCost = filteredRows.reduce((s, r) => s + r.billedCostUsd, 0);
  const filteredEstimatedCost = filteredRows.reduce((s, r) => s + r.estimatedCostUsd, 0);
  const filteredBilledCalls = filteredRows.reduce((s, r) => s + r.billedCalls, 0);
  const filteredEstimatedCalls = filteredRows.reduce((s, r) => s + r.estimatedCalls, 0);
  const filteredBasis = costBasisOf(filteredBilledCalls, filteredEstimatedCalls);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          {scope === "admin" ? "Per-key, per-model, per-context breakdown across all LLM calls." : "Your per-key, per-model, per-context LLM usage."}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          ariaLabel="Time window"
          options={WINDOW_OPTIONS.map((opt) => ({ value: String(opt.days), label: opt.label }))}
        />
        {scope === "admin" && (
          <div className="flex select-none items-center gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            <Toggle checked={operatorOnly} onChange={setOperatorOnly} label="Server-failover only" />
            Server-failover only
          </div>
        )}
        {accountOptions.length > 1 && (
          /* con-select is width:100% (unlayered CSS beats Tailwind's w-auto), so size via a wrapper. */
          <div className="w-56">
            <Select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              aria-label="Filter by account"
            >
              <option value="all">All accounts</option>
              {accountOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </div>
        )}
        <Btn variant="outline" size="sm" className="ml-auto" onClick={fetchData} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Btn>
      </div>

      {error && (
        <div
          className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]"
          title={error.rawLabel}
        >
          {error.message}
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="con-tile">
              <Stat
                label="Total cost"
                value={fmtTotalCost(filteredTotalCost)}
                sub={
                  filteredBasis === "mixed"
                    ? `${fmtTotalCost(filteredBilledCost)} billed + ${fmtTotalCost(filteredEstimatedCost)} estimated`
                    : filteredBasis === "estimated"
                      ? `estimated · ${accountFilter === "all" ? `last ${days}d` : `filtered · ${days}d`}`
                      : filteredBasis === "billed"
                        ? `billed · ${accountFilter === "all" ? `last ${days}d` : `filtered · ${days}d`}`
                        : accountFilter === "all"
                          ? `last ${days}d`
                          : `filtered · ${days}d`
                }
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Server failover"
                value={fmtTotalCost(filteredFailoverCost)}
                sub={data.operatorFallbackEnabled ? "failover on" : "failover off"}
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Key × account"
                value={String(groups.size)}
                sub={scope === "admin" ? "all visible" : "yours"}
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Total calls"
                value={fmtTokens(filteredCalls)}
                sub={`${fmtTokens(filteredTokens)} tokens`}
              />
            </div>
          </div>

          {/* By-model merged view (OpenRouter + direct combined per model) */}
          {modelBreakdown.length > 0 && <ModelBreakdownCard models={modelBreakdown} />}

          {/* Per-key / per-account detail */}
          {groupList.length === 0 ? (
            <div className="py-12 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No usage recorded in this window.</div>
          ) : (
            <div className="space-y-3">
              {groupList.map((rows, i) => (
                <UsageGroupCard key={i} groupRows={rows} />
              ))}
            </div>
          )}

          {filteredEstimatedCalls > 0 && (
            <div className="con-tile text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
              An asterisk marks a cost this app priced from its own model price table rather than a
              charge the provider reported.  OpenRouter returns the amount it charged on every
              response, so those lines are the real figure; direct-provider calls and calls recorded
              before cost reporting was stored are priced from the table and can drift from the
              provider&rsquo;s invoice.
            </div>
          )}

          {data.operatorFundedTenants.length > 0 && (
            <div className="con-tile text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              Server-failover usage: {data.operatorFundedTenants.map(userLabel).join(", ")}
            </div>
          )}
        </>
      )}

      {loading && !data && (
        <div className="py-12 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading…</div>
      )}
    </div>
  );
}
