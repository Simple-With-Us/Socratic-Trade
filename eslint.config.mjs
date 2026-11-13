// Flat ESLint config (ESLint 10 + eslint-config-next 16.4+).
//
// `eslint-config-next/core-web-vitals` already spreads the base Next config
// (React, React-Hooks, import, jsx-a11y, @next/next) and adds the
// Core Web Vitals rules; `eslint-config-next/typescript` adds the
// typescript-eslint recommended ruleset. Together they reproduce what the
// legacy `next lint` default ("next/core-web-vitals" + "next/typescript")
// enabled.
//
// Rollout note: this is wired into the required `verify` CI gate. ESLint only
// fails the build on *errors*, not warnings, so several broad rules are pinned
// to "warn" below to keep the initial baseline green while still surfacing
// issues. Tighten these to "error" and burn down the warnings over time.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  ...coreWebVitals,
  ...typescript,
  {
    // Generated / vendored / data output that should not be linted.
    ignores: [
      ".next/**",
      "**/.next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "data/**",
      ".claude/**",
      ".agents/**",
      ".tools/**",
      "**/worktrees/**",
      "**/.worktrees/**",
      "scratch/**",
      "ds-bundle/**",
      ".design-sync/**",
      ".ds-sync/**",
    ],
  },
  {
    files: [ "**/*.{js,jsx,mjs,ts,tsx,mts,cts}" ],
    // Baseline triage: these rules have a pre-existing backlog of violations
    // (mostly `any` in tests and an opinionated effect rule). They are pinned to
    // "warn" so the required `verify` CI gate is green today while still
    // surfacing the debt. Everything else from the Next/TS presets stays at its
    // default severity (most are "error"), so the gate blocks NEW regressions of
    // rules that currently pass (e.g. rules-of-hooks, critical @next/next rules,
    // import errors, syntax errors). Promote these back to "error" and burn down
    // the warnings over time.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react/no-unescaped-entities": "warn",
      "react/display-name": "warn",
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
  {
    // Client/server bundle boundary (2026-08-01).
    //
    // `app/console/**` is a client tree (`app/mobile/**` is a redirect-only leftover):
    // nearly every module under the console is reachable from a "use client" component, so a
    // single value-import of a server module drags
    // its whole transitive graph into the browser bundle. That is not hypothetical — importing
    // `inferExternalCashFlows` from `@/lib/benchmark` pulled `history.ts` → the `db` barrel →
    // migrations and API-key crypto into a client chunk, which is why the browser console was
    // warning about a missing `ENCRYPTION_KEY`. The fix was to extract the pure helper into
    // `@/lib/cash-flows`; this rule is what stops the next person re-attaching it.
    //
    // `allowTypeImports: true` is deliberate — `import type` is erased before bundling, so a
    // type-only reference to `@/lib/db` (e.g. `PositionStopPlan` in console/lib/derive.ts) costs
    // the bundle nothing and stays legal.
    //
    // Server work belongs in a route handler or server component under `app/api/**`; the client
    // should be calling it over HTTP, not importing it.
    files: ["app/console/**/*.{ts,tsx}", "app/mobile/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/db",
                "@/lib/db-*",
                "@/lib/history",
                "@/lib/benchmark",
                "@/lib/strategy",
                "@/lib/scheduler",
                "@/lib/market",
                "@/lib/broker",
                "@/lib/broker-health",
                "@/lib/broker-minimum-guard",
                "@/lib/broker-protective-stops",
                "@/lib/llm-budget",
                "@/lib/llm-call",
                "@/lib/llm-provider*",
                "@/lib/llm-usage",
              ],
              allowTypeImports: true,
              message:
                "Server-only module: value-importing this from a client tree pulls the DB/crypto graph into the browser bundle. Extract the pure part (see @/lib/cash-flows) or call an API route. `import type` is fine.",
            },
          ],
        },
      ],
    },
  },
];
