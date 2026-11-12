/**
 * After `next build`, copy sha256 sources from prerendered HTML into the
 * middleware bundle.  The sentinel is a string literal in src/lib/csp-policy.ts.
 * A second build is not required: patching the bundle does not change the HTML.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { inlineScriptHashes } from "./csp-html-hashes.mjs";

const SENTINEL = "__ST2789_STATIC_HASHES__";
const REQUIRED = ["/welcome", "/privacy-policy", "/terms-and-conditions"];
const root = process.cwd();
const middlewarePath = join(root, ".next/server/middleware.js");
const appDir = join(root, ".next/server/app");

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (name.endsWith(".html")) acc.push(path);
  }
  return acc;
}

function routeFromFile(file) {
  let rel = relative(appDir, file).replaceAll("\\", "/").replace(/\.html$/, "");
  if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);
  const parts = rel.split("/");
  if (parts.some((part) => part.startsWith("_") || part.startsWith("(") || part.startsWith("@"))) return null;
  if (rel === "index" || rel === "") return "/";
  return `/${rel}`;
}

if (!existsSync(middlewarePath)) {
  console.error("stamp-csp-static-hashes: .next/server/middleware.js is missing");
  process.exit(1);
}

const table = {};
if (existsSync(appDir)) {
  for (const file of walk(appDir)) {
    const route = routeFromFile(file);
    if (!route) continue;
    const hashes = inlineScriptHashes(readFileSync(file, "utf8"));
    if (hashes.length === 0) continue;
    table[route] = hashes;
  }
}

const missing = REQUIRED.filter((route) => !table[route]?.length);
if (missing.length > 0) {
  console.error(`stamp-csp-static-hashes: no prerendered inline scripts for ${missing.join(", ")}`);
  process.exit(1);
}

const bundle = readFileSync(middlewarePath, "utf8");
const count = bundle.split(SENTINEL).length - 1;
if (count !== 1) {
  console.error(`stamp-csp-static-hashes: expected the sentinel once in middleware.js, found ${count}`);
  process.exit(1);
}

const payload = JSON.stringify(JSON.stringify(table)).slice(1, -1);
writeFileSync(middlewarePath, bundle.replace(SENTINEL, payload));
console.log(`stamp-csp-static-hashes: ${Object.keys(table).sort().join(", ")}`);
