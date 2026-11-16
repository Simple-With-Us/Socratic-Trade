import { normalizeSymbol } from "../src/lib/money.js";
import { activeEmbeddingModel } from "../src/lib/vector-db.js";
import { migrateLocalEnvCredentials } from "../src/lib/db-api-keys.js";
import { 
  startCorpusReembedRun, 
  runCorpusReembedDryRun,
  purgeLegacyEmbeddingSpace,
  getCorpusReembedProgress,
  CORPUS_REEMBED_DOC_TYPES,
  type CorpusReembedDocType
} from "../src/lib/rag/corpus-reembed.js";
import readline from "readline";

// This script drives destructive, budget-spending operations and accepts `--yes` to bypass its
// own prompts, so EVERY malformed flag fails fast instead of silently falling back to a broader
// default. A typo must never widen the blast radius.
function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// Parse CLI arguments
const rawArgs = process.argv.slice(2);
// Normalize `--flag=value` to `--flag value` so equals-form CLI usage works (Codex P2 #1775).
const args: string[] = [];
for (const a of rawArgs) {
  if (a.startsWith("--") && a.includes("=") && !a.startsWith("--=")) {
    const eq = a.indexOf("=");
    args.push(a.slice(0, eq), a.slice(eq + 1));
  } else {
    args.push(a);
  }
}
const isDryRun = args.includes("--dry-run");
const isPurgeLegacy = args.includes("--purge-legacy");
const force = args.includes("--force");
const autoYes = args.includes("--yes") || args.includes("-y");

// This script replaced an older reindex CLI that shared its name/path. Operator muscle memory and
// any unmigrated automation may still pass the old flags, which this version does not implement —
// silently ignoring them would let e.g. `--clear-only --yes` fall through and start a real,
// budget-spending corpus re-embed instead of just clearing caches. Fail fast and say so.
const RETIRED_FLAGS = ["--clear-only", "--ingest", "--limit"] as const;
const usedRetired = RETIRED_FLAGS.filter((flag) => args.includes(flag));
if (usedRetired.length > 0) {
  fail(
    `retired flag(s) no longer supported: ${usedRetired.join(", ")}.\n` +
      `   This script now drives the corpus re-embed pipeline. Supported flags:\n` +
      `   --status | --dry-run | --purge-legacy [--purge-token <token>] | --ticker <SYM>\n` +
      `   --doc-types <a,b> | --max-texts <n> | --force | --yes`
  );
}

// Extract --ticker
let targetTicker: string | undefined;
const tickerIdx = args.indexOf("--ticker");
if (tickerIdx !== -1) {
  const raw = args[tickerIdx + 1];
  if (!raw || raw.startsWith("-")) fail("--ticker requires a symbol (e.g. --ticker AAPL).");
  targetTicker = normalizeSymbol(raw);
  if (!targetTicker) fail(`--ticker value "${raw}" is not a valid symbol.`);
}

// Extract --max-texts. This flag is the operator's spend limiter, so an invalid value must abort
// rather than degrade to "no cap at all" (which the re-embed helpers treat `undefined` as).
let maxTexts: number | undefined;
const maxTextsIdx = args.indexOf("--max-texts");
if (maxTextsIdx !== -1) {
  const raw = args[maxTextsIdx + 1];
  if (!raw || raw.startsWith("-")) fail("--max-texts requires a positive integer (e.g. --max-texts 500).");
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`--max-texts must be a positive integer; got "${raw}".`);
  }
  maxTexts = parsed;
}

// Extract --doc-types (comma separated). An unrecognized value must abort: leaving `docTypes`
// undefined selects ALL corpus doc types downstream, so a typo would silently widen a re-embed —
// or a purge — to the entire corpus.
let docTypes: CorpusReembedDocType[] | undefined;
const docTypesIdx = args.indexOf("--doc-types");
if (docTypesIdx !== -1) {
  const raw = args[docTypesIdx + 1];
  if (!raw || raw.startsWith("-")) {
    fail(`--doc-types requires a comma-separated list. Known types: ${CORPUS_REEMBED_DOC_TYPES.join(", ")}`);
  }
  const parsed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parsed.length === 0) {
    fail(`--doc-types requires at least one type. Known types: ${CORPUS_REEMBED_DOC_TYPES.join(", ")}`);
  }
  const unknown = parsed.filter((s) => !CORPUS_REEMBED_DOC_TYPES.includes(s as CorpusReembedDocType));
  if (unknown.length > 0) {
    fail(`unknown --doc-types value(s): ${unknown.join(", ")}.\n   Known types: ${CORPUS_REEMBED_DOC_TYPES.join(", ")}`);
  }
  docTypes = parsed as CorpusReembedDocType[];
}

// Extract --purge-token. The destructive purge requires the operator to type the exact token
// rather than having the script supply it on their behalf after a generic y/n prompt.
let purgeToken: string | undefined;
const purgeTokenIdx = args.indexOf("--purge-token");
if (purgeTokenIdx !== -1) {
  const raw = args[purgeTokenIdx + 1];
  if (!raw || raw.startsWith("-")) fail("--purge-token requires a value.");
  purgeToken = raw;
}

// `purgeLegacyEmbeddingSpace` has no symbol scoping at all — it deletes legacy vectors corpus-wide
// by source tag. Accepting --ticker alongside it would read as "purge just this symbol" while
// actually purging everything, so refuse the combination outright.
if (isPurgeLegacy && targetTicker) {
  fail(
    "--ticker cannot be combined with --purge-legacy: the legacy purge is corpus-wide and has no " +
      "per-symbol scope. Re-run without --ticker if you really intend a corpus-wide purge."
  );
}

// Reject unknown flags before any mode default (Codex P2 on PR #1775). A typo like `--dryrun`
// instead of `--dry-run` would otherwise fall through to a live re-embed under `--yes`.
{
  const valueTaking = new Set(["--ticker", "--max-texts", "--doc-types", "--purge-token"]);
  const knownStandalone = new Set([
    "--dry-run",
    "--purge-legacy",
    "--force",
    "--yes",
    "-y",
    "--status",
    ...RETIRED_FLAGS
  ]);
  const unknownFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) continue;
    if (valueTaking.has(a)) {
      i += 1; // skip value
      continue;
    }
    if (a.includes("=")) {
      const flag = a.slice(0, a.indexOf("="));
      if (!valueTaking.has(flag) && !knownStandalone.has(flag)) unknownFlags.push(a);
      continue;
    }
    if (!knownStandalone.has(a)) unknownFlags.push(a);
  }
  if (unknownFlags.length > 0) {
    fail(
      `unknown flag(s): ${unknownFlags.join(", ")}.\n` +
        `   Supported: --status | --dry-run | --purge-legacy [--purge-token <token>] | --ticker <SYM>\n` +
        `   --doc-types <a,b> | --max-texts <n> | --force | --yes`
    );
  }
}

async function askConfirm(question: string): Promise<boolean> {
  if (autoYes) return true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

function printProgress() {
  const progress = getCorpusReembedProgress();
  console.log(`\n📊 Corpus Re-embed Progress:`);
  console.log(`  Active Model: ${progress.activeEmbedModel}`);
  console.log(`  Active Space Revision: ${progress.activeEmbedRevision}`);
  if (progress.persisted) {
    console.log(`  Status: ${progress.persisted.status}`);
    console.log(`  Last Run: ${progress.persisted.updatedAt}`);
    if (progress.persisted.error) {
      console.log(`  Error: ${progress.persisted.error}`);
    }
    console.log(`  DocTypes:`);
    for (const [docType, dtProgress] of Object.entries(progress.persisted.docTypes)) {
      if (!dtProgress) continue;
      console.log(`    - ${docType} (${dtProgress.status}):`);
      console.log(`      Candidates Seen: ${dtProgress.candidatesSeen}`);
      console.log(`      Embedded: ${dtProgress.embedded}`);
      console.log(`      Reused in space: ${dtProgress.reusedInSpace}`);
      console.log(`      Failed: ${dtProgress.failed}`);
      if (dtProgress.completedForEmbedRevision) {
        console.log(`      Completed for Revision: ${dtProgress.completedForEmbedRevision}`);
      }
    }
  } else {
    console.log("  No progress recorded yet.");
  }
}

async function run() {
  console.log("▶ Corpus Re-embed & Reindex Pipeline starting...");

  // 1. Migrate any credentials in env variables to local database
  console.log("  Migrating environment credentials...");
  const migration = migrateLocalEnvCredentials();
  if (migration.migrated.length > 0) {
    console.log(`  Migrated API credentials for: ${migration.migrated.join(", ")}`);
  }

  // 2. Validate active model
  const activeModel = activeEmbeddingModel("local");
  console.log(`  Active embedding model: ${activeModel}`);
  const isBgeM3 = activeModel.toLowerCase() === "baai/bge-m3";

  if (!isBgeM3 && !force) {
    console.error(`❌ Error: Active embedding model is ${activeModel}, NOT BAAI BGE-M3.`);
    console.error("   To proceed anyway, run the script with --force.");
    process.exit(1);
  }
  
  if (args.includes("--status")) {
    printProgress();
    process.exit(0);
  }

  const symbols = targetTicker ? [targetTicker] : undefined;

  if (isPurgeLegacy) {
    console.log("⚠️  WARNING: You are about to PURGE legacy embedding space vectors!");
    // The exact-token confirmation is the operator's explicit acknowledgement of THIS destructive
    // action specifically. The script must never supply it on their behalf — including under
    // `--yes`, which only waives the generic y/n prompts. Require it as real CLI input.
    if (!purgeToken) {
      console.error("❌ --purge-legacy requires the exact confirmation token, passed explicitly:");
      console.error("     npm run reindex-all -- --purge-legacy --purge-token <token>");
      console.error("   (The token is documented alongside purgeLegacyEmbeddingSpace; it is deliberately not printed here.)");
      process.exit(1);
    }

    const confirmed = await askConfirm("Type 'YES' to confirm you want to delete old vectors: ");
    if (!confirmed) {
      console.log("❌ Cancelled by operator.");
      process.exit(0);
    }

    const result = await purgeLegacyEmbeddingSpace({ docTypes, confirm: purgeToken, dryRun: isDryRun });
    if (!result.acquired) {
      console.error(`❌ Could not acquire lock. Busy running: ${result.busy?.group}`);
      process.exit(1);
    }

    // A refusal (wrong token, Voyage still active, a docType not completed under the current
    // embedding space) means NO vectors were removed. Exiting 0 here would let an ops wrapper
    // treat a refused purge as a successful one.
    if (!result.result?.ok) {
      console.error(`❌ Purge refused: ${result.result?.refused ?? "unknown reason"}`);
      process.exit(1);
    }

    console.log("✅ Purge Result:", JSON.stringify(result.result, null, 2));
    process.exit(0);
  }

  if (isDryRun) {
    console.log("  Running dry-run re-embed...");
    const result = await runCorpusReembedDryRun({ docTypes, symbols, maxTexts });
    if (!result.acquired) {
      console.error(`❌ Could not acquire lock. Busy running: ${result.busy?.group}`);
      process.exit(1);
    }
    console.log("✅ Dry-run Result:", JSON.stringify(result.result, null, 2));
    process.exit(0);
  }

  // Ask for confirmation for real run
  const confirmed = await askConfirm(`⚠️  Are you sure you want to start a real corpus re-embed run (consumes budget)? Type YES to confirm: `);
  if (!confirmed) {
    console.log("❌ Cancelled by operator.");
    process.exit(0);
  }

  const started = startCorpusReembedRun({ docTypes, symbols, maxTexts });
  if (!started.acquired) {
    console.error(`❌ Could not acquire lock. Busy running: ${started.busy?.group}`);
    process.exit(1);
  }

  console.log("✅ Background run started successfully! The process will continue in the background.");
  console.log("   Run with --status to check progress.");
}

run().catch((err) => {
  console.error("❌ Fatal error during reindexing:", err);
  process.exit(1);
});
