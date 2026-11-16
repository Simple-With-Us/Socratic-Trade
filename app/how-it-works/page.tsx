import { notFound, permanentRedirect } from "next/navigation";
import { landingPageEnabled } from "@/lib/landing-page";

// 2026-10-19 (owner): /how-it-works was retired. Its content — the plain-language
// decision loop, the decision case file, the authority controls, and the outcome
// review lenses — was folded into /framework, which is now the single public
// explainer and the target of the /welcome "Framework" button.
//
// The route is kept as a 308 (not a 404) so any inbound link, bookmark, or
// search result still lands on the content instead of a dead end. When marketing
// pages are disabled, both the old page and the new one 404 together.
export default function HowItWorksRedirectPage() {
  if (!landingPageEnabled()) notFound();
  permanentRedirect("/framework");
}
