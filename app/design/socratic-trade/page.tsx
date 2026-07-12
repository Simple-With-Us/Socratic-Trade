import type { Metadata } from "next";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowRight,
  Brain,
  ChartCandlestick,
  CheckCircle2,
  Database,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Route,
  Scale,
  Shield,
  Sparkles,
  Target,
  Workflow
} from "lucide-react";
import styles from "./socratic-trade.module.css";

export const metadata: Metadata = {
  title: "Socratic Trade Site",
  description:
    "A coded overview of the Socratic Trade product surfaces: autonomy console, decision framework, guardrails, memory, coaching, and outcome learning."
};

const surfaces: Array<{
  title: string;
  href: string;
  icon: LucideIcon;
  eyebrow: string;
  body: string;
  state: string;
}> = [
  {
    title: "Autonomy Desk",
    href: "/console",
    icon: LayoutDashboard,
    eyebrow: "Primary app",
    body: "Live thesis, delegated actions, evidence, dissent, coaching, framework proposals, and account state.",
    state: "coded"
  },
  {
    title: "Guardrails",
    href: "/console/guardrails",
    icon: Shield,
    eyebrow: "Authority",
    body: "Risk, tax, universe, execution, and Socratic override preferences in one operator surface.",
    state: "coded"
  },
  {
    title: "Decision Framework",
    href: "/how-it-works",
    icon: Workflow,
    eyebrow: "Public explainer",
    body: "Observe, argue, decide, act, explain, and learn: the product contract for autonomous decisions.",
    state: "coded"
  },
  {
    title: "Strategy",
    href: "/console/strategy",
    icon: ChartCandlestick,
    eyebrow: "Model loop",
    body: "Prompt controls, strategy state, run controls, and evidence about how the agent is behaving.",
    state: "coded"
  },
  {
    title: "Results",
    href: "/console/results",
    icon: Activity,
    eyebrow: "Outcome loop",
    body: "Performance, missed opportunities, scorecards, and realized feedback into future decisions.",
    state: "coded"
  },
  {
    title: "Settings",
    href: "/console/settings",
    icon: Scale,
    eyebrow: "Operations",
    body: "Broker connections, model keys, notifications, data sharing, help, and destructive account controls.",
    state: "coded"
  }
];

const loop = [
  {
    title: "Observe",
    body: "Market scan, broker/account state, macro context, open positions, and prior decisions enter the case file.",
    icon: Target
  },
  {
    title: "Argue",
    body: "Bull thesis, Bear critique, RAG evidence, policy gates, and override conflicts are preserved side by side.",
    icon: Brain
  },
  {
    title: "Act",
    body: "Decisions become proposed, blocked, placed, refused, or failed states with separate audit trails.",
    icon: Route
  },
  {
    title: "Remember",
    body: "Each strategy-recorded Socratic decision is indexed as private institutional memory for future retrieval.",
    icon: Database
  },
  {
    title: "Coach",
    body: "Owner notes attach to the case file, while the agent can propose framework changes for review.",
    icon: MessageSquare
  },
  {
    title: "Improve",
    body: "Outcome learning and post-mortems update future reasoning without hiding the original debate.",
    icon: GitBranch
  }
];

const implementation = [
  "Durable Socratic decision-case persistence",
  "Framework proposal queue with owner response",
  "Socratic override policy fields",
  "Hard refusal boundary for broker/account/integrity/tax gates",
  "Structured RAG attribution on decisions",
  "Private institutional-memory indexing",
  "Public framework routes available by default",
  "socratictrade.com product naming"
];

export default function SocraticTradeSitePage() {
  return (
    <main className={styles.page}>
      <section className={styles.hero} aria-labelledby="site-title">
        <div className={styles.heroCopy}>
          <span className={styles.kicker}>
            <Sparkles size={16} aria-hidden="true" />
            Socratic Trade
          </span>
          <h1 id="site-title">An autonomy desk for decisions that can explain themselves.</h1>
          <p>
            Socratic Trade is now coded around inspectable market reasoning: thesis, evidence, dissent,
            policy outcome, override logic, action state, coaching, memory, and post-trade learning.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/console">
              Open console
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link className={styles.secondaryAction} href="/how-it-works">
              Decision framework
            </Link>
          </div>
        </div>

        <div className={styles.statusPanel} aria-label="Implementation status">
          <div className={styles.statusHeader}>
            <span>Implementation state</span>
            <strong>coded</strong>
          </div>
          <div className={styles.statusGrid}>
            {implementation.map((item) => (
              <div key={item} className={styles.statusItem}>
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="surface-title">
        <div className={styles.sectionHeader}>
          <p>Product surfaces</p>
          <h2 id="surface-title">The site is a working app surface map.</h2>
        </div>
        <div className={styles.surfaceGrid}>
          {surfaces.map((surface) => {
            const Icon = surface.icon;
            return (
              <Link key={surface.href} href={surface.href} className={styles.surfaceCard}>
                <div className={styles.surfaceTop}>
                  <span className={styles.iconBox}>
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className={styles.statePill}>{surface.state}</span>
                </div>
                <p>{surface.eyebrow}</p>
                <h3>{surface.title}</h3>
                <span>{surface.body}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className={styles.loopSection} aria-labelledby="loop-title">
        <div className={styles.sectionHeader}>
          <p>Reasoning loop</p>
          <h2 id="loop-title">Every trade becomes a case file.</h2>
        </div>
        <div className={styles.loopGrid}>
          {loop.map((step, index) => {
            const Icon = step.icon;
            return (
              <article key={step.title} className={styles.loopCard}>
                <div className={styles.loopNumber}>{index + 1}</div>
                <Icon size={20} aria-hidden="true" />
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.traceSection} aria-labelledby="trace-title">
        <div>
          <p className={styles.kicker}>Decision trace</p>
          <h2 id="trace-title">A decision can be inspected after the fact.</h2>
          <p>
            The persisted Socratic case file records the broker argument, critic counterargument, RAG
            contribution, policy result, override state, owner coaching, framework proposals, and outcome notes.
          </p>
        </div>
        <div className={styles.traceCard}>
          <div className={styles.traceRow}>
            <span>Final action</span>
            <strong>PLACED / BLOCKED / PROPOSED</strong>
          </div>
          <div className={styles.traceRow}>
            <span>Memory document</span>
            <strong>private RAG</strong>
          </div>
          <div className={styles.traceRow}>
            <span>Override boundary</span>
            <strong>preference gates only</strong>
          </div>
          <div className={styles.traceRow}>
            <span>Hard refusals</span>
            <strong>broker, account, integrity, tax</strong>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Not investment advice. Trading involves risk.</span>
        <div>
          <Link href="/welcome">Welcome</Link>
          <Link href="/console">Console</Link>
          <Link href="/console/settings">Settings</Link>
        </div>
      </footer>
    </main>
  );
}
