#!/usr/bin/env node

/** Resizes public/icon.png (transparent cropped candlestick ST) to the
 *  raster sizes the PWA manifest needs.  Does NOT write the iOS App Icon
 *  (that is the separate dollar-sign mark).  Re-run after
 *  scripts/generate-favicon-st.py:
 *
 *    node scripts/generate-pwa-icons.mjs
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_PNG = path.join(ROOT, "public", "icon.png");

const TARGETS = [
  { file: "icon-32.png", size: 32, flatten: false },
  { file: "icon-192.png", size: 192, flatten: false },
  { file: "icon-512.png", size: 512, flatten: false },
  { file: "apple-touch-icon-180.png", size: 180, flatten: true }
];

async function main() {
  const outDir = path.join(ROOT, "public", "icons");
  await mkdir(outDir, { recursive: true });
  for (const { file, size, flatten } of TARGETS) {
    const outPath = path.join(outDir, file);
    let pipeline = sharp(SOURCE_PNG).resize(size, size);
    if (flatten) pipeline = pipeline.flatten({ background: "#ffffff" });
    await pipeline.png().toFile(outPath);
    console.log(`wrote ${path.relative(ROOT, outPath)} (${size}x${size})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
