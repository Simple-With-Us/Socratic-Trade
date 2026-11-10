import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL || "https://socratictrade.com";

// AI crawlers and training-data harvesters are told to stay out of the whole
// site regardless of the indexing flag. This is a published opt-out signal
// (honored by the well-behaved ones); the /framework page additionally enforces
// a user-agent gate at the edge (Cloudflare WAF) and in the route itself for
// the ones that don't ask.
const AI_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "Bytespider",
  "meta-externalagent",
  "FacebookBot",
  "cohere-ai",
  "cohere-training-data-crawler",
  "Diffbot",
  "AI2Bot",
  "omgili",
  "omgilibot",
  "TimpiBot",
  "Amazonbot",
  "YouBot",
  "PanguBot",
  "Kangaroo Bot",
  "SemrushBot-OCOB",
  "MistralAI-User",
  "DuckAssistBot"
];

export default function robots(): MetadataRoute.Robots {
  const aiRules = AI_CRAWLER_USER_AGENTS.map((userAgent) => ({
    userAgent,
    disallow: "/"
  }));
  // The app is private by default — disallow all crawling unless indexing is explicitly enabled.
  if (process.env.NEXT_PUBLIC_ALLOW_INDEXING !== "true") {
    return { rules: [{ userAgent: "*", disallow: "/" }, ...aiRules] };
  }
  // Public: only product/site pages are crawlable; the gated app + APIs are not.
  // /framework is deliberately excluded from the allow list — it is served to
  // humans in browsers only, never to crawlers of any kind. /how-it-works was
  // retired into /framework on 2026-10-19 and now 308s there.
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/welcome", "/design/socratic-trade", "/privacy-policy", "/terms-and-conditions"],
        disallow: ["/", "/api/", "/access-denied", "/framework"]
      },
      ...aiRules
    ],
    sitemap: `${base}/sitemap.xml`
  };
}
