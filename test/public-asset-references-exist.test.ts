// Every static asset the app points at by absolute path must exist in public/.
//
// The P1 this pins (ST-4576) shipped because nothing checked that a referenced
// public/ asset was still there.  `14baaa0e2` deleted public/swu-logo-wide.webp
// on 2026-10-19, and the shared public footer that landed two days later
// (`d91b757f`, PR #4889) still pointed at it.  The result was a 404 image in the
// bottom rail of every public page, plus a red Playwright smoke spec on every
// main commit for five days -- with a green `verify` context the whole time,
// because the required contexts are `verify` and `gitleaks` and neither one
// looks at public/.
//
// The failure mode is quiet by construction: a missing asset renders as a
// broken image, not an exception, so nothing in the build complains.  This
// test is the missing complaint.
//
// Scope, deliberately narrow.  It scans the app source for LITERAL absolute
// paths ending in an asset extension and asserts the file is in public/.  It
// does not try to follow dynamic references (`/icons/${name}.png`), imports
// (`import logo from "@/public/logo.png"`), CSS `url()` references, or Next.js
// file-convention assets that live under app/ rather than public/ -- those are
// resolved by the framework, not by public/.  A path under /api/ is also
// skipped, because a route handler may legitimately serve it.
//
// If this test ever needs to grow a new exclusion, add it here with the reason
// -- a silent widening of the scan is how the guard stops guarding.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const APP_DIR = join(repoRoot, "app");
const PUBLIC_DIR = join(repoRoot, "public");

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const ASSET_PATH = /["'`](\/[A-Za-z0-9._/-]+\.(?:webp|png|jpe?g|gif|svg|ico|woff2?))["'`]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(abs));
      continue;
    }
    const dot = entry.name.lastIndexOf(".");
    if (dot === -1) continue;
    if (!SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
    out.push(abs);
  }
  return out;
}

/** Absolute asset paths referenced by literal string in the app source. */
function referencedAssets(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  for (const file of sourceFiles(APP_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(ASSET_PATH)) {
      const assetPath = match[1];
      if (assetPath.startsWith("/api/")) continue;
      found.push({ path: assetPath, source: file });
    }
  }
  return found;
}

describe("public asset references", () => {
  it("finds the references it is meant to check", () => {
    // If the scan ever rots into matching nothing, this test would pass
    // vacuously.  The app references more than a handful of public assets.
    expect(referencedAssets().length).toBeGreaterThanOrEqual(3);
  });

  it("points only at assets that exist in public/", () => {
    const missing = referencedAssets()
      .filter((ref) => !existsSync(join(PUBLIC_DIR, ref.path)))
      .map((ref) => `${ref.path}  (referenced in ${ref.source})`);
    expect(missing).toEqual([]);
  });

  it("keeps public/ a real directory", () => {
    // A renamed or relocated public/ directory would make the check above
    // vacuously true, so the root itself is asserted.
    expect(statSync(PUBLIC_DIR).isDirectory()).toBe(true);
  });
});
