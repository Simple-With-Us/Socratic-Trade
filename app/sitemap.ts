import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://socratictrade.com";

export default function sitemap(): MetadataRoute.Sitemap {
  // Only public product pages belong in the sitemap; the app itself is gated.
  return [
    { url: `${base}/welcome`, changeFrequency: "monthly", priority: 1 },
    { url: `${base}/how-it-works`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/design/socratic-trade`, changeFrequency: "monthly", priority: 0.7 }
  ];
}
