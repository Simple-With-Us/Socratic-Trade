import { notFound, permanentRedirect } from "next/navigation";
import { landingPageEnabled } from "@/lib/landing-page";

// NAV_V2 PR #5: the public explainer was renamed /strategy → /how-it-works.
// 2026-10-19: /how-it-works was retired into /framework, so this shim now points
// straight at the canonical page — one hop, not two. When marketing pages are
// disabled, this 404s like the rest of the public surface.
export default function StrategyRedirectPage() {
  if (!landingPageEnabled()) notFound();
  permanentRedirect("/framework");
}
