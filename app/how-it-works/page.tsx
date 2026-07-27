import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "../ui/primitives";
import { DecisionLoopDiagram } from "./decision-loop-diagram";
import { landingPageEnabled } from "@/lib/landing-page";

export const metadata: Metadata = {
  title: "Decision framework",
  description:
    "How Socratic Trade forms a thesis, weighs evidence and memory, handles dissent, acts under delegated authority, and learns from outcomes. Not investment advice.",
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    type: "website",
    siteName: "Socratic Trade",
    url: "/how-it-works",
    title: "Socratic Trade decision framework",
    description:
      "How Socratic Trade forms a thesis, weighs evidence and memory, handles dissent, acts under delegated authority, and learns from outcomes. Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "Socratic Trade decision framework",
    description:
      "Autonomous market reasoning with visible thesis, evidence, dissent, authority, action, outcome, and framework learning."
  },
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

const CORE_LOOP: Array<{ title: string; body: string }> = [
  {
    title: "Observe",
    body: "Read market regime, account state, open positions, candidate scans, news, fundamentals, technicals, and prior outcome memory."
  },
  {
    title: "Argue",
    body: "Build a thesis, retrieve relevant prior cases, identify what evidence supports or weakens the idea, and force a counterargument before acting."
  },
  {
    title: "Decide",
    body: "Choose buy, sell, hold, wait, resize, exit, or reject. The decision records the authority source, policy checks, and exposure impact."
  },
  {
    title: "Act",
    body: "When delegated authority allows action, Socratic Trade records proposed, placed, filled, rejected, expired, and blocked states separately."
  },
  {
    title: "Explain",
    body: "The decision note shows what it believed, why it believed it, what memory contributed, what could prove it wrong, and what it did."
  },
  {
    title: "Learn",
    body: "Closed and counterfactual outcomes feed scorecards by thesis, regime, model, and evidence quality, then become framework-improvement proposals."
  }
];

const DECISION_FILE: Array<{ title: string; body: string }> = [
  {
    title: "Thesis",
    body: "Plain-language claim, expected edge, time horizon, catalyst, invalidation trigger, and linked positions."
  },
  {
    title: "Evidence",
    body: "Source-backed bullets split across market data, fundamentals, technicals, news, portfolio context, and freshness."
  },
  {
    title: "Memory influence",
    body: "Prior cases from retrieval, whether they reinforced or weakened the decision, and how they changed sizing or action."
  },
  {
    title: "Counterargument",
    body: "The best reason the thesis could be wrong, the competing action, and the condition that would invalidate the current view."
  },
  {
    title: "Action taken",
    body: "Final action, status, order details when applicable, and the authority or blocker that allowed or prevented it."
  },
  {
    title: "Outcome",
    body: "Fill state, realized or unrealized result, actual vs. expected movement, and what the model got right or wrong."
  },
  {
    title: "Framework improvement",
    body: "A proposed change to prompt, retrieval, risk, sizing, universe, or rules, with accept/reject/rewrite status."
  }
];

const AUTHORITY_ITEMS: string[] = [
  "Scope: symbol, watchlist, strategy, sector, account, or market regime.",
  "Permission: suggest only, delegated action, close-only, or halted.",
  "Limits: max notional, max daily loss, max concurrent positions, concentration, and side permissions.",
  "Evidence threshold: minimum source count, contradiction tolerance, and freshness window.",
  "Review mode: notify before action, notify after action, or alert only when blocked.",
  "Override explanation: when the agent chooses offense during stress, it must say what changed its mind and what would have blocked it."
];

const LEARNING_ITEMS: Array<{ title: string; body: string }> = [
  {
    title: "Thesis scorecards",
    body: "Which thesis types worked, failed, or needed a different holding period."
  },
  {
    title: "Regime scorecards",
    body: "Whether the same idea behaved differently in calm, stressed, bearish, bullish, or flash-crash conditions."
  },
  {
    title: "Evidence quality",
    body: "Which sources, retrieval memories, and contradictions actually improved decisions after outcomes are known."
  },
  {
    title: "Mistake review",
    body: "False positives, missed opportunities, late exits, overruled wins, overruled losses, and repeated failure modes."
  }
];

const PRIMARY_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";

export default function HowItWorksPage() {
  if (!landingPageEnabled()) notFound();
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold text-fg">Socratic Trade</span>
          <a href="/welcome" className={PRIMARY_LINK_SM}>
            Home
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-14 space-y-14">
        <section className="space-y-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-accent">Decision framework</p>
          <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            A reasoning console for autonomous market decisions
          </h1>
          <p className="max-w-3xl text-lg leading-relaxed text-muted">
            Socratic Trade is organized around a simple product contract: what did the system
            believe, why did it believe it, what did it remember, what could prove it wrong, what
            did it do, what happened, and how should the framework improve?
          </p>
        </section>

        <section className="space-y-5">
          <h2 className="text-xl font-semibold text-fg">Core loop</h2>
          <Card className="p-5 sm:p-8">
            <DecisionLoopDiagram />
          </Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CORE_LOOP.map((item) => (
              <Card key={item.title} className="p-5 space-y-2">
                <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="space-y-5">
          <h2 className="text-xl font-semibold text-fg">Decision case file</h2>
          <p className="text-sm leading-relaxed text-muted">
            Each action or non-action should read like an audit case, not a mystery score. The
            case-file frame keeps the agent accountable when it buys, sells, waits, rejects, sizes
            down, or chooses to press a rebound thesis during stress.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {DECISION_FILE.map((item) => (
              <Card key={item.title} className="p-5 space-y-2">
                <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="space-y-5">
          <h2 className="text-xl font-semibold text-fg">Authority and overrides</h2>
          <p className="text-sm leading-relaxed text-muted">
            The interface separates confidence from permission. A strong thesis is not itself
            authority; delegated scope is. When Socratic Trade decides a selloff is a buying
            opportunity instead of a reason to retreat, the explanation must say which mandate
            allowed it, what evidence justified it, and what condition would have stopped it.
          </p>
          <Card className="p-5">
            <ul className="space-y-2">
              {AUTHORITY_ITEMS.map((item) => (
                <li key={item} className="flex gap-2 text-sm leading-relaxed text-muted">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <section className="space-y-5">
          <h2 className="text-xl font-semibold text-fg">Learning loop</h2>
          <p className="text-sm leading-relaxed text-muted">
            Learning is not a vague claim that the bot gets smarter. It is a visible trail from
            thesis to action to outcome to proposed framework change. Wins, losses, missed trades,
            blocked trades, and false positives all become reviewable evidence.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {LEARNING_ITEMS.map((item) => (
              <Card key={item.title} className="p-5 space-y-2">
                <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section>
          <Card className="p-6 space-y-4 border-line-strong">
            <h2 className="text-base font-semibold text-fg">Important disclosures</h2>
            <p className="text-sm leading-relaxed text-muted">
              Socratic Trade is software for market research, autonomous reasoning, and trade
              execution when connected to accounts you configure. It is not investment advice, a
              broker-dealer, or a registered investment adviser.
            </p>
            <p className="text-sm leading-relaxed text-muted">
              Trading and investing involve substantial risk of loss. Simulated, hypothetical, or
              historical performance has inherent limitations and does not guarantee future results.
              Nothing here is a recommendation to buy or sell any security.
            </p>
            <p className="text-sm leading-relaxed text-muted">
              You are responsible for your own investment decisions and for the authority you grant
              to any connected trading system.
            </p>
          </Card>
        </section>
      </main>

      <footer className="border-t border-line mt-8">
        <div className="mx-auto max-w-4xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
          <p className="text-xs text-faint">
            Not investment advice. Trading involves risk of loss.{" "}
            <a href="/welcome" className="underline underline-offset-2 hover:text-muted">
              Home
            </a>
          </p>
          <p className="text-xs text-faint">
            &copy; 2026 Socratic Trade &middot;{" "}
            <a href="mailto:mail@jays.services" className="underline underline-offset-2 hover:text-muted">
              mail@jays.services
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
