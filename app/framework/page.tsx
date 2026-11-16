import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isBlockedFrameworkClient } from "./ua-gate";
import { landingPageEnabled } from "@/lib/landing-page";
import { FrameworkViewer } from "./framework-viewer";
import { PublicShell, PUBLIC_HEADER_ACTION_CLASS } from "../ui/public/public-shell";

// Human-eyes-only page: always dynamic (per-request UA gate), never indexed,
// never cached, and the actual content is client-fetched from a gated API so
// it appears in neither this HTML document nor any client JS chunk. Layered
// with a Cloudflare WAF UA rule at the edge and robots/noai directives.
// Long-form source of truth: docs/trading-framework.md.
//
// This page also absorbed the former /how-it-works explainer (retired 2026-10-19,
// redirected here) and is the page the /welcome "Framework" button links to.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Trading Framework",
  description: "How Socratic Trade turns market data into accountable trading decisions.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    nosnippet: true,
    noimageindex: true,
    googleBot: { index: false, follow: false, noimageindex: true }
  },
  other: { "tdm-reservation": "1" }
};

const ACCESS_HREF = "mailto:mail@jays.services?subject=Socratic%20Trade%20access";

export default async function FrameworkPage() {
  // The public off-switch covers every marketing page.  This page absorbed
  // /how-it-works (which was gated), so it inherits the gate — otherwise
  // LANDING_PAGE_ENABLED=off would take /welcome down and leave the page that
  // replaced its content wide open.
  if (!landingPageEnabled()) notFound();

  const h = await headers();
  if (isBlockedFrameworkClient(h.get("user-agent"))) {
    notFound();
  }

  return (
    <PublicShell
      showIntro
      headerAction={
        <a href={ACCESS_HREF} className={PUBLIC_HEADER_ACTION_CLASS}>
          Request Access
        </a>
      }
    >
      <noscript>
        <p className="py-24 text-center text-sm text-muted">
          This page is shown to human readers in a browser and requires JavaScript.
        </p>
      </noscript>
      <FrameworkViewer />
    </PublicShell>
  );
}
