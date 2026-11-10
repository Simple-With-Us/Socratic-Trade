#!/usr/bin/env node

/** Resize public/icon.png to the website PNG sizes Safari and some
 *  Android installers need.  Re-run after the master favicon changes:
 *
 *    node scripts/generate-favicon-st.mjs
 *    node scripts/generate-pwa-icons.mjs
 *
 *  Website only.  Do not write the iOS App Icon
 *  (ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png).
 *  That asset stays the native home-screen mark.
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { websitePngTargets } from "./generate-favicon-st.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_PNG = path.join(ROOT, "public", "icon.png");

async function main() {
  for (const { file, size, flattenBlack } of websitePngTargets()) {
    if (file.includes("AppIcon") || file.includes(`${path.sep}ios${path.sep}`)) {
      throw new Error("website icon generator must not write the iOS App Icon");
    }
    await mkdir(path.dirname(file), { recursive: true });
    let pipeline = sharp(SOURCE_PNG).resize(size, size, {
      fit: "contain",
      background: flattenBlack ? { r: 0, g: 0, b: 0, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 }
    });
    if (flattenBlack) {
      pipeline = pipeline.flatten({ background: { r: 0, g: 0, b: 0 } });
    }
    await pipeline.png().toFile(file);
    console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
