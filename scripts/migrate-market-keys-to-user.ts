// One-off migration: move MARKET-DATA provider keys from environment variables into the per-user
// API-key store for a user (default "local"), and opt that user into the shared data pool. This
// supports the model where individual users supply their own market-data keys (consent-gated
// sharing) instead of relying on global env keys. Operational keys (OpenAI, Pinecone, Voyage,
// ENCRYPTION_KEY, broker OAuth) are intentionally NOT migrated and stay in the environment.
//
// No secrets live in this file — values are read from .env.local / the environment. Alpaca can be
// overridden with MIGRATE_ALPACA_KEY / MIGRATE_ALPACA_SECRET on the command line.
//
//   npx tsx scripts/migrate-market-keys-to-user.ts            (migrate for "local")
//   MIGRATE_USER=local MIGRATE_ALPACA_KEY=... MIGRATE_ALPACA_SECRET=... npx tsx scripts/migrate-market-keys-to-user.ts
import fs from "node:fs";
import path from "node:path";

// tsx does not auto-load .env.local; parse it into process.env (without clobbering already-set vars).
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { upsertUserApiKey, setDataPoolConsent, resolveApiKeyWithSource } = await import("../src/lib/db");

const USER = process.env.MIGRATE_USER || "local";

// canonical service name → env var it currently lives under
const MARKET_SERVICES: Array<[string, string]> = [
  ["finnhub", "FINNHUB_API_KEY"],
  ["fmp", "FMP_API_KEY"],
  ["alphavantage", "ALPHAVANTAGE_API_KEY"],
  ["marketstack", "MARKETSTACK_API_KEY"],
  ["fred", "FRED_API_KEY"],
  ["massive", "MASSIVE_API_KEY"],
  ["apify", "APIFY_API_TOKEN"],
  ["alpaca_paper_api_key", "ALPACA_PAPER_API_KEY"],
  ["alpaca_paper_secret_key", "ALPACA_PAPER_SECRET_KEY"]
];

const overrides: Record<string, string | undefined> = {
  alpaca_paper_api_key: process.env.MIGRATE_ALPACA_KEY,
  alpaca_paper_secret_key: process.env.MIGRATE_ALPACA_SECRET
};

const migrated: string[] = [];
for (const [service, envVar] of MARKET_SERVICES) {
  const value = (overrides[service] ?? process.env[envVar])?.trim();
  if (value) {
    upsertUserApiKey(USER, service, value);
    migrated.push(service);
  }
}

setDataPoolConsent(USER, true);

console.log(`migrated ${migrated.length} services for user "${USER}": ${migrated.join(", ")}`);
for (const s of migrated) {
  const r = resolveApiKeyWithSource(s, USER);
  console.log(`  ${s}: source=${r.source} ${r.key ? "(present)" : "(MISSING!)"}`);
}
console.log(`data-pool consent for "${USER}": accepted`);
