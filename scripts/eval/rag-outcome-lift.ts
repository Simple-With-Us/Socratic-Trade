#!/usr/bin/env tsx

/**
 * RAG outcome-lift scorecard (ST-4678) — offline, read-only.
 *
 * Reads matured, closed decisions (status placed/filled with a decisive won/lost/flat outcome) from a
 * SQLite database given by --db, splits them by whether the decision's persisted `rag_attributions`
 * include a RAG retrieval, and prints mean/median outcome, win rate and count per bucket at each
 * matured horizon (1d, 5d = the persisted 1w row, holding), with a 95% normal-approximation CI on the
 * mean. The aggregation math lives in rag-outcome-lift-score.ts (pure, unit-testable).
 *
 * No network, no LLM, no writes. --db is REQUIRED: there is deliberately no default database path
 * that could point at production. Open the file read-only.
 *
 *   npm run eval:rag-outcome-lift -- --db /path/to/app.db [--user ID] [--limit N] [--json]
 */
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SocraticRagAttribution } from "../../src/lib/types";
import {
  extractHorizonReturns,
  hasRagRetrieval,
  summarizeRagOutcomeLift,
  LIFT_HORIZONS,
  type LiftDecisionInput,
  type LiftStats,
  type PersistedOutcome
} from "./rag-outcome-lift-score";

const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50000;

interface CliArgs {
  db: string;
  user?: string;
  limit: number;
  json: boolean;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { limit: DEFAULT_LIMIT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--db" && next) {
      args.db = next;
      i++;
    } else if (arg === "--user" && next) {
      args.user = next;
      i++;
    } else if (arg === "--limit" && next) {
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
        throw new Error(`--limit must be an integer in 1..${MAX_LIMIT}.`);
      }
      args.limit = parsed;
      i++;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!args.db) throw new Error("RAG outcome-lift scorecard requires --db <path-to-sqlite-db> (no default).");
  return args as CliArgs;
}

function printHelp(): void {
  console.log(`Usage: npm run eval:rag-outcome-lift -- --db <path> [options]

Offline, read-only RAG outcome-lift scorecard. Splits matured closed decisions by whether their
persisted rag_attributions include a RAG retrieval and reports realized outcome per bucket.

  --db PATH       Required SQLite database file (opened read-only; no default)
  --user ID       Restrict to one user id (default: all users)
  --limit N       Max decisions to scan (default ${DEFAULT_LIMIT}; max ${MAX_LIMIT})
  --json          Print machine-readable JSON instead of the table

Horizons: 1d (1 trading day), 5d (the persisted 1w / 5-trading-day row), holding (headline return).
`);
}

/** Read matured closed decisions and reduce each to the aggregator's bucket + horizon-return input. */
export function readLiftDecisions(dbPath: string, user: string | undefined, limit: number): LiftDecisionInput[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const clauses = [
      "status IN ('placed', 'filled')",
      "json_extract(outcome, '$.status') IN ('won', 'lost', 'flat')"
    ];
    const params: unknown[] = [];
    if (user) {
      clauses.push("user_id = ?");
      params.push(user);
    }
    const rows = db
      .prepare(
        `SELECT rag_attributions, outcome FROM socratic_decisions
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(...params, limit) as Array<{ rag_attributions: string; outcome: string | null }>;
    return rows.map((row) => {
      const attributions = parseJson<SocraticRagAttribution[]>(row.rag_attributions, []);
      const outcome = parseJson<PersistedOutcome | undefined>(row.outcome, undefined);
      return { hasRag: hasRagRetrieval(attributions), returns: extractHorizonReturns(outcome) };
    });
  } finally {
    db.close();
  }
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function printTable(stats: LiftStats[], scanned: number): void {
  console.log(`RAG outcome-lift scorecard — ${scanned} matured closed decision(s)\n`);
  for (const horizon of LIFT_HORIZONS) {
    console.log(`Horizon: ${horizon}`);
    console.log("  bucket    count   wins   winRate    mean     median   ci95");
    for (const bucket of ["rag", "no-rag"] as const) {
      const cell = stats.find((s) => s.horizon === horizon && s.bucket === bucket);
      if (!cell) continue;
      const ci = cell.ci95 ? `[${cell.ci95[0].toFixed(2)}, ${cell.ci95[1].toFixed(2)}]` : "n/a";
      const winRate = cell.winRate === null ? "n/a" : `${(cell.winRate * 100).toFixed(1)}%`;
      console.log(
        `  ${bucket.padEnd(8)}  ${String(cell.count).padStart(5)}  ${String(cell.wins).padStart(5)}  ${winRate.padStart(7)}  ${fmt(cell.mean).padStart(7)}  ${fmt(cell.median).padStart(7)}   ${ci}`
      );
    }
    console.log("");
  }
  console.log("ci95 = 95% normal-approximation interval on the mean return; n/a when count < 2.");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const decisions = readLiftDecisions(resolve(args.db), args.user, args.limit);
  const stats = summarizeRagOutcomeLift(decisions);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ scanned: decisions.length, stats }, null, 2)}\n`);
  } else {
    printTable(stats, decisions.length);
  }
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error("RAG outcome-lift scorecard failed:", error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}