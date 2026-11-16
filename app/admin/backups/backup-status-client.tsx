"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Chip, Dot, Btn, Toggle, type ChipTone } from "../../console/ui/primitives";
import { DatabaseBackup, RefreshCw, ShieldCheck, ShieldAlert, HelpCircle, Hourglass, Layers, Layers2, Clock, EyeOff, Cloud, HardDrive } from "lucide-react";
import { asRecord, readText } from "@/lib/server-metrics-shapes";
import { SENTENCE_GAP } from "../../console/lib/format";

/**
 * Owner copy rule: two spaces between sentences, and HTML must actually preserve the gap.
 * Prose reaches this panel both as local constants and as server-authored `detail` strings
 * (which keep plain double spaces so the JSON/plain-text contract stays clean), so the
 * substitution happens once here at render time.
 */
function sentenceGaps(text: string): string {
  return text.replace(/ {2}/g, SENTENCE_GAP);
}

// Mirrors src/lib/runtime-health.ts's LitestreamCompactionTier ("0"|"1"|"2"|"3"|"9") — kept as a
// plain string union here (not imported) because this file is a client component and the
// source of truth is a server-only lib; the API response is the actual contract, parsed
// defensively below like every other admin panel that reads an untrusted JSON boundary.
type TierId = "0" | "1" | "2" | "3" | "9";
type TierSource = "local-ltx" | "remote-inventory";
type RemoteInventoryState = "ok" | "partial" | "failed" | "skipped" | "missing" | "stale";

// Three states, deliberately: "we measured it and here are its numbers" (known), "we measured it
// and it holds nothing" (empty), and "we cannot see this level at all" (not-observable). The
// last one used to be reported as a bare "unknown", which read as coverage when it was really
// blindness — see the 2026-08-12 rollout note. "empty" was split out of not-observable on
// 2026-08-14 for the mirror-image reason: a successful listing that returns zero is a
// measurement, and filing it under "cannot see" hid a six-day deep-compaction outage.
type TierEmptyVerdict = "wedged" | "upstream-wedged" | "expected";

interface TierFreshness {
  tier: TierId;
  label: string;
  state: "known" | "empty" | "not-observable";
  source?: TierSource;
  newestActivityAt?: string;
  newestTxid?: string | null;
  ageSeconds?: number;
  thresholdSeconds: number;
  degraded?: boolean;
  verdict?: TierEmptyVerdict;
  reason?: string;
  detail?: string;
}

interface BackupStatusData {
  liveMode: boolean;
  statePath: string;
  overall: {
    state: "known" | "unknown";
    status: string | null;
    lastSyncAt: string | null;
    ageSeconds: number | null;
    source: "ipc" | "file" | "none";
    degraded: boolean;
    reasons: string[];
  };
  tiers: TierFreshness[];
  tiersDegraded: boolean;
  coverage: {
    observed: number;
    notObservable: number;
    total: number;
    remoteInventoryState: RemoteInventoryState;
    remoteInventoryCollectedAt: string | null;
  };
  asOf: string;
}

const KNOWN_TIER_IDS: readonly TierId[] = ["0", "1", "2", "3", "9"];
const REMOTE_INVENTORY_STATES: readonly RemoteInventoryState[] = ["ok", "partial", "failed", "skipped", "missing", "stale"];

function parseTier(value: unknown): TierFreshness | undefined {
  const record = asRecord(value);
  const tier = record?.tier;
  if (typeof tier !== "string" || !KNOWN_TIER_IDS.includes(tier as TierId)) return undefined;
  const label = readText(record?.label) ?? `Level ${tier}`;
  const thresholdSeconds = typeof record?.thresholdSeconds === "number" && Number.isFinite(record.thresholdSeconds)
    ? record.thresholdSeconds
    : 0;

  const notObservable = (detail: string, reason?: string): TierFreshness => ({
    tier: tier as TierId,
    label,
    state: "not-observable",
    thresholdSeconds,
    reason: reason ?? readText(record?.reason) ?? undefined,
    detail
  });

  // Handled BEFORE the not-observable fallthrough: an "empty" row that fell through would render
  // as a warn-toned "Not observable", which is the wrong tone AND the wrong word for a level we
  // listed successfully and found wedged.
  if (record?.state === "empty") {
    const verdict = record?.verdict;
    return {
      tier: tier as TierId,
      label,
      state: "empty",
      source: record?.source === "local-ltx" ? "local-ltx" : "remote-inventory",
      thresholdSeconds,
      verdict: verdict === "wedged" || verdict === "upstream-wedged" ? verdict : "expected",
      degraded: record?.degraded === true,
      reason: readText(record?.reason) ?? undefined,
      detail: readText(record?.detail) ?? "This compaction level holds no objects in the replica."
    };
  }

  if (record?.state !== "known") {
    return notObservable(
      readText(record?.detail) ?? "This compaction level cannot be observed from the app right now."
    );
  }

  const ageSeconds = typeof record?.ageSeconds === "number" && Number.isFinite(record.ageSeconds)
    ? record.ageSeconds
    : undefined;
  const newestActivityAt = readText(record?.newestActivityAt);
  if (ageSeconds === undefined || !newestActivityAt) {
    // Malformed "known" row (missing required fields) — say so rather than guess a verdict.
    return notObservable(
      "The backup status endpoint reported this level as measured but omitted its timestamp, so no verdict is shown.",
      "malformed-row"
    );
  }
  return {
    tier: tier as TierId,
    label,
    state: "known",
    source: record?.source === "remote-inventory" ? "remote-inventory" : "local-ltx",
    newestActivityAt,
    newestTxid: readText(record?.newestTxid) ?? null,
    ageSeconds,
    thresholdSeconds,
    degraded: record?.degraded === true
  };
}

function parseBackupStatus(value: unknown): BackupStatusData | undefined {
  const root = asRecord(value);
  const overallRaw = asRecord(root?.overall);
  const statePath = readText(root?.statePath);
  const asOf = readText(root?.asOf);
  if (!root || !overallRaw || !statePath || !asOf || !Number.isFinite(Date.parse(asOf))) return undefined;

  const overallState = overallRaw.state === "known" ? "known" : "unknown";
  const source = overallRaw.source === "ipc" || overallRaw.source === "file" ? overallRaw.source : "none";
  const reasons = Array.isArray(overallRaw.reasons)
    ? overallRaw.reasons.filter((r): r is string => typeof r === "string")
    : [];
  const overallAgeSeconds = typeof overallRaw.ageSeconds === "number" && Number.isFinite(overallRaw.ageSeconds)
    ? overallRaw.ageSeconds
    : null;

  const tiersRaw = Array.isArray(root.tiers) ? root.tiers : [];
  const tiers = tiersRaw.map(parseTier).filter((t): t is TierFreshness => Boolean(t));
  // Missing/malformed tiers array from a future incompatible API shape — degrade to "no tier
  // data" rather than render a guessed/partial grid.
  if (tiers.length !== KNOWN_TIER_IDS.length) return undefined;

  const coverageRaw = asRecord(root.coverage);
  const remoteInventoryState = REMOTE_INVENTORY_STATES.includes(coverageRaw?.remoteInventoryState as RemoteInventoryState)
    ? (coverageRaw?.remoteInventoryState as RemoteInventoryState)
    : "missing";
  const coverage = {
    observed: typeof coverageRaw?.observed === "number" && Number.isFinite(coverageRaw.observed)
      ? coverageRaw.observed
      // A level we listed and found empty IS observed — see the server-side note on
      // `observedTiers` in src/lib/runtime-health.ts.
      : tiers.filter((t) => t.state === "known" || t.state === "empty").length,
    notObservable: typeof coverageRaw?.notObservable === "number" && Number.isFinite(coverageRaw.notObservable)
      ? coverageRaw.notObservable
      : tiers.filter((t) => t.state === "not-observable").length,
    total: tiers.length,
    remoteInventoryState,
    remoteInventoryCollectedAt: readText(coverageRaw?.remoteInventoryCollectedAt) ?? null
  };

  return {
    liveMode: root.liveMode === true,
    statePath,
    overall: {
      state: overallState,
      status: readText(overallRaw.status) ?? null,
      lastSyncAt: readText(overallRaw.lastSyncAt) ?? null,
      ageSeconds: overallAgeSeconds,
      source,
      degraded: overallRaw.degraded === true,
      reasons
    },
    tiers,
    tiersDegraded: root.tiersDegraded === true,
    coverage,
    asOf
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

const TIER_ICON: Record<TierId, React.ComponentType<{ size?: number | string; className?: string }>> = {
  "0": RefreshCw,
  "1": Layers,
  "2": Layers2,
  "3": Hourglass,
  "9": DatabaseBackup
};

const TIER_DESCRIPTION: Record<TierId, string> = {
  "0": "Raw WAL pages streamed to Backblaze B2 continuously (litestream.coolify.yml syncs every 60s).  The fastest-moving signal — it proves the app is writing and Litestream is alive, but a healthy level 0 does NOT prove compaction or snapshots are working.  This is the only level Litestream keeps on local disk, so it is measured in real time.",
  "1": "Periodic compaction merges level-0 segments into a denser replica.  Runs on Litestream's own internal cadence, not continuously — quiet gaps between runs are normal, a gap past the threshold below while level 0 keeps advancing is not.  A stuck compactor here ran undetected in production for 27+ hours on 2026-08-11.",
  "2": "Second-stage compaction merging level-1 output into larger segments (5-minute monitor; output only appears when enough level-1 input has accumulated, so quiet stretches are normal).  The 2026-08-12 production wedge lived exactly here — a byte-identical \"non-contiguous transaction ids\" retry that no local-file monitor could ever have seen.",
  "3": "Third-stage rollup on an hourly monitor — same accumulation caveat as level 2, watched for the same reason: any level can wedge independently while every other level stays green.",
  "9": "Full daily snapshot (`snapshot.interval: 24h` in litestream.coolify.yml) — the point-in-time restore floor if every incremental LTX file were lost."
};

const TIER_SOURCE_LABEL: Record<TierSource, string> = {
  "local-ltx": "Local LTX cache",
  "remote-inventory": "Replica inventory"
};

const REMOTE_INVENTORY_NOTE: Record<RemoteInventoryState, string> = {
  ok: "All remote compaction levels were listed successfully.",
  partial: "Some remote compaction levels could not be listed.  The levels marked below are not being watched.",
  failed: "The replica inventory could not list any remote compaction level, so levels 1, 2, 3 and 9 are unwatched.",
  skipped: "The replica inventory does not run in this environment (no Litestream binary, config, or replica credentials), so only level 0 is watched.",
  missing: "The replica inventory has not run yet in this process, so levels 1, 2, 3 and 9 are not being watched yet.",
  stale: "The last replica inventory is too old to trust, so its levels are reported as unobservable rather than graded on frozen numbers."
};

function tierTone(tier: TierFreshness): ChipTone {
  if (tier.state === "not-observable") return "warn";
  if (tier.state === "empty") return tier.degraded ? "neg" : "warn";
  return tier.degraded ? "neg" : "pos";
}

function tierStatusLabel(tier: TierFreshness): string {
  if (tier.state === "not-observable") return "Not observable";
  if (tier.state === "empty") return tier.degraded ? "Wedged" : "Empty";
  return tier.degraded ? "Stale" : "Healthy";
}

function overallTone(overall: BackupStatusData["overall"]): ChipTone {
  if (overall.state === "unknown") return "muted";
  return overall.degraded ? "neg" : "pos";
}

export function BackupStatusClient() {
  const [data, setData] = useState<BackupStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/backup-status");
      const json: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        setError(readText(asRecord(json)?.error) || `Failed to load backup status (HTTP ${res.status}).`);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const parsed = parseBackupStatus(json);
      if (parsed) {
        setData(parsed);
        setError(null);
      } else {
        setError("The backup status endpoint returned malformed data.");
      }
    } catch (err) {
      console.error(err);
      setError("Unable to reach the backup status endpoint.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Deferred via setTimeout(0) rather than called directly in the effect body — matches the
    // server-metrics-client.tsx precedent, which avoids the react-hooks/set-state-in-effect
    // cascading-render warning for this exact "kick off the initial fetch on mount" shape.
    const timer = window.setTimeout(() => {
      void fetchStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchStatus]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => void fetchStatus(), 30000);
    return () => clearInterval(timer);
  }, [autoPoll, fetchStatus]);

  if (loading) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
        <RefreshCw className="h-8 w-8 animate-spin text-[color:var(--con-accent)]" />
        <span className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Reading backup replication state...</span>
      </div>
    );
  }

  const anyDegraded = data ? (data.overall.degraded || data.tiersDegraded) : false;

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Backup Status</h1>
            {data && (
              <Chip tone={anyDegraded ? "neg" : data.coverage.notObservable > 0 ? "warn" : "pos"}>
                {anyDegraded
                  ? "ATTENTION NEEDED"
                  : data.coverage.notObservable > 0
                    ? "PARTIAL COVERAGE"
                    : "HEALTHY"}
              </Chip>
            )}
            {data?.liveMode === false && <Chip tone="warn">NON-LIVE DB_BOOTSTRAP</Chip>}
          </div>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Litestream SQLite replication to Backblaze B2, broken out per compaction tier.
          </p>
          {data && (
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              As of {new Date(data.asOf).toLocaleString(undefined, { timeZone: "America/Chicago" })} &middot; state dir <code>{data.statePath}</code>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 self-start max-sm:w-full">
          <div className="flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)] max-sm:mr-auto">
            <Toggle checked={autoPoll} onChange={setAutoPoll} label="Auto-refresh every 30 seconds" />
            Auto-refresh (30s)
          </div>
          <Btn
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchStatus();
            }}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Btn>
        </div>
      </header>

      {error && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
          <span className="font-semibold">Error:</span> {error}
          {data ? " Showing the last successfully loaded snapshot below." : ""}
        </div>
      )}

      {!data ? null : (
        <>
          {/* Overall replication signal (the pre-existing /api/health litestream* fields) */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                {data.overall.degraded ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
                Replication Daemon (IPC)
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Dot tone={overallTone(data.overall)} pulse={data.overall.state === "unknown"} />
                <span className="font-semibold">
                  {data.overall.state === "unknown"
                    ? "Unavailable"
                    : data.overall.status ?? "unknown"}
                </span>
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Source: <span className="con-num">{data.overall.source}</span>
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Last sync age: <span className="con-num">{data.overall.ageSeconds === null ? "n/a" : formatDuration(data.overall.ageSeconds)}</span>
              </div>
            </div>
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              This reads litestream&apos;s own IPC <code>/list</code> reply — it reports the database&apos;s overall
              last-sync time. That time tracks level 0 (below) and stays fresh even when a higher compaction
              level is stuck, which is exactly the gap the per-tier breakdown below exists to close.
            </p>
            {data.overall.reasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.overall.reasons.map((reason) => (
                  <Chip key={reason} tone="neg">{reason}</Chip>
                ))}
              </div>
            )}
          </Card>

          {/* Coverage banner. "HEALTHY" must never be able to mean "we looked at one level and
              are blind to four" — that misreading is the whole reason this panel was rebuilt. */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <EyeOff className="h-4 w-4" /> Monitoring Coverage
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <Dot tone={data.coverage.notObservable === 0 ? "pos" : "warn"} />
                <span className="font-semibold">
                  {data.coverage.observed} of {data.coverage.total} compaction levels observed
                </span>
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Replica inventory: <span className="con-num">{data.coverage.remoteInventoryState}</span>
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                Collected:{" "}
                <span className="con-num">
                  {data.coverage.remoteInventoryCollectedAt
                    ? new Date(data.coverage.remoteInventoryCollectedAt).toLocaleString(undefined, { timeZone: "America/Chicago" })
                    : "never"}
                </span>
              </div>
            </div>
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              {sentenceGaps(REMOTE_INVENTORY_NOTE[data.coverage.remoteInventoryState])}
              {SENTENCE_GAP}
              Level 0 is read from local disk in real time.{SENTENCE_GAP}Levels 1, 2, 3 and 9 exist
              only in the remote replica, so they are graded from an inventory the scheduler
              refreshes every 30 minutes rather than on every page load.
            </p>
          </Card>

          {/* Per-tier breakdown */}
          <div className="grid gap-4 lg:grid-cols-3">
            {data.tiers.map((tier) => {
              const Icon = TIER_ICON[tier.tier];
              return (
                <Card
                  key={tier.tier}
                  title={
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-4 w-4" /> {tier.label}
                      <span className="text-[color:var(--con-faint)] font-normal">(level {tier.tier})</span>
                    </span>
                  }
                >
                  <div className="flex items-center gap-2">
                    <Dot tone={tierTone(tier)} pulse={false} />
                    <span className="font-semibold">{tierStatusLabel(tier)}</span>
                    {tier.state !== "not-observable" && tier.source && (
                      <span className="ml-auto flex items-center gap-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        {tier.source === "local-ltx" ? <HardDrive size={11} /> : <Cloud size={11} />}
                        {TIER_SOURCE_LABEL[tier.source]}
                      </span>
                    )}
                    {tier.state === "not-observable" && (
                      <EyeOff size={12} className="ml-auto text-[color:var(--con-faint)]" />
                    )}
                  </div>

                  {tier.state !== "known" ? (
                    <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                      {sentenceGaps(tier.detail ?? "")}
                    </p>
                  ) : (
                    <dl className="mt-3 space-y-1.5 text-[length:var(--con-fs-xs)]">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[color:var(--con-muted)]">Last activity</dt>
                        <dd className="con-num">
                          {new Date(tier.newestActivityAt!).toLocaleString(undefined, { timeZone: "America/Chicago" })}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[color:var(--con-muted)]">Age</dt>
                        <dd className="con-num">{formatDuration(tier.ageSeconds!)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="flex items-center gap-1 text-[color:var(--con-muted)]"><Clock size={11} /> Threshold</dt>
                        <dd className="con-num">{formatDuration(tier.thresholdSeconds)}</dd>
                      </div>
                      {tier.newestTxid && (
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-[color:var(--con-muted)]">Newest txid</dt>
                          <dd className="con-num">{tier.newestTxid}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                  <p className="mt-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                    {sentenceGaps(TIER_DESCRIPTION[tier.tier])}
                  </p>
                </Card>
              );
            })}
          </div>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <HelpCircle className="h-4 w-4" /> Why per-tier detection
              </span>
            }
          >
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              Litestream 0.5.x replicates SQLite in several independently-cadenced compaction
              levels.{SENTENCE_GAP}The replication daemon&apos;s own IPC status (above) and the
              public <code>/api/health</code> probe both only reflect the database&apos;s overall
              last-sync time, which tracks level 0.{SENTENCE_GAP}A higher level can silently stop
              advancing for days while level 0 keeps succeeding every minute &mdash; that is what
              happened on 2026-08-11 (level 1, 27+ hours) and again on 2026-08-12 (level 2).
            </p>
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              Only level 0 has a local <code>ltx/0/</code> directory to read; Litestream compacts
              levels 1, 2, 3 and 9 straight into the remote replica and keeps nothing on
              disk.{SENTENCE_GAP}Those levels are therefore graded from a scheduled inventory of the
              replica itself, and a level with no usable signal says &ldquo;not observable&rdquo;
              with a reason instead of showing a blank verdict that reads like
              health.{SENTENCE_GAP}A level counts as wedged only when it has fallen past its
              threshold <em>while level 0 kept advancing</em>, so an idle database never raises a
              false alarm.
            </p>
            <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              A level that lists successfully and holds <em>nothing</em> is shown as
              &ldquo;Empty&rdquo; rather than as a level we cannot see.{SENTENCE_GAP}It is called
              wedged only when the level below it is still producing and holds a backlog spanning
              more wall clock than this level&apos;s threshold &mdash; Litestream offers every
              level a compaction opportunity on a fixed interval with no accumulation threshold,
              so an empty level with a busy level below it has been offered that work on every
              tick and produced nothing.{SENTENCE_GAP}Until 2026-08-14 this panel called that
              state normal, and a six-day deep-compaction outage stayed invisible.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
