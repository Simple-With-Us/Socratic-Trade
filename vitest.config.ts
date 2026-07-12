import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/": resolve(__dirname, "./src/")
    }
  },
  test: {
    maxWorkers: 4,
    testTimeout: 20_000,
    // Force isTradingDay()'s no-argument "today" check true so strategy/scheduler tests don't flake
    // on real market holidays/weekends (see isTradingDay in src/lib/market-calendar.ts). The override
    // there is additionally gated on process.env.VITEST, so a stray copy of this flag in a dev/prod
    // shell can never defeat the real market-closed guard. Explicit-date calendar calls ignore it.
    env: { AGENTIC_TEST_FORCE_TRADING_DAY: "1" },
    exclude: [
      "node_modules/**",
      ".next/**",
      ".claude/**",
      ".agents/**",
      ".cursor/**",
      ".codex/**",
      "test/e2e/**",
      "reference/**"
    ]
  }
});
