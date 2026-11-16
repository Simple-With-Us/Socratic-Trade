// Classify whether a Coolify image rebuild can change socratictrade.com.
//
// Live Coolify `watch_paths` on socratic-app (see fleet-ops:ATTACK-MAP.md)
// was applied by ASC 2026-08-18.  App stayed healthy; no bounce.  Do NOT
// re-apply or PATCH that list from a PR.  Auto-deploy stays on.  Stop-old-
// first stays.  health_check_start_period stays 60.
//
// The Dockerfile image-noop latch is belt-and-suspenders if someone clicks
// Deploy on a docs-only SHA.  Fail CLOSED for skip: unknown / mixed paths
// are image-relevant.  Do not enable Coolify rolling.

/** Already live on Coolify.  Record only -- do not PATCH from this repo. */
export const COOLIFY_WATCH_PATHS_LIVE = [
  "Dockerfile",
  ".dockerignore",
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "postcss.config.mjs",
  "tsconfig.json",
  "middleware.ts",
  "instrumentation.ts",
  "instrumentation-client.ts",
  "sentry.server.config.ts",
  "sentry.edge.config.ts",
  "litestream.coolify.yml",
  "src",
  "src/**",
  "app",
  "app/**",
  "public",
  "public/**",
  "scripts",
  "scripts/**"
] as const;

/** Intentionally omitted from live watch_paths (docs-only / non-image). */
export const COOLIFY_WATCH_PATHS_OMITTED = [
  "docs/**",
  "STATUS.md",
  "PLAN.md",
  "docs/rollouts",
  "ios/",
  "test/"
] as const;

export function parseChangedFiles(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Same rule as `.github/workflows/ci.yml` classify: `*.md` anywhere or `docs/**`. */
export function isDocsOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.endsWith(".md")) return true;
  return normalized === "docs" || normalized.startsWith("docs/");
}

export function isDocsOnlyChange(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((path) => isDocsOnlyPath(path));
}

/**
 * Paths that cannot change the Coolify runtime image.  `docs/benchmarks/**`
 * is image-relevant (Next imports those JSON files at build time).
 */
export function isImageNoopPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("docs/benchmarks/") || normalized === "docs/benchmarks") {
    return false;
  }
  if (normalized.endsWith(".md")) return true;
  if (normalized === "docs" || normalized.startsWith("docs/")) return true;
  if (normalized === "ios" || normalized.startsWith("ios/")) return true;
  if (normalized === "test" || normalized.startsWith("test/")) return true;
  if (normalized === ".github" || normalized.startsWith(".github/")) return true;
  if (normalized === ".cursor" || normalized.startsWith(".cursor/")) return true;
  if (normalized === ".claude" || normalized.startsWith(".claude/")) return true;
  if (normalized === "ci-pending" || normalized.startsWith("ci-pending/")) return true;
  if (normalized === "pdf_pages" || normalized.startsWith("pdf_pages/")) return true;
  if (normalized === "reference" || normalized.startsWith("reference/")) return true;
  if (normalized.endsWith(".pdf") || normalized.endsWith(".PDF")) return true;
  return false;
}

export function isImageNoopChange(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((path) => isImageNoopPath(path));
}

export const ISSUE_2811_DOCS_ONLY_PATHS = [
  "PLAN.md",
  "STATUS.md",
  "docs/EFFORT-LOG.md",
  "docs/audits/2026-08-18-pinecone-store-vs-condense.md",
  "docs/phase-7-strategy.md",
  "docs/rollouts/2026-08-18-pinecone-store-vs-condense.md"
] as const;
