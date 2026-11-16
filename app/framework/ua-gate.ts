// User-agent gate for the /framework surface (page + content API).
//
// The framework page is served to human readers in browsers only. This list
// blocks known AI crawlers/assistants, SEO/data harvesters, HTTP libraries,
// and headless-automation signatures. It intentionally mirrors the
// Cloudflare WAF rule scoped to /framework* at the edge — keep the two in
// sync when adding entries (see docs/rollouts/2026-07-11-framework-page.md).
//
// Matching is lowercase-substring. Entries must never match a real end-user
// browser UA (Chrome/Safari/Firefox/Edge, mobile variants).

const BLOCKED_UA_FRAGMENTS = [
  // AI crawlers / assistants / training-data harvesters
  "gptbot",
  "chatgpt",
  "oai-searchbot",
  "claudebot",
  "claude-web",
  "claude-user",
  "claude-searchbot",
  "anthropic",
  "ccbot",
  "bytespider",
  "perplexity",
  "google-extended",
  "applebot-extended",
  "meta-external",
  "facebookbot",
  "diffbot",
  "cohere",
  "ai2bot",
  "omgili",
  "timpibot",
  "youbot",
  "amazonbot",
  "petalbot",
  "mistralai",
  "duckassistbot",
  // SEO / data harvesters
  "semrush",
  "ahrefs",
  "mj12bot",
  "dotbot",
  "dataforseo",
  "zoominfobot",
  "serpstat",
  // HTTP libraries / CLI clients / headless automation
  "scrapy",
  "python-requests",
  "python-httpx",
  "python-urllib",
  "aiohttp",
  "curl/",
  "wget/",
  "libwww",
  "go-http-client",
  "okhttp",
  "java/",
  "node-fetch",
  "axios/",
  "undici",
  "headlesschrome",
  "phantomjs",
  "selenium",
  "puppeteer",
  "playwright"
];

/** True when the request's user agent is empty or matches a blocked client. */
export function isBlockedFrameworkClient(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim().toLowerCase();
  if (!ua) return true;
  return BLOCKED_UA_FRAGMENTS.some((fragment) => ua.includes(fragment));
}
