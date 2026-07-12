import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://socratictrade.com";

export default function robots(): MetadataRoute.Robots {
  // The app is private by default — disallow all crawling unless indexing is explicitly enabled.
  if (process.env.NEXT_PUBLIC_ALLOW_INDEXING !== "true") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  // Public: only product/site pages are crawlable; the gated app + APIs are not.
  return {
    rules: {
      userAgent: "*",
      allow: ["/welcome", "/how-it-works", "/design/socratic-trade"],
      disallow: ["/", "/api/", "/access-denied"]
    },
    sitemap: `${base}/sitemap.xml`
  };
}
