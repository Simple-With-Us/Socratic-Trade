import { refreshFilingBodies } from "./src/lib/web-sources/sec-filings";
const t0 = Date.now();
const r = await refreshFilingBodies(["AAPL"], 1);
console.log("ELAPSED_S:", ((Date.now() - t0) / 1000).toFixed(1));
console.log("RESULT:", JSON.stringify(r, null, 2));
