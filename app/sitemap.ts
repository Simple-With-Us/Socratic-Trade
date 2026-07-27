import type { MetadataRoute } from "next";
import { landingPageEnabled } from "@/lib/landing-page";

const base = process.env.NEXT_PUBLIC_SITE_URL || "https://socratictrade.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const legal = [
    { url: `${base}/privacy-policy`, changeFrequency: "yearly" as const, priority: 0.3 },
    { url: `${base}/terms-and-conditions`, changeFrequency: "yearly" as const, priority: 0.3 }
  ];
  if (!landingPageEnabled()) return legal;
  return [
    { url: `${base}/welcome`, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/how-it-works`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/design/socratic-trade`, changeFrequency: "monthly", priority: 0.7 },
    ...legal
  ];
}
