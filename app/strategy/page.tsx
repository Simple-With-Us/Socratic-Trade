import { notFound, redirect } from "next/navigation";
import { landingPageEnabled } from "@/lib/landing-page";

// NAV_V2 PR #5: the public explainer was renamed /strategy → /how-it-works.
// `/strategy` is kept as a redirect shim. When marketing pages are disabled, both 404.
export default function StrategyRedirectPage() {
  if (!landingPageEnabled()) notFound();
  redirect("/how-it-works");
}
