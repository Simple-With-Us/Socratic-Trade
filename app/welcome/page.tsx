import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "../ui/primitives";
import { DecisionTraceIllustration } from "./decision-trace-illustration";
import { landingPageEnabled } from "@/lib/landing-page";

// Background-revalidate hourly: same fix as the legal pages — the CDN-cached prerender
// was leaving a deployed docs edit stale for up to a year.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: { absolute: "Socratic Trade" },
  description:
    "Socratic Trade brings market research, connected-account controls, and decision records into one workspace.  Not investment advice.",
  alternates: { canonical: "/welcome" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/welcome",
    title: "Socratic Trade",
    description:
      "Market research, configured trading workflows, and decision records for review.  Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "Socratic Trade",
    description: "Market research and connected-account workflows with decision records for review.  Not investment advice."
  },
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

const ACCESS_HREF =
  "mailto:mail@jays.services?subject=Socratic%20Trade%20access";
const PRIMARY_LINK =
  "inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";
const GHOST_LINK =
  "inline-flex h-10 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";
const PRIMARY_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";
const GHOST_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: "Market research",
    body: "Uses available market data, portfolio context, scan results, and prior records to propose a market thesis."
  },
  {
    title: "Decision trace",
    body: "Review recorded proposals and actions, including their rationale, status, supporting evidence, and objections when available."
  },
  {
    title: "Evidence attribution",
    body: "Decision records can include source references, retrieved context, and market data so you can inspect the inputs."
  },
  {
    title: "Alternative views",
    body: "Compare recorded bull and bear cases, policy checks, and objections when those reviews are enabled."
  },
  {
    title: "Outcome review",
    body: "Review available outcomes by thesis, market conditions, and model choice to help assess the workflow."
  },
  {
    title: "Coaching and framework review",
    body: "Add feedback and inspect proposed framework changes, review decisions, and their recorded status."
  }
];

const STEPS: Array<{ n: number; title: string; detail: string }> = [
  {
    n: 1,
    title: "Observe the market",
    detail:
      "Review available market signals, account state, candidates, and prior records from configured sources."
  },
  {
    n: 2,
    title: "Review proposals and authority",
    detail:
      "Use Ask-First for proposals that require approval, or configure Autopilot and its controls for a connected account."
  },
  {
    n: 3,
    title: "Review results",
    detail:
      "Inspect recorded evidence, objections, outcomes, and coaching notes when assessing a proposed framework change."
  }
];

export default function WelcomePage() {
  if (!landingPageEnabled()) notFound();
  return (
    <>
      {/* JSON-LD structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Socratic Trade",
            applicationCategory: "FinanceApplication",
            operatingSystem: "Web",
            description:
              "Market research and connected-account workflows with decision records for review."
          })
        }}
      />

      <div className="min-h-screen bg-bg text-fg">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <span className="text-base font-semibold text-fg">Socratic Trade</span>
            <a href={ACCESS_HREF} className={PRIMARY_LINK_SM}>
              Request access
            </a>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-16 space-y-20">
          {/* ── Hero ───────────────────────────────────────────────────────── */}
          <section className="text-center space-y-6">
            <h1 className="text-4xl font-bold tracking-tight text-fg sm:text-5xl">
              A workspace for market research and trading workflows
            </h1>
            <p className="mx-auto max-w-2xl text-lg text-muted leading-relaxed">
              Socratic Trade brings research, proposals, and connected-account controls together.
              {"  "}Review the available evidence and decision records, and choose the authority
              you give the system.
            </p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <a href={ACCESS_HREF} className={PRIMARY_LINK}>
                Request access
              </a>
              <a href="/how-it-works" className={GHOST_LINK}>
                Decision framework
              </a>
            </div>
            <p className="text-sm text-faint">Private beta · Access by invitation.</p>
          </section>

          {/* ── Features grid ──────────────────────────────────────────────── */}
          <section className="space-y-6">
            <h2 className="text-xl font-semibold text-fg">What it does</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <Card key={f.title} className="p-5 space-y-2">
                  <h3 className="text-sm font-semibold text-fg">{f.title}</h3>
                  <p className="text-sm text-muted leading-relaxed">{f.body}</p>
                </Card>
              ))}
            </div>
            <p className="text-xs text-faint leading-relaxed">
              Data coverage and recorded detail depend on your sources, settings, and completed
              runs. {"  "}Review the underlying records when evaluating a result.
            </p>
          </section>

          {/* ── How it works ───────────────────────────────────────────────── */}
          <section className="space-y-6">
            <h2 className="text-xl font-semibold text-fg">How it works</h2>
            <ol className="space-y-4">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg text-sm font-bold">
                    {s.n}
                  </span>
                  <div className="space-y-1 pt-1">
                    <p className="text-sm font-semibold text-fg">{s.title}</p>
                    <p className="text-sm text-muted leading-relaxed">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ── Decision trace illustration ────────────────────────────────── */}
          <section className="space-y-6">
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold text-fg">What a decision trace looks like</h2>
              <p className="mx-auto max-w-2xl text-sm text-muted leading-relaxed">
                An illustrative decision record showing supporting arguments, objections, and a
                policy check. {"  "}Available detail varies by proposal and configuration.
              </p>
            </div>
            <DecisionTraceIllustration />
          </section>

          {/* ── Strategy overview link ─────────────────────────────────────── */}
          <section className="space-y-3 text-center">
            <h2 className="text-xl font-semibold text-fg">How the decision framework works</h2>
            <p className="mx-auto max-w-2xl text-sm text-muted leading-relaxed">
              The workflow connects research, alternative views, account controls, and outcome
              review. {"  "}The framework overview explains how these parts fit together.
            </p>
            <a href="/how-it-works" className={GHOST_LINK_SM}>
              Read the full framework overview
            </a>
          </section>

          {/* ── Disclosures ────────────────────────────────────────────────── */}
          <section>
            <Card className="p-6 space-y-4 border-line-strong">
              <h2 className="text-base font-semibold text-fg">Important disclosures</h2>
              <p className="text-sm text-muted leading-relaxed">
                Socratic Trade is software for market research, autonomous reasoning, and trade
                execution when connected to accounts you configure.  It is not investment advice, a
                broker-dealer, or a registered investment adviser.
              </p>
              <p className="text-sm text-muted leading-relaxed">
                Trading and investing involve substantial risk of loss.  Simulated or hypothetical
                performance has inherent limitations and is not a guarantee of future results.
                Nothing here is a recommendation to buy or sell any security.
              </p>
              <p className="text-sm text-muted leading-relaxed">
                You are solely responsible for your own investment decisions.  Consult a licensed
                financial professional before trading.
              </p>
            </Card>
          </section>
        </main>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="border-t border-line mt-8">
          <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
            <p className="text-xs text-faint">
              Not investment advice.  You set authority.{" "}
              <a href="/terms-and-conditions" className="underline underline-offset-2 hover:text-muted">
                Terms
              </a>
              {" · "}
              <a href="/privacy-policy" className="underline underline-offset-2 hover:text-muted">
                Privacy
              </a>
            </p>
            <p className="text-xs text-faint">
              &copy; 2026 Socratic Trade &middot;{" "}
              <a
                href="mailto:mail@jays.services"
                className="underline underline-offset-2 hover:text-muted"
              >
                mail@jays.services
              </a>
              {" · "}
              <a
                href="https://simplewithus.com/"
                aria-label="From Simple With Us"
                className="inline-flex items-center gap-1.5 align-middle hover:text-muted focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <span>From</span>
                <img src="/swu-logo-wide.webp" alt="Simple With Us by Jay Wedgeworth" width={288} height={30} className="h-auto max-w-[calc(100vw-92px)] rounded-sm bg-white" />
              </a>
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
