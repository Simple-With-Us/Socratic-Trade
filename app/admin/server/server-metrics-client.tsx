"use client";

import { useEffect, useState, useCallback, useId } from "react";
import Link from "next/link";
import { Btn, Card, Chip, Dot, Meter, Toggle } from "../../console/ui/primitives";
import { Server, Cpu, Database, Activity, RefreshCw, Layers, ArrowDown, ArrowUp, Globe, Shield, HardDrive, GitBranch } from "lucide-react";
import { asRecord, normalizeCoolifyResources, readText } from "@/lib/server-metrics-shapes";
import { SENTENCE_GAP } from "../../console/lib/format";
import type {
  ServerMetricsActionRunners,
  ServerMetricsResourcesObservation,
  ServerMetricsUnobservedHostFact,
  ServerMetricsUnobservedHostField,
} from "@/lib/server-metrics-runtime";

interface MetricPoint {
  timestamp: number;
  value: number;
}

interface HostInfo {
  // JSON is an untrusted runtime boundary. Keep every display field unknown so
  // a future provider regression renders a diagnostic rather than crashing.
  name?: unknown;
  status?: unknown;
  os?: unknown;
  cpus?: unknown;
  memoryTotalBytes?: unknown;
  memoryFreeBytes?: unknown;
  diskTotalBytes?: unknown;
  diskFreeBytes?: unknown;
  diskUsedBytes?: unknown;
  diskUsedPct?: unknown;
  uptimeSeconds?: unknown;
  loadAvg?: unknown;
  serverType?: unknown;
  location?: unknown;
  ip?: unknown;
}

interface ServerMetricsData {
  isProd: boolean;
  usesLocalHost?: boolean;
  degraded?: boolean;
  stale?: boolean;
  staleScope?: "all" | "metrics";
  cacheAgeSeconds?: number;
  monitoredTarget?: { hetznerServerId?: string; coolifyServerUuid?: string };
  hostInfo: HostInfo;
  unobservedHostFacts: ServerMetricsUnobservedHostFact[];
  resources: unknown;
  resourcesObservation?: ServerMetricsResourcesObservation;
  actionRunners?: ServerMetricsActionRunners;
  metrics: {
    cpu: MetricPoint[];
    diskRead: MetricPoint[];
    diskWrite: MetricPoint[];
    networkRx: MetricPoint[];
    networkTx: MetricPoint[];
  };
  asOf: string;
  error?: string;
  warnings?: unknown;
}

function parseMetricPoints(value: unknown): MetricPoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: MetricPoint[] = [];
  for (const item of value) {
    const point = asRecord(item);
    if (
      typeof point?.timestamp !== "number"
      || !Number.isFinite(point.timestamp)
      || typeof point.value !== "number"
      || !Number.isFinite(point.value)
    ) return undefined;
    points.push({ timestamp: point.timestamp, value: point.value });
  }
  return points;
}

const UNOBSERVED_HOST_FIELDS = new Set<string>([
  "memoryUtilization",
  "uptime",
  "os",
  "diskCapacity",
]);

const RUNNER_UNAVAILABLE_REASONS = new Set<string>([
  "no-github-token",
  "github-api-error",
  "unexpected-shape",
  "request-failed",
]);

/**
 * Parse the per-field "why is this blank" list. Unrecognized entries are dropped rather than
 * rendered, so a future provider regression cannot inject arbitrary prose into the panel.
 */
export function parseUnobservedHostFacts(value: unknown): ServerMetricsUnobservedHostFact[] {
  if (!Array.isArray(value)) return [];
  const facts: ServerMetricsUnobservedHostFact[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const field = readText(record?.field);
    const reason = readText(record?.reason);
    const detail = readText(record?.detail);
    if (!field || !reason || !detail || !UNOBSERVED_HOST_FIELDS.has(field)) continue;
    facts.push({
      field: field as ServerMetricsUnobservedHostFact["field"],
      reason: reason as ServerMetricsUnobservedHostFact["reason"],
      detail,
    });
  }
  return facts;
}

/**
 * Parse the runner result.
 *
 * A malformed payload returns `undefined`, which the panel renders as an explicit "not
 * available" row naming that fact. It never degrades into an empty list, because an empty list
 * is itself a meaningful measured answer ("this repository has zero registered runners") and
 * the two must stay distinguishable.
 */
export function parseActionRunners(value: unknown): ServerMetricsActionRunners | undefined {
  const record = asRecord(value);
  const repo = readText(record?.repo);
  if (!record || !repo) return undefined;

  if (record.state === "known") {
    if (!Array.isArray(record.runners)) return undefined;
    const runners: Array<{ id: string; name: string; status: string; busy: boolean | null; labels: string[] }> = [];
    for (const item of record.runners) {
      const runner = asRecord(item);
      const id = readText(runner?.id);
      const name = readText(runner?.name);
      const status = readText(runner?.status);
      if (!id || !name || !status) return undefined;
      runners.push({
        id,
        name,
        status,
        busy: typeof runner?.busy === "boolean" ? runner.busy : null,
        labels: Array.isArray(runner?.labels)
          ? runner.labels.filter((label): label is string => typeof label === "string")
          : [],
      });
    }
    const omitted = readNonNegativeNumber(record.omittedCount);
    return { state: "known", repo, runners, omittedCount: omitted ?? 0 };
  }

  if (record.state === "unavailable") {
    const reason = readText(record.reason);
    const detail = readText(record.detail);
    if (!reason || !detail || !RUNNER_UNAVAILABLE_REASONS.has(reason)) return undefined;
    return {
      state: "unavailable",
      repo,
      reason: reason as Extract<ServerMetricsActionRunners, { state: "unavailable" }>["reason"],
      detail,
    };
  }

  return undefined;
}

/**
 * Named next to the CPU meter because the transform behind it is unsettled: the server divides
 * each Hetzner CPU sample by the core count, and Hetzner documents `type=cpu` as a whole-server
 * percentage, which would make this meter read 8x low on the current 8-core box. Confirming it
 * needs one live sample, which needs the Hetzner token.
 */
const CPU_SCALING_CAVEAT =
  "Each Hetzner CPU sample is divided by the server core count before display."
  + `${SENTENCE_GAP}Whether Hetzner already reports a whole-server percentage is unconfirmed, `
  + "so this value may read low.";

const RESOURCES_UNAVAILABLE_REASONS = new Set<string>([
  "coolify-not-configured",
  "coolify-partially-configured",
  "coolify-request-failed",
]);

/**
 * Parse whether the service list is a measurement.
 *
 * A missing or malformed value returns `undefined`, which the card renders as an explicit
 * "not reported" row. It never falls back to `{state:"known"}`, because that would restore
 * exactly the bug this field exists to remove: asserting "coolify reported no services" for a
 * read that never happened.
 */
export function parseResourcesObservation(value: unknown): ServerMetricsResourcesObservation | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.state === "known") return { state: "known" };
  if (record.state === "unavailable") {
    const reason = readText(record.reason);
    const detail = readText(record.detail);
    if (!reason || !detail || !RESOURCES_UNAVAILABLE_REASONS.has(reason)) return undefined;
    return {
      state: "unavailable",
      reason: reason as Extract<ServerMetricsResourcesObservation, { state: "unavailable" }>["reason"],
      detail,
    };
  }
  return undefined;
}

/**
 * Classify one Coolify `state:health` string.
 *
 * `"unhealthy".includes("healthy")` is true, so the previous substring test resolved every
 * `*:unhealthy` container to a solid green non-pulsing dot — a guaranteed silent miss on the
 * single condition this card exists to surface.
 */
export function resourceStatusTone(status: string): "pos" | "neg" | "warn" {
  const [runState, ...healthParts] = status.split(":");
  const health = healthParts.join(":").trim().toLowerCase();
  const state = runState.trim().toLowerCase();
  if (health === "unhealthy") return "neg";
  if (state === "exited" || state === "dead" || state === "failed") return "neg";
  if (state === "running" && (health === "healthy" || health === "")) return "pos";
  return "warn";
}

export function parseServerMetricsEnvelope(value: unknown): ServerMetricsData | undefined {
  const envelope = asRecord(value);
  const hostInfo = asRecord(envelope?.hostInfo);
  const rawMetrics = asRecord(envelope?.metrics);
  if (
    typeof envelope?.isProd !== "boolean"
    || !hostInfo
    || !Array.isArray(envelope.resources)
    || !rawMetrics
    || typeof envelope.asOf !== "string"
    || !Number.isFinite(Date.parse(envelope.asOf))
  ) return undefined;
  const cpu = parseMetricPoints(rawMetrics.cpu);
  const diskRead = parseMetricPoints(rawMetrics.diskRead);
  const diskWrite = parseMetricPoints(rawMetrics.diskWrite);
  const networkRx = parseMetricPoints(rawMetrics.networkRx);
  const networkTx = parseMetricPoints(rawMetrics.networkTx);
  if (!cpu || !diskRead || !diskWrite || !networkRx || !networkTx) return undefined;
  const monitoredTarget = asRecord(envelope.monitoredTarget);
  return {
    isProd: envelope.isProd,
    usesLocalHost: envelope.usesLocalHost === true,
    degraded: envelope.degraded === true,
    stale: envelope.stale === true,
    staleScope: envelope.staleScope === "metrics" ? "metrics" : envelope.staleScope === "all" ? "all" : undefined,
    cacheAgeSeconds: readNonNegativeNumber(envelope.cacheAgeSeconds),
    monitoredTarget: monitoredTarget
      ? {
          hetznerServerId: readText(monitoredTarget.hetznerServerId),
          coolifyServerUuid: readText(monitoredTarget.coolifyServerUuid),
        }
      : undefined,
    hostInfo,
    unobservedHostFacts: parseUnobservedHostFacts(envelope.unobservedHostFacts),
    resources: envelope.resources,
    resourcesObservation: parseResourcesObservation(envelope.resourcesObservation),
    actionRunners: parseActionRunners(envelope.actionRunners),
    metrics: { cpu, diskRead, diskWrite, networkRx, networkTx },
    asOf: envelope.asOf,
    error: readText(envelope.error),
    warnings: envelope.warnings,
  };
}

export function markServerMetricsSnapshotStale(
  previous: ServerMetricsData | null,
  error: string,
): ServerMetricsData | null {
  return previous ? { ...previous, degraded: true, stale: true, error } : null;
}

// Helper formats
function formatBytes(bytes: number, decimals = 1) {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
}

function formatBandwidth(bytesPerSec: number) {
  if (bytesPerSec <= 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m`;
}

export function displayProviderText(value: unknown, fallback: string, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined || value === null || value === "") return fallback;
  return `Invalid ${label}`;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Owner copy rule: two spaces between sentences, and HTML must actually preserve the gap.
 * Server-authored `detail` strings keep plain double spaces so the JSON contract stays clean,
 * so the substitution happens once here at render time. Same helper as the Backups panel.
 */
function sentenceGaps(text: string): string {
  return text.replace(/ {2}/g, SENTENCE_GAP);
}

/**
 * Say WHICH network series is missing. "No historical data available" was printed even when
 * Rx was fully populated and only Tx was absent — two different faults, one message.
 */
export function describeMissingNetworkSeries(rxPoints: number, txPoints: number): string {
  if (rxPoints === 0 && txPoints === 0) return "no historical data available";
  if (rxPoints < 2 && txPoints < 2) return "only one sample so far — a line needs at least two";
  if (rxPoints < 2) return "the inbound (Rx) series is missing, so the pair cannot be charted";
  return "the outbound (Tx) series is missing, so the pair cannot be charted";
}

/** Human label for a runner result that could not be measured. */
export function runnerUnavailableHeadline(
  reason: Extract<ServerMetricsActionRunners, { state: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "no-github-token": return "not available: no GitHub token configured";
    case "github-api-error": return "not available: the GitHub API rejected the request";
    case "unexpected-shape": return "not available: unexpected GitHub API response";
    case "request-failed": return "not available: the GitHub API could not be reached";
  }
}

export function resourcesUnavailableHeadline(
  reason: Extract<ServerMetricsResourcesObservation, { state: "unavailable" }>["reason"],
): string {
  switch (reason) {
    case "coolify-not-configured":
      return "services not queried";
    case "coolify-partially-configured":
      return "services not queried";
    case "coolify-request-failed":
      return "service list unavailable";
  }
}

/**
 * Render the service list, an explicit measured-zero state, or an explicit unavailable state.
 *
 * The three are visually distinct for the same reason the runner card's are: `resources: []`
 * is produced identically by "never queried", "the read failed" and "Coolify answered zero",
 * and this card used to render all three as the flat assertion "coolify reported no services
 * for this server".
 */
function ServicesPanel({
  resources,
  observation,
}: {
  resources: Array<{ uuid: string; name: string; type: string; status: string }>;
  observation?: ServerMetricsResourcesObservation;
}) {
  if (!observation) {
    return (
      <div className="py-6 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        not reported: the metrics endpoint did not say whether Coolify was queried
      </div>
    );
  }

  if (observation.state === "unavailable") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Dot tone="warn" pulse={false} />
          <span className="text-[length:var(--con-fs-sm)] font-semibold">
            {resourcesUnavailableHeadline(observation.reason)}
          </span>
        </div>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          {sentenceGaps(observation.detail)}
        </p>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          reason code {observation.reason}
        </p>
      </div>
    );
  }

  if (resources.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Dot tone="warn" pulse={false} />
          <span className="text-[length:var(--con-fs-sm)] font-semibold">no services registered</span>
        </div>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          {sentenceGaps("Coolify returned zero applications and services for this server.  "
            + "This is a measured answer, not a failed read.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {resources.map((item) => {
        const tone = resourceStatusTone(item.status);

        return (
          <div
            key={item.uuid}
            className="flex items-center justify-between border-b border-[color:var(--con-line)] pb-3 last:border-0 last:pb-0"
          >
            <div className="min-w-0">
              <div className="truncate text-[length:var(--con-fs-sm)] font-semibold">{item.name}</div>
              <div className="text-[length:var(--con-fs-xs)] capitalize text-[color:var(--con-muted)]">{item.type}</div>
            </div>
            <div className="flex items-center gap-2">
              <Dot tone={tone} pulse={tone !== "pos"} />
              {/* Render the WHOLE status. Splitting on ":" discarded the health half, so
                  "running:unhealthy" was displayed to the reader as "RUNNING". */}
              <span className="text-[length:var(--con-fs-xs)] font-medium uppercase">{item.status}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Render the runner list, an explicit measured-empty state, or an explicit unavailable state.
 *
 * All three are visually distinct on purpose. This card replaced six hardcoded rows that were
 * shown for every failure mode, so the one thing it must never do again is present a
 * plausible-looking list in place of an answer it does not have.
 */
function ActionRunnersPanel({ runners }: { runners?: ServerMetricsActionRunners }) {
  if (!runners) {
    return (
      <div className="py-6 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        not available: the metrics endpoint did not report runner state
      </div>
    );
  }

  if (runners.state === "unavailable") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Dot tone="warn" pulse={false} />
          <span className="text-[length:var(--con-fs-sm)] font-semibold">
            {runnerUnavailableHeadline(runners.reason)}
          </span>
        </div>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          {sentenceGaps(runners.detail)}
        </p>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          repository {runners.repo} · reason code {runners.reason}
        </p>
      </div>
    );
  }

  if (runners.runners.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Dot tone="warn" pulse={false} />
          <span className="text-[length:var(--con-fs-sm)] font-semibold">no runners registered</span>
        </div>
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          {sentenceGaps(`GitHub reports zero self-hosted runners for ${runners.repo}.  `
            + "This is a measured answer, not a failed read.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {runners.runners.map((runner) => {
        const online = runner.status.toLowerCase() === "online";
        return (
          <div
            key={runner.id}
            className="flex items-center justify-between border-b border-[color:var(--con-line)] pb-3 last:border-0 last:pb-0"
          >
            <div className="min-w-0">
              <div className="truncate text-[length:var(--con-fs-sm)] font-semibold">{runner.name}</div>
              <div className="truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {runner.labels.length > 0 ? runner.labels.join(", ") : "no labels reported"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Dot tone={online ? "pos" : "neg"} pulse={!online} />
              {/* GitHub reports reachability only, so this says "online", never "healthy". */}
              <span className="text-[length:var(--con-fs-xs)] font-medium uppercase">
                {runner.status}
                {runner.busy === true ? " · busy" : ""}
              </span>
            </div>
          </div>
        );
      })}
      {runners.omittedCount > 0 && (
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
          {runners.omittedCount} runner entries were omitted because GitHub returned them without a name or status.
        </p>
      )}
      <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        registered to {runners.repo}
      </p>
    </div>
  );
}

export function ServerMetricsClient() {
  const [data, setData] = useState<ServerMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/server-metrics");
      const json: unknown = await res.json().catch(() => undefined);
      const envelope = parseServerMetricsEnvelope(json);
      if (res.ok) {
        if (envelope) {
          setData(envelope);
          setRequestError(null);
        } else {
          const error = "The server metrics endpoint returned malformed data.";
          setData((previous) => markServerMetricsSnapshotStale(previous, error));
          setRequestError(error);
        }
      } else {
        const error = readText(asRecord(json)?.error) || "Failed to load metrics";
        // Preserve verified partial data if a proxy or unexpected route error
        // changes the status code; reject unrelated/malformed error JSON.
        if (envelope) {
          setData({ ...envelope, error });
          setRequestError(null);
        } else {
          setData((previous) => markServerMetricsSnapshotStale(previous, error));
          setRequestError(error);
        }
      }
    } catch (err) {
      console.error(err);
      const error = "Unable to reach the server metrics endpoint.";
      setData((previous) => markServerMetricsSnapshotStale(previous, error));
      setRequestError(error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchMetrics();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchMetrics]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => {
      void fetchMetrics();
    }, 30000);
    return () => clearInterval(timer);
  }, [autoPoll, fetchMetrics]);

  if (loading) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
        <RefreshCw className="h-8 w-8 animate-spin text-[color:var(--con-accent)]" />
        <span className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Polling infrastructure health...</span>
      </div>
    );
  }

  const host = data?.hostInfo;
  const normalizedResources = normalizeCoolifyResources(data?.resources ?? []);
  const resources = normalizedResources.resources;
  const metrics = data?.metrics;
  const providerWarnings = Array.isArray(data?.warnings)
    ? data.warnings.filter((warning): warning is string => typeof warning === "string" && Boolean(warning.trim()))
    : data?.warnings == null
      ? []
      : ["The server metrics warnings payload was malformed."];
  const warnings = [...providerWarnings, ...normalizedResources.warnings];
  const usesLocalHost = data?.usesLocalHost === true;
  // No invented local-runtime placeholders. The local path never measures an IP, a location or
  // a server type, so it must not print "127.0.0.1 / local / local runtime" as if it had.
  const hostName = displayProviderText(host?.name, "Unavailable", "host name");
  const hostOs = displayProviderText(host?.os, "Unavailable", "operating system");
  const hostIp = displayProviderText(host?.ip, "Unavailable", "server IP");
  const hostLocation = displayProviderText(host?.location, "Unavailable", "server location");
  const serverType = displayProviderText(host?.serverType, "Unavailable", "server type");
  const unobserved = (field: ServerMetricsUnobservedHostField): string | undefined =>
    data?.unobservedHostFacts?.find((fact) => fact.field === field)?.detail;
  const cpuCores = typeof host?.cpus === "number" && Number.isFinite(host.cpus) && host.cpus > 0
    ? `${host.cpus} Cores`
    : "Unavailable";
  const memoryTotalBytes = readNonNegativeNumber(host?.memoryTotalBytes);
  const memoryFreeBytes = readNonNegativeNumber(host?.memoryFreeBytes);
  const memPct = memoryTotalBytes && memoryFreeBytes !== undefined
    ? Math.max(0, Math.min(100, Math.round(((memoryTotalBytes - memoryFreeBytes) / memoryTotalBytes) * 100)))
    : undefined;
  const diskTotalBytes = readNonNegativeNumber(host?.diskTotalBytes);
  const diskFreeBytes = readNonNegativeNumber(host?.diskFreeBytes);
  const diskUsedBytes = readNonNegativeNumber(host?.diskUsedBytes);
  const diskUsedPct = typeof host?.diskUsedPct === "number" && Number.isFinite(host.diskUsedPct)
    ? Math.max(0, Math.min(100, Math.round(host.diskUsedPct)))
    : undefined;
  const uptimeSeconds = readNonNegativeNumber(host?.uptimeSeconds);
  const loadAverage = Array.isArray(host?.loadAvg)
    ? readNonNegativeNumber(host.loadAvg[0])
    : undefined;
  const asOf = data?.asOf ? new Date(data.asOf) : undefined;
  const hasValidAsOf = asOf && Number.isFinite(asOf.getTime());
  // The zone is forced to Central Time (fleet convention) but the locale is the viewer's, so
  // print the zone name — an unlabelled time reads as the reader's own clock.
  const formattedAsOf = hasValidAsOf
    ? asOf.toLocaleString(undefined, { timeZone: "America/Chicago", timeZoneName: "short" })
    : "Unavailable";
  const snapshotAge = typeof data?.cacheAgeSeconds === "number"
    ? `${Math.floor(data.cacheAgeSeconds)}s old`
    : "age unknown";

  // CPU average of last 3 points
  const latestCpuValues = metrics?.cpu?.slice(-3).map(p => p.value) || [];
  const currentCpu = latestCpuValues.length > 0
    ? Math.round(latestCpuValues.reduce((a, b) => a + b, 0) / latestCpuValues.length)
    : undefined;

  // Disk/Network average speed of last 3 points
  const getLatestAvg = (points?: MetricPoint[]) => {
    const vals = points?.slice(-3).map(p => p.value) || [];
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  };

  const currentDiskRead = getLatestAvg(metrics?.diskRead);
  const currentDiskWrite = getLatestAvg(metrics?.diskWrite);
  const currentNetRx = getLatestAvg(metrics?.networkRx);
  const currentNetTx = getLatestAvg(metrics?.networkTx);

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Server Stats</h1>
            {usesLocalHost ? (
              <Chip tone="warn">LOCAL HOST</Chip>
            ) : (
              <Chip tone={data?.degraded ? "warn" : "accent"}>
                {data?.isProd
                  ? data.degraded ? "PRODUCTION - DEGRADED" : "PRODUCTION"
                  : data?.degraded ? "REMOTE - DEGRADED" : "REMOTE"}
              </Chip>
            )}
            {data?.stale && (
              <Chip tone="warn">{data.staleScope === "metrics" ? "STALE METRICS" : "STALE SNAPSHOT"}</Chip>
            )}
          </div>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Host node metrics and application resource statuses.
          </p>
          <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            As of {formattedAsOf} ({snapshotAge})
          </p>
          {(data?.monitoredTarget?.hetznerServerId || data?.monitoredTarget?.coolifyServerUuid) && (
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              querying{data.monitoredTarget.hetznerServerId ? ` hetzner server ${data.monitoredTarget.hetznerServerId}` : ""}
              {data.monitoredTarget.hetznerServerId && data.monitoredTarget.coolifyServerUuid ? " and" : ""}
              {data.monitoredTarget.coolifyServerUuid ? ` coolify server ${data.monitoredTarget.coolifyServerUuid}` : ""}
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
              void fetchMetrics();
            }}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Btn>
        </div>
      </header>

      {(requestError || data?.error) && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
          <span className="font-semibold">Error retrieving full metrics:</span> {requestError || data?.error}
          {data ? " Available verified data is shown." : ""}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]" role="status">
          <span className="font-semibold">Provider metadata warning:</span> {warnings.join(" ")}
        </div>
      )}

      {/* Host Details Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-accent-soft)] p-2 text-[color:var(--con-accent)]">
              <Server size={20} />
            </div>
            <div>
              <div className="con-card-title">Host Server</div>
              <div className="font-bold">{hostName}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                <Globe size={11} /> {hostIp} • {hostLocation}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-pos-soft)] p-2 text-[color:var(--con-pos)]">
              <Cpu size={20} />
            </div>
            <div>
              <div className="con-card-title">CPU Cores</div>
              <div className="font-bold">{cpuCores}</div>
              <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {serverType} • Load: {loadAverage === undefined ? "n/a" : loadAverage.toFixed(2)}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-info-soft)] p-2 text-[color:var(--con-info)]">
              <Database size={20} />
            </div>
            <div>
              <div className="con-card-title">System Memory</div>
              <div className="font-bold">
                {memoryTotalBytes === undefined ? "Unavailable" : formatBytes(memoryTotalBytes)}
              </div>
              <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {memPct === undefined || memoryFreeBytes === undefined
                  ? unobserved("memoryUtilization") ?? "utilization not measured"
                  : `${memPct}% used (${formatBytes(memoryTotalBytes! - memoryFreeBytes)} used, ${formatBytes(memoryFreeBytes)} free)`}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-accent-soft)] p-2 text-[color:var(--con-accent)]">
              <HardDrive size={20} />
            </div>
            <div>
              <div className="con-card-title">Disk Storage</div>
              <div className="font-bold">
                {diskTotalBytes === undefined ? "Unavailable" : formatBytes(diskTotalBytes)}
              </div>
              <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {diskUsedPct === undefined || diskFreeBytes === undefined
                  ? unobserved("diskCapacity") ?? "capacity not measured"
                  : `${diskUsedPct}% used (${formatBytes(diskUsedBytes!)} used, ${formatBytes(diskFreeBytes)} avail)`}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-warn-soft)] p-2 text-[color:var(--con-warn)]">
              <Activity size={20} />
            </div>
            <div>
              <div className="con-card-title">Host Uptime</div>
              <div className="font-bold">
                {uptimeSeconds === undefined ? "Not measured" : formatUptime(uptimeSeconds)}
              </div>
              <div
                className="mt-0.5 max-w-[180px] truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]"
                title={uptimeSeconds === undefined ? unobserved("uptime") : undefined}
              >
                {hostOs === "Unavailable" ? unobserved("os") ?? "operating system not reported" : hostOs}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Content Layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left 2 Columns: Live Utilization and Charts */}
        <div className="space-y-6 lg:col-span-2">
          {/* Real-time Rings / Progress */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Activity className="h-4 w-4" /> Live Resource Load
              </span>
            }
          >
            <div className="grid gap-6 sm:grid-cols-3">
              {/* CPU Bar */}
              <div title={currentCpu === undefined ? undefined : CPU_SCALING_CAVEAT}>
                <div className="mb-1 flex justify-between text-[length:var(--con-fs-xs)] font-semibold">
                  <span className="text-[color:var(--con-muted)]">CPU Utilization</span>
                  <span className="con-num">{currentCpu === undefined ? "Unavailable" : `${currentCpu}%`}</span>
                </div>
                {currentCpu !== undefined ? <Meter value={currentCpu} max={100} label="CPU Utilization" /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
                {/* The server divides every Hetzner CPU sample by the core count. That transform
                    is unverified (see route.ts), and a silently 8x-low meter would stay green
                    through a saturation incident, so the scaling is named rather than implied. */}
                {currentCpu !== undefined && (
                  <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                    per-core average; scaling unverified
                  </p>
                )}
              </div>

              {/* Memory Bar */}
              <div title={memPct === undefined ? unobserved("memoryUtilization") : undefined}>
                <div className="mb-1 flex justify-between text-[length:var(--con-fs-xs)] font-semibold">
                  <span className="text-[color:var(--con-muted)]">RAM Utilization</span>
                  <span className="con-num">{memPct === undefined ? "not measured" : `${memPct}%`}</span>
                </div>
                {memPct !== undefined ? <Meter value={memPct} max={100} label="RAM Utilization" /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
              </div>

              {/* Disk Bar */}
              <div title={diskUsedPct === undefined ? unobserved("diskCapacity") : undefined}>
                <div className="mb-1 flex justify-between text-[length:var(--con-fs-xs)] font-semibold">
                  <span className="text-[color:var(--con-muted)]">Disk Utilization</span>
                  <span className="con-num">{diskUsedPct === undefined ? "not measured" : `${diskUsedPct}%`}</span>
                </div>
                {diskUsedPct !== undefined ? <Meter value={diskUsedPct} max={100} label="Disk Utilization" /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-[color:var(--con-line)] pt-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              <div>
                <div className="flex items-center gap-1"><ArrowDown size={12} className="text-[color:var(--con-pos)]" /> Disk Read</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentDiskRead === undefined ? "Unavailable" : formatBandwidth(currentDiskRead)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowUp size={12} className="text-[color:var(--con-accent)]" /> Disk Write</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentDiskWrite === undefined ? "Unavailable" : formatBandwidth(currentDiskWrite)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowDown size={12} className="text-[color:var(--con-pos)]" /> Network In (Rx)</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentNetRx === undefined ? "Unavailable" : formatBandwidth(currentNetRx)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowUp size={12} className="text-[color:var(--con-accent)]" /> Network Out (Tx)</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentNetTx === undefined ? "Unavailable" : formatBandwidth(currentNetTx)}</div>
              </div>
            </div>
          </Card>

          {/* CPU Chart */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Cpu className="h-4 w-4" /> CPU History (Last 1 Hour)
                {metrics && metrics.cpu && metrics.cpu.length > 0 && <span className="ml-2 font-normal text-[color:var(--con-faint)]">Max: 100%</span>}
              </span>
            }
          >
            <div className="h-44 w-full">
              {/* The chart component itself requires 2+ points. Guarding on `> 0` rendered an
                  unexplained empty frame for a single-sample series. */}
              {metrics && metrics.cpu.length >= 2 ? (
                <SparklineChart points={metrics.cpu} yMax={100} stroke="var(--con-accent)" fill="var(--con-accent)" />
              ) : (
                <div className="flex h-full items-center justify-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {metrics && metrics.cpu.length === 1
                    ? "only one sample so far — a line needs at least two"
                    : "no historical data available"}
                </div>
              )}
            </div>
          </Card>

          {/* Network Chart */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Globe className="h-4 w-4" /> Network Bandwidth
              </span>
            }
          >
            <div className="h-44 w-full">
              {/* Both series are required: guarding on Rx alone rendered a blank frame whenever
                  the Tx series specifically was missing, which is a different fault. */}
              {metrics && metrics.networkRx.length >= 2 && metrics.networkTx.length >= 2 ? (
                <DualLineChart
                  seriesA={metrics.networkRx}
                  seriesB={metrics.networkTx}
                  labelA="Rx (Inbound)"
                  labelB="Tx (Outbound)"
                  formatValue={formatBandwidth}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {describeMissingNetworkSeries(metrics?.networkRx.length ?? 0, metrics?.networkTx.length ?? 0)}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right 1 Column: Services & Action Runners Container Health */}
        <div className="space-y-6">
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Layers className="h-4 w-4" /> Services & Containers
              </span>
            }
          >
            <ServicesPanel resources={resources} observation={data?.resourcesObservation} />
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <GitBranch className="h-4 w-4" /> GitHub Actions Runners
              </span>
            }
          >
            <ActionRunnersPanel runners={data?.actionRunners} />
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Shield className="h-4 w-4" /> Security & Access
              </span>
            }
          >
            <div className="space-y-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              {/* This sentence used to assert unconditionally that everything above came from
                  Hetzner and Coolify. On the local path none of it does — host facts come from
                  node's `os` module — and with either provider unconfigured only part of it
                  does. Describe the path actually taken. */}
              <p>
                {usesLocalHost ? (
                  <>
                    No infrastructure provider is configured on this runtime, so the host facts
                    above are read from this process&apos;s own operating system rather than from
                    Hetzner or Coolify.
                  </>
                ) : (
                  <>
                    This panel reads the Hetzner and Coolify APIs over HTTPS using read-only
                    tokens.{SENTENCE_GAP}Values above come from whichever of those providers is
                    configured and answered; anything they did not report is labelled in place.
                  </>
                )}
              </p>
              <div className="con-tile text-[color:var(--con-faint)]">
                <span className="mb-1 block font-bold text-[color:var(--con-muted)]">Not measured here:</span>
                {/* This tile previously asserted the firewall posture and that litestream was
                    replicating to R2. None of it was read from any source, and the app can run
                    with litestream disabled (R2 kill-switch, exit 41) while that line still
                    claimed backups were running. Point at the page that actually measures it. */}
                • firewall rules and open ports are not queried by this panel<br />
                • backup replication is measured on the Backups page, not here
              </div>
              <Link
                href="/admin/backups"
                className="inline-block font-semibold text-[color:var(--con-accent)] underline"
              >
                View Backup Status
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── SVG Sparkline Chart ───────────────────────────────────────────────────────
function SparklineChart({ points, yMax, stroke, fill }: { points: MetricPoint[]; yMax?: number; stroke: string; fill: string }) {
  const gradId = useId();
  if (points.length < 2) return null;
  const values = points.map(p => p.value);
  const minVal = 0;
  const maxVal = yMax || Math.max(...values, 1);

  const width = 500;
  const height = 150;
  const padding = 10;

  const pointsCount = points.length;
  const xScale = (width - padding * 2) / (pointsCount - 1);
  const yScale = (height - padding * 2) / (maxVal - minVal);

  const svgPoints = points.map((p, i) => {
    const x = padding + i * xScale;
    const y = height - padding - (p.value - minVal) * yScale;
    return `${x},${y}`;
  });

  const pathD = `M ${svgPoints.join(" L ")}`;
  const areaD = `${pathD} L ${padding + (pointsCount - 1) * xScale},${height - padding} L ${padding},${height - padding} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity="0.25" />
          <stop offset="100%" stopColor={fill} stopOpacity="0.00" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
      <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--con-line)" strokeWidth={0.5} />
      {/* Area */}
      <path d={areaD} fill={`url(#${gradId})`} />
      {/* Line */}
      <path d={pathD} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {/* Max reference line */}
      <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke={stroke} strokeWidth={1} strokeDasharray="4" opacity={0.3} />
    </svg>
  );
}

// ── SVG Dual Line Chart ────────────────────────────────────────────────────────
function DualLineChart({
  seriesA,
  seriesB,
  labelA,
  labelB,
  formatValue
}: {
  seriesA: MetricPoint[];
  seriesB: MetricPoint[];
  labelA: string;
  labelB: string;
  formatValue: (v: number) => string;
}) {
  if (seriesA.length < 2 || seriesB.length < 2) return null;

  const valsA = seriesA.map(p => p.value);
  const valsB = seriesB.map(p => p.value);
  const maxVal = Math.max(...valsA, ...valsB, 1024);

  const width = 500;
  const height = 150;
  const padding = 10;

  const xScale = (width - padding * 2) / (seriesA.length - 1);
  const yScale = (height - padding * 2) / maxVal;

  const buildPath = (series: MetricPoint[]) => {
    return series.map((p, i) => {
      const x = padding + i * xScale;
      const y = height - padding - p.value * yScale;
      return `${x},${y}`;
    }).join(" L ");
  };

  const pathA = `M ${buildPath(seriesA)}`;
  const pathB = `M ${buildPath(seriesB)}`;

  return (
    <div className="h-full flex flex-col justify-between">
      <div className="flex items-center gap-4 self-end text-[10px] text-[color:var(--con-muted)]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded bg-[color:var(--con-pos)]" /> {labelA} (Max: {formatValue(Math.max(...valsA))})
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded bg-[color:var(--con-accent)]" /> {labelB} (Max: {formatValue(Math.max(...valsB))})
        </span>
      </div>
      <div className="flex-1 h-36 mt-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
          <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--con-line)" strokeWidth={0.5} />

          {/* Line A */}
          <path d={pathA} fill="none" stroke="var(--con-pos)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {/* Line B */}
          <path d={pathB} fill="none" stroke="var(--con-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {/* Max reference line */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--con-muted)" strokeWidth={1} strokeDasharray="4" opacity={0.3} />
        </svg>
      </div>
    </div>
  );
}
