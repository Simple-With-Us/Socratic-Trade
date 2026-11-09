#!/usr/bin/env tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCongressScoreObservations,
  congressScoreObservationsFromExportRows,
  evaluateCongressScore,
  type CongressScoreObservation
} from "../../src/lib/congress-score-eval";

interface Args {
  input?: string;
  userId: string;
  horizonDays: number;
  auditLimit: number;
  quantiles: number;
  minNamesPerDate: number;
  minObservations: number;
  minDates: number;
  minTickers: number;
  minTopBucketObservations: number;
  requireBenchmarkReturn: boolean;
  placeboSeed?: number;
}

class CongressExportNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CongressExportNotReadyError";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const observations = args.input
    ? readExport(resolve(args.input), args.horizonDays)
    : await buildCongressScoreObservations(args.userId, {
        horizonDays: args.horizonDays,
        auditLimit: args.auditLimit
      });
  const result = evaluateCongressScore(observations, {
    quantiles: args.quantiles,
    minNamesPerDate: args.minNamesPerDate,
    minObservations: args.minObservations,
    minDates: args.minDates,
    minTickers: args.minTickers,
    minTopBucketObservations: args.minTopBucketObservations,
    requireBenchmarkReturn: args.requireBenchmarkReturn,
    placeboSeed: args.placeboSeed
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.goNoGo.pass) process.exitCode = 2;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    userId: "local",
    horizonDays: 63,
    auditLimit: 1000,
    quantiles: 5,
    minNamesPerDate: 10,
    minObservations: 500,
    minDates: 60,
    minTickers: 50,
    minTopBucketObservations: 100,
    requireBenchmarkReturn: true,
    placeboSeed: 17
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) args.input = next, i++;
    else if (arg === "--user" && next) args.userId = next, i++;
    else if (arg === "--horizon-days" && next) args.horizonDays = numberArg(next, args.horizonDays), i++;
    else if (arg === "--audit-limit" && next) args.auditLimit = numberArg(next, args.auditLimit), i++;
    else if (arg === "--quantiles" && next) args.quantiles = numberArg(next, args.quantiles), i++;
    else if (arg === "--min-names-per-date" && next) args.minNamesPerDate = numberArg(next, args.minNamesPerDate), i++;
    else if (arg === "--min-observations" && next) args.minObservations = numberArg(next, args.minObservations), i++;
    else if (arg === "--min-dates" && next) args.minDates = numberArg(next, args.minDates), i++;
    else if (arg === "--min-tickers" && next) args.minTickers = numberArg(next, args.minTickers), i++;
    else if (arg === "--min-top-bucket-observations" && next) args.minTopBucketObservations = numberArg(next, args.minTopBucketObservations), i++;
    else if (arg === "--allow-raw-returns") args.requireBenchmarkReturn = false;
    else if (arg === "--placebo-seed" && next) args.placeboSeed = numberArg(next, args.placeboSeed ?? 17), i++;
    else if (arg === "--no-placebo") args.placeboSeed = undefined;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function readExport(path: string, horizonDays: number): CongressScoreObservation[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const parsed = text.startsWith("[") || text.startsWith("{")
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assertExportValidationReady(parsed);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows ?? parsed.observations ?? [];
  if (!Array.isArray(rows)) throw new Error("Expected a JSON array, JSONL rows, or { rows: [...] }.");
  return congressScoreObservationsFromExportRows(rows, { horizonDays });
}

function assertExportValidationReady(parsed: unknown): void {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return;
  const readiness = (parsed as { validationReadiness?: unknown }).validationReadiness;
  if (!readiness || typeof readiness !== "object") return;
  const r = readiness as Record<string, unknown>;
  if (r.historicalValidationReady !== false) return;
  throw new CongressExportNotReadyError(
    [
      "Congress.Trade export is not historical-validation ready.",
      "validationReadiness.historicalValidationReady=false.",
      summarizeReadinessReason(r)
    ].filter(Boolean).join(" ")
  );
}

function summarizeReadinessReason(readiness: Record<string, unknown>): string {
  const values: string[] = [];
  for (const key of ["reason", "reasons", "blocker", "blockers", "missing", "notes"]) {
    const value = readiness[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()));
  }
  return values.length ? `Reason(s): ${values.join("; ")}` : "";
}

function numberArg(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function printHelp(): void {
  console.log(`Usage:
  npm run eval:congress-score
  npm run eval:congress-score -- --input congress-score-export.jsonl

Options:
  --input <file>              JSON/JSONL export from Congress.Trade. Omit to use signal_snapshot.
  --user <id>                 User id for signal_snapshot mode. Default: local
  --horizon-days <n>          Forward-return horizon for signal_snapshot mode. Default: 63
  --audit-limit <n>           Max signal_snapshot audit rows. Default: 1000
  --quantiles <n>             Quantile bucket count. Default: 5
  --min-names-per-date <n>    Minimum cross-section size for rank IC. Default: 10
  --min-observations <n>      Minimum total observations for go/no-go. Default: 500
  --min-dates <n>             Minimum contributing dates for go/no-go. Default: 60
  --min-tickers <n>           Minimum distinct tickers for go/no-go. Default: 50
  --min-top-bucket-observations <n> Minimum top-bucket rows. Default: 100
  --allow-raw-returns         Do not require benchmarkReturn/spxReturn in input rows
  --placebo-seed <n>          Deterministic per-date score rotation seed. Default: 17
  --no-placebo                Skip placebo rotation

Input rows may be flat rows with date/asOf, symbol/ticker, congressScore/compositeScore, forwardReturn,
and benchmarkReturn/spxReturn, or App A PIT rows from /api/export/congress-pit-scores with labels.horizons[].
Optional: congressSignedScore/signedScore, congressDirection/direction, and preCongressScore.
If a Congress.Trade export envelope sets validationReadiness.historicalValidationReady=false, the
command refuses to evaluate it and exits 2.
`);
}

main().catch((error) => {
  if (error instanceof CongressExportNotReadyError) {
    console.error(error.message);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
