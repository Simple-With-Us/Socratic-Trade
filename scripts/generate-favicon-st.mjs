#!/usr/bin/env node

/** Build website favicon, PWA sizes, ASC listing icon, and Android launcher
 *  master from the owner transparent candlestick ST.
 *
 *  Source (read-only): graphics/st-candlestick-favicon-owner.png
 *  Website only plus graphics/asc and graphics/android.  This script never writes the iOS App Icon file
 *  (ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png).
 *
 *    node scripts/generate-favicon-st.mjs
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const OWNER_FAVICON_SOURCE = path.join(
  ROOT,
  "graphics",
  "st-candlestick-favicon-owner.png"
);

/** Kept so tests can assert the native iOS path is never a write target. */
export const APP_ICON_SOURCE = path.join(
  ROOT,
  "ios",
  "SocraticTrade",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "AppIcon-1024.png"
);

const WEBSITE_PNGS = [
  { file: path.join(ROOT, "public", "icon.png"), size: 1024, flattenBlack: false },
  { file: path.join(ROOT, "public", "icons", "icon-32.png"), size: 32, flattenBlack: false },
  { file: path.join(ROOT, "public", "icons", "icon-192.png"), size: 192, flattenBlack: false },
  { file: path.join(ROOT, "public", "icons", "icon-512.png"), size: 512, flattenBlack: false },
  { file: path.join(ROOT, "public", "icons", "apple-touch-icon-180.png"), size: 180, flattenBlack: true },
  { file: path.join(ROOT, "public", "apple-touch-icon.png"), size: 180, flattenBlack: true },
  { file: path.join(ROOT, "public", "apple-touch-icon-precomposed.png"), size: 180, flattenBlack: true }
];

export function websitePngTargets() {
  return WEBSITE_PNGS.map((target) => ({ ...target }));
}

function assertNotIosAppIcon(file) {
  if (file.includes("AppIcon") || file.includes(`${path.sep}ios${path.sep}`)) {
    throw new Error("website icon generator must not write the iOS App Icon");
  }
}

async function writePng(file, pipeline) {
  assertNotIosAppIcon(file);
  await mkdir(path.dirname(file), { recursive: true });
  await pipeline.png().toFile(file);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

export async function buildWebsiteFavicon() {
  const meta = await sharp(OWNER_FAVICON_SOURCE).metadata();
  if (meta.width !== 1024 || meta.height !== 1024) {
    throw new Error(`expected 1024x1024 owner mark, got ${meta.width}x${meta.height}`);
  }
  const master = await sharp(OWNER_FAVICON_SOURCE).ensureAlpha().png().toBuffer();
  return { master };
}

async function writeDerived(master) {
  for (const { file, size, flattenBlack } of WEBSITE_PNGS) {
    let pipeline = sharp(master).resize(size, size, {
      fit: "contain",
      background: flattenBlack ? { r: 0, g: 0, b: 0, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 }
    });
    if (flattenBlack) {
      pipeline = pipeline.flatten({ background: { r: 0, g: 0, b: 0 } });
    }
    await writePng(file, pipeline);
  }

  await writePng(
    path.join(ROOT, "graphics", "android-launcher-icon-1024.png"),
    sharp(master).resize(1024, 1024)
  );

  await writePng(
    path.join(ROOT, "graphics", "asc-app-icon-1024.png"),
    sharp(master)
      .resize(1024, 1024)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .removeAlpha()
  );
}

async function main() {
  const { master } = await buildWebsiteFavicon();
  await writeDerived(master);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
