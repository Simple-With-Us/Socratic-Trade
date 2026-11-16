import type { MetadataRoute } from "next";
import { landingPageEnabled } from "@/lib/landing-page";

const base = process.env.NEXT_PUBLIC_SITE_URL || "https://socratictrade.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const legal = [
    { url: `${base}/privacy-policy`, changeFrequency: "yearly" as const, priority: 0.3 },
    { url: `${base}/terms-and-conditions`, changeFrequency: "yearly" as const, priority: 0.3 }
  ];
  if (!landingPageEnabled()) return legal;
  // /framework is deliberately NOT listed: it is served to human readers in
  // browsers only (UA-gated at the edge and in the route, noindex, noai) and
  // was never part of the crawlable surface. /how-it-works was retired into it
  // on 2026-10-19.
  return [
    { url: `${base}/welcome`, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/design/socratic-trade`, changeFrequency: "monthly", priority: 0.7 },
    ...legal
  ];
}
