import fs from "fs";

let content = fs.readFileSync("/Users/jay/apps/trading-antigravity/src/lib/data-providers.ts", "utf8");

content = content.replace(
  `    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const raw = await this.getJson(\`\${this.base}/gedetailedtinsiders/\${encodeURIComponent(symbol)}?timeframe=1y\`);`,
  `    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const admitted = tryReserveRapidApiCalls("insiders-rapidapi", 1, now) > 0;
          if (!admitted) { result[symbol] = {}; return; }
          try {
            const raw = await this.getJson(\`\${this.base}/gedetailedtinsiders/\${encodeURIComponent(symbol)}?timeframe=1y\`);`
);

content = content.replace(
  `    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const raw = await this.getJson(\`\${this.base}/quote?symbol=\${encodeURIComponent(symbol)}&interval=1day\`);`,
  `    const CONCURRENCY = 3;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const chunk = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (symbol) => {
          const admitted = tryReserveRapidApiCalls("twelvedata-rapidapi", 1, now) > 0;
          if (!admitted) { result[symbol] = {}; return; }
          try {
            const raw = await this.getJson(\`\${this.base}/quote?symbol=\${encodeURIComponent(symbol)}&interval=1day\`);`
);

fs.writeFileSync("/Users/jay/apps/trading-antigravity/src/lib/data-providers.ts", content);
