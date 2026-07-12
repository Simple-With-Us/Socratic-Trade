"use client";

/** Scan — the market scan table plus the Smart Money feeds.
 *
 *  Data honesty rules carried over from the legacy dashboard:
 *  - The table shows the newest of (this page's own /api/scan refresh, the
 *    scan captured at the last strategy run). Freshness is labeled, never
 *    implied.
 *  - `MarketScan.source` is a `+`-joined list of the providers that actually
 *    contributed this run — displayed through the shared plain-English source
 *    formatter, never as backend ids.
 *  - A failed refresh is a non-blocking notice; the last good scan stays up.
 *  - Missing data renders as "—"; P/E's "n/a" means negative/zero earnings. */

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { MarketScan } from "@/lib/types";
import { formatSourceList } from "@/lib/dashboard-ui";
import { DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT } from "@/lib/scan-settings";
import { activeConnectedAccount } from "../lib/derive";
import { cx, fmtExact, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { Ago, Btn, Card, Chip, Empty } from "../ui/primitives";
import { useToast } from "../ui/toast";
import { ScanTable } from "./scan-table";
import { SmartMoneySection } from "./smart-money";
import { asFullMarketScan, newestScan, useLiveScan } from "./use-live-scan";

type Tab = "scan" | "smart";

export default function ScanPage() {
  const { snapshot } = useConsoleData();
  const toast = useToast();
  // Scope the live scan to the active account: /api/scan runs against the
  // server's CURRENT active policy, so switching accounts in the chrome (this
  // page stays mounted) must drop and refetch a scan taken under the previous
  // account — its universe and "held" chips would otherwise keep winning the
  // newest-scan comparison below.
  const scopeKey = snapshot
    ? `${activeConnectedAccount(snapshot)?.id ?? ""}:${snapshot.policy.accountNumber ?? ""}`
    : null;
  const live = useLiveScan(scopeKey);
  const [tab, setTab] = useState<Tab>("scan");

  // Validate the run-captured scan before trusting it — historical/compact
  // strategy_run audits can carry a partial shape the table can't render.
  const runScan = asFullMarketScan(snapshot?.latestStrategyRun?.marketScan);
  const scan: MarketScan | null = newestScan(live.scan, runScan);
  const smartCount = (snapshot?.smartMoney?.congress?.length ?? 0) + (snapshot?.smartMoney?.insider?.length ?? 0);

  if (!snapshot) return null;

  const onRefresh = async () => {
    const started = Date.now();
    const outcome = await live.refresh();
    if (outcome.status === "ok") {
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      toast.push(
        "pos",
        "Scan refreshed",
        `${outcome.scan.topCandidates.length} candidate${outcome.scan.topCandidates.length === 1 ? "" : "s"} from ${outcome.scan.scannedSymbols} scanned symbols in ${secs}s.`
      );
    } else if (outcome.status === "error") {
      toast.push("neg", "Scan refresh failed", `${outcome.message} The last good scan stays on screen.`);
    }
  };

  const isFresh = scan !== null && scan === live.scan;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {/* Header: title · freshness · last-scanned · refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Scan</h1>
        {scan && (
          <Chip
            tone={isFresh ? "accent" : "muted"}
            title={
              isFresh
                ? "This scan was run from this page just now — the freshest view available."
                : "Captured during the latest strategy run. Hit Refresh scan for a current view."
            }
          >
            {isFresh ? "fresh" : "last run"}
            {scan.cached ? " · cached" : ""}
          </Chip>
        )}
        {scan && (
          <span
            className="cursor-default text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
            title="When this scan's data was generated."
          >
            scanned <Ago iso={scan.generatedAt} />
          </span>
        )}
        <div className="flex-1" />
        <Btn
          size="sm"
          variant="outline"
          onClick={() => void onRefresh()}
          disabled={live.refreshing}
          title="Run a fresh market scan now — re-screens the universe and re-pulls quotes and enrichment. Read-only: it never places trades. Can take up to ~25 seconds when caches are cold."
        >
          <RefreshCw size={13} className={cx(live.refreshing && "animate-spin")} aria-hidden />
          {live.refreshing ? "Scanning…" : "Refresh scan"}
        </Btn>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 self-start rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface)] p-1">
        {(
          [
            {
              id: "scan" as Tab,
              label: scan ? `Market scan (${scan.topCandidates.length})` : "Market scan",
              title: "Screened and scored candidates from the market scan, with per-field source attribution."
            },
            {
              id: "smart" as Tab,
              label: smartCount > 0 ? `Smart money (${smartCount})` : "Smart money",
              title: "Recently disclosed congressional trades and insider (Form 4) activity — everything on file, not just scan overlaps."
            }
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            title={t.title}
            className={cx(
              "rounded-md px-3 py-1 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
              tab === t.id
                ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                : "text-[color:var(--con-muted)] hover:text-[color:var(--con-fg)]"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "scan" ? (
        <MarketScanTab
          scan={scan}
          refreshing={live.refreshing}
          error={live.error}
          onRefresh={() => void onRefresh()}
          policyLimit={snapshot.policy.marketScanCandidateLimit}
        />
      ) : (
        <SmartMoneySection snapshot={snapshot} />
      )}
    </div>
  );
}

function MarketScanTab({
  scan,
  refreshing,
  error,
  onRefresh,
  policyLimit
}: {
  scan: MarketScan | null;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  policyLimit?: number;
}) {
  // No scan at all: friendly empty state that explains how to get one.
  if (!scan) {
    return (
      <Card>
        {refreshing ? (
          <Empty>Scanning the market — fetching quotes and enrichment for your universe. This can take up to ~25 seconds.</Empty>
        ) : (
          <>
            {error && (
              <p className="mb-1 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {error}
              </p>
            )}
            <Empty>
              No market scan yet. Run one now with the button below, or it appears automatically after the next strategy
              run. If your universe is empty, add symbols or choose a base index in Settings first.
            </Empty>
            <div className="flex justify-center pb-2">
              <Btn variant="primary" onClick={onRefresh} title="Run a fresh market scan now. Read-only: it never places trades.">
                Run scan
              </Btn>
            </div>
          </>
        )}
      </Card>
    );
  }

  const limit = scan.candidateLimit ?? policyLimit ?? DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT;
  const outliers = scan.outlierCandidateCount ?? 0;
  const sources = formatSourceList(scan.source);
  const warningText =
    scan.warnings.length > 1 ? `${scan.warnings[0]} (+${scan.warnings.length - 1} more — hover for all)` : scan.warnings[0];

  return (
    <div className="flex flex-col gap-3">
      {/* A failed refresh never contradicts a populated table — muted notice only. */}
      {error && (
        <p className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          {error} Showing the last good scan from {fmtExact(scan.generatedAt)}.
        </p>
      )}
      {scan.warnings.length > 0 && (
        <p
          className="cursor-default rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
          title={scan.warnings.join("\n")}
        >
          {warningText}
        </p>
      )}

      <Card
        title={
          <span title="Every symbol the screener returned quotes for this run, ranked by scan score.">
            Market scan candidates
          </span>
        }
        action={
          sources ? (
            <span
              className="max-w-[55%] cursor-default truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
              title={`Every provider that actually contributed data this run: ${sources}.`}
            >
              Sources: {sources}
            </span>
          ) : undefined
        }
        padded={false}
      >
        <p
          className="cursor-default px-4 pb-2 pt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title={`Scanned ${typeof scan.scannedSymbols === "number" ? scan.scannedSymbols : "an unrecorded number of"} symbols; ${typeof scan.returnedQuotes === "number" ? scan.returnedQuotes : "an unrecorded number of"} returned quotes${sources ? ` from ${sources}` : ""}; the top ${scan.topCandidates.length} (cap ${limit}) were enriched and scored${outliers > 0 ? `, including ${outliers} below-cutoff outlier${outliers === 1 ? "" : "s"} kept for notability` : ""}.`}
        >
          {typeof scan.returnedQuotes === "number" ? scan.returnedQuotes : EM_DASH} quotes · {scan.topCandidates.length}/{limit} candidates
          {outliers > 0 ? ` · ${outliers} outlier${outliers === 1 ? "" : "s"}` : ""}
          {typeof scan.breadthPct === "number" && (
            <span title="Market breadth — the share of the full screened universe advancing today. A quick risk-on/risk-off gauge.">
              {" "}
              · breadth {scan.breadthPct.toFixed(0)}%
            </span>
          )}
        </p>
        {scan.topCandidates.length === 0 ? (
          <Empty>
            The scan ran but returned no candidates — the universe may be empty or no provider returned quotes. Add
            symbols or choose a base index in Settings, then refresh.
          </Empty>
        ) : (
          <ScanTable scan={scan} />
        )}
      </Card>
    </div>
  );
}
