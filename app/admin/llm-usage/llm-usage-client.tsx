"use client";

import { useEffect, useState, useCallback } from "react";
import { Card } from "../../ui/primitives";

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
  keyLabel: string | null;
  keyLast4: string | null;
  keyMasked: string | null;
}

interface UsageData {
  sinceDays: number;
  operatorFallbackEnabled: boolean;
  totalCostUsd: number;
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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function contextLabel(ctx: string | null): string {
  if (!ctx) return "unknown";
  const map: Record<string, string> = {
    chat: "Chat",
    strategy: "Strategy",
    "strategy-bear": "Strategy (bear)",
    "strategy-tuning": "Tuning",
    "red-team": "Red-team",
    "post-mortem": "Post-mortem",
    "proposal-revalidation": "Revalidation",
  };
  return map[ctx] ?? ctx;
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

function keySourceLabel(source: string): string {
  const map: Record<string, string> = {
    user: "User Key",
    operator: "Server Failover"
  };
  return map[source] ?? source;
}

// Group rows by (userId, provider, keyRef) → list of (model, context, ...) sub-rows.
function groupRows(rows: UsageRow[]): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = `${row.userId}||${row.provider}||${row.keyRef ?? "none"}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return groups;
}

// ── Components ────────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4 flex flex-col gap-1">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-fg">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function KeyBadge({ row }: { row: UsageRow }) {
  const display = row.keyMasked ?? (row.keyLast4 ? `...${row.keyLast4}` : null);
  const label = row.keyLabel ?? keySourceLabel(row.keySource);
  if (!display) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted bg-surface-2 border border-line rounded px-2 py-0.5">
        <span className="opacity-50">key removed</span>
        <span className="text-muted/75">·</span>
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs bg-surface-2 border border-line rounded px-2 py-0.5 font-mono">
      <span className="text-accent">{display}</span>
      <span className="text-muted/75">·</span>
      <span className="text-muted font-sans">{label}</span>
    </span>
  );
}

function UsageGroupCard({ groupRows: rows }: { groupRows: UsageRow[] }) {
  const first = rows[0];
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalIn = rows.reduce((s, r) => s + r.promptTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.completionTokens, 0);

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-fg">{userLabel(first.userId)}</span>
            <span className="text-xs text-muted bg-surface-2 border border-line rounded px-1.5 py-0.5">
              {providerLabel(first.provider)}
            </span>
            <KeyBadge row={first} />
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-semibold text-fg">{fmtCost(totalCost)}</div>
          <div className="text-xs text-muted">{totalCalls} call{totalCalls !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <div className="text-xs text-muted mb-2 flex gap-4">
        <span>In: <span className="text-fg font-mono">{fmtTokens(totalIn)}</span></span>
        <span>Out: <span className="text-fg font-mono">{fmtTokens(totalOut)}</span></span>
        <span>Total: <span className="text-fg font-mono">{fmtTokens(totalIn + totalOut)}</span></span>
      </div>

      {/* Per-model / per-context breakdown */}
      <div className="border-t border-line mt-2 pt-2 space-y-1">
        {rows
          .slice()
          .sort((a, b) => b.costUsd - a.costUsd)
          .map((r, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-muted">
                <span className="font-mono text-fg/80">{r.model ?? "—"}</span>
                <span className="text-muted/75">·</span>
                <span>{contextLabel(r.context)}</span>
                <span className="text-muted/60">·</span>
                <span>{r.calls} call{r.calls !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex items-center gap-3 font-mono text-muted">
                <span title="prompt tokens">{fmtTokens(r.promptTokens)}↑</span>
                <span title="completion tokens">{fmtTokens(r.completionTokens)}↓</span>
                <span className="text-fg">{fmtCost(r.costUsd)}</span>
              </div>
            </div>
          ))}
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
  scope = "admin"
}: {
  endpoint?: string;
  scope?: "admin" | "user";
}) {
  const [days, setDays] = useState(30);
  const [operatorOnly, setOperatorOnly] = useState(false);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sinceDays: String(days) });
      if (scope === "admin" && operatorOnly) params.set("operatorFundedOnly", "true");
      const res = await fetch(`${endpoint}?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [days, endpoint, operatorOnly, scope]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const groups = data ? groupRows(data.rows) : new Map<string, UsageRow[]>();
  const groupList = Array.from(groups.entries())
    .map(([, rows]) => rows)
    .sort((a, b) =>
      b.reduce((s: number, r: UsageRow) => s + r.costUsd, 0) -
      a.reduce((s: number, r: UsageRow) => s + r.costUsd, 0)
    );

  return (
    <div className="min-h-screen bg-base text-fg p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-fg">LLM Usage &amp; Cost</h1>
        <p className="text-sm text-muted mt-1">
          {scope === "admin" ? "Per-key, per-model, per-context breakdown across all LLM calls." : "Your per-key, per-model, per-context LLM usage."}
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setDays(opt.days)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                days === opt.days
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {scope === "admin" && (
          <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={operatorOnly}
              onChange={(e) => setOperatorOnly(e.target.checked)}
              className="rounded border-line"
            />
            Server-failover only
          </label>
        )}
        <button
          onClick={fetchData}
          disabled={loading}
          className="ml-auto text-xs text-muted hover:text-fg border border-line rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-down bg-down/10 border border-down/20 rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <SummaryCard
              label="Total cost"
              value={fmtCost(data.totalCostUsd)}
              sub={`last ${days}d`}
            />
            <SummaryCard
              label="Server failover"
              value={fmtCost(data.operatorFundedCostUsd)}
              sub={data.operatorFallbackEnabled ? "failover on" : "failover off"}
            />
            <SummaryCard
              label="Unique keys"
              value={String(groups.size)}
              sub={scope === "admin" ? "all visible keys" : "your keys"}
            />
            <SummaryCard
              label="Total calls"
              value={fmtTokens(data.rows.reduce((s, r) => s + r.calls, 0))}
              sub={`${fmtTokens(data.rows.reduce((s, r) => s + r.totalTokens, 0))} tokens`}
            />
          </div>

          {/* Per-key groups */}
          {groupList.length === 0 ? (
            <div className="text-sm text-muted text-center py-12">No usage recorded in this window.</div>
          ) : (
            <div className="space-y-3">
              {groupList.map((rows, i) => (
                <UsageGroupCard key={i} groupRows={rows} />
              ))}
            </div>
          )}

          {data.operatorFundedTenants.length > 0 && (
            <div className="mt-4 text-xs text-muted bg-surface-2 border border-line rounded-lg p-3">
              Server-failover usage: {data.operatorFundedTenants.map(userLabel).join(", ")}
            </div>
          )}
        </>
      )}

      {loading && !data && (
        <div className="text-sm text-muted text-center py-12">Loading…</div>
      )}
    </div>
  );
}
