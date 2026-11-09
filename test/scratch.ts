import { getEnrichmentProvider } from "../src/lib/data-providers";
import { fetchMacroData } from "../src/lib/macro";

async function run() {
  console.log("=== Testing MacroData (VIX) ===");
  try {
    const macro = await fetchMacroData();
    console.log(JSON.stringify(macro, null, 2));
  } catch (error) {
    console.error("Macro data failed:", error);
  }

  console.log("\n=== Testing Enrichment Providers (Alpha Vantage & FMP Insider) ===");
  try {
    const provider = getEnrichmentProvider();
    console.log(`Using cascade: ${provider.name}`);
    const results = await provider.enrich(["AAPL"]);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error("Enrichment failed:", error);
  }
}

run();
