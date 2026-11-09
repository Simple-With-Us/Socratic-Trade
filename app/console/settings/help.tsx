"use client";

/** Help & glossary — the console's vocabulary in one searchable place. Every
 *  definition uses the same load-bearing words the UI itself uses (Paper,
 *  Brokerage Account, Ask-first / Autopilot, Stopped / Exit-only, …) so reading
 *  this IS reading the interface. Static content by design: it describes how
 *  the app actually behaves, and it must never drift into marketing. */

import { useMemo, useState } from "react";
import {
  BROKERAGE_ACCOUNT_GLOSSARY_DEFINITION,
  GUARDRAILS_GLOSSARY_DEFINITION,
  PAPER_ACCOUNT_GLOSSARY_ALIASES,
  PAPER_ACCOUNT_GLOSSARY_DEFINITION,
  PAPER_ACCOUNT_GLOSSARY_TERM
} from "@/lib/guardrail-copy";
import { Card, TextInput } from "../ui/primitives";

interface GlossaryEntry {
  term: string;
  /** Extra words the search should also match. */
  aliases?: string;
  definition: string;
}

interface GlossaryGroup {
  group: string;
  blurb: string;
  entries: GlossaryEntry[];
}

const GLOSSARY: GlossaryGroup[] = [
  {
    group: "Money reality",
    blurb: "Every screen states which money it is in words — the colors only reinforce.",
    entries: [
      {
        term: PAPER_ACCOUNT_GLOSSARY_TERM,
        aliases: PAPER_ACCOUNT_GLOSSARY_ALIASES,
        definition: PAPER_ACCOUNT_GLOSSARY_DEFINITION
      },
      {
        term: "Brokerage Account",
        aliases: "broker connected live trading real account",
        definition: BROKERAGE_ACCOUNT_GLOSSARY_DEFINITION
      }
    ]
  },
  {
    group: "Authority & run state",
    blurb: "Who is allowed to act, and whether anything is running at all.",
    entries: [
      {
        term: "Ask-first (propose)",
        aliases: "propose authority approval running active",
        definition:
          "Autonomy can be on (Running) while every trade still waits for your explicit approval.  This is not Autopilot.  Nothing is placed until you approve it; ignoring a proposal lets it expire."
      },
      {
        term: "Autopilot (decide)",
        aliases: "decide authority autonomous auto-decide",
        definition:
          "The app is making trades: the strategy may place orders itself, inside your guardrails.  Use Autopilot only for this auto-decide mode.  Manual Run Once runs are always forced back to Ask-first regardless of this setting."
      },
      {
        term: "Running (active)",
        aliases: "active running autonomy on",
        definition:
          "Scheduled runs are on for this account.  If authority is Ask-first, the chip says Running — not Autopilot.  If authority is Autopilot, the chip says Autopilot because the app may place orders."
      },
      {
        term: "Arming",
        aliases: "arm start enable",
        definition:
          "Starting scheduled runs (Stopped → Running).  The server checks preconditions first: an account is selected, a universe is configured, and the account allows agentic trading."
      },
      {
        term: "System state",
        aliases: "systemState running stopped halted close_only liquidating exit-only winding down",
        definition:
          "The run-state of one account's strategy.  Running: scheduled runs happen.  Exit-only (close_only): no new buys, protective exits keep working — the state circuit breakers set.  Winding down (liquidating): only sells, until the account is in cash.  Stopped (halted): nothing trades, and this app's automatic stops pause too — broker-held orders keep resting at the broker."
      },
      {
        term: "STOP everything",
        aliases: "stop button halt",
        definition:
          "The always-reachable red control.  Sets the account to Stopped.  It never sells anything — it stops activity, including this app's own automatic stops.  Broker-held brackets keep resting."
      },
      {
        term: "Auto-resume on boot",
        aliases: "restart boot resume",
        definition:
          "Off: after a server restart, any Running account stays stopped until a person starts it again — a restored backup or crash-loop cannot silently resume trading.  On: scheduled runs may resume after a restart when you have opted in."
      }
    ]
  },
  {
    group: "The strategy loop",
    blurb: "What actually happens on each scheduled run.",
    entries: [
      {
        term: "Market scan",
        aliases: "scan universe candidates",
        definition:
          "Each run screens the configured index universes plus your watchlist, ranks candidates by the eight scoring factors, and enriches the top names with fundamentals, news, and technicals before the strategist sees them."
      },
      {
        term: "Green team (strategist)",
        aliases: "proposer bull llmModel green team",
        definition:
          "The LLM that writes trade proposals from the scan evidence and your written strategy instructions.  Its model is the 'Green Team' pick under Strategy → Models."
      },
      {
        term: "Red team (reviewer)",
        aliases: "bear reviewer redTeamLlmModel debate red team",
        definition:
          "An adversarial second model that reviews every risk-adding opening at its final size, fact-checking the rationale against the same evidence the Green Team saw.  A veto or half-size downgrade is recorded with the proposal.  Blank = not configured — openings route to human approval instead of auto-executing (it never silently self-reviews)."
      },
      {
        term: "Conviction",
        aliases: "confidence score",
        definition:
          "The strategist's 0–100 confidence in a proposal.  High-conviction ideas trigger the red-team debate; conviction also scales position sizing between the configured floor and ceiling."
      },
      {
        term: "Proposal",
        aliases: "trade idea approval pending",
        definition:
          "A concrete order the strategy wants to place, with its thesis and evidence.  In Ask-first it waits in Approvals; unanswered proposals expire on the configured timer rather than executing stale."
      },
      {
        term: "Policy gate",
        aliases: "guardrails limits blocked",
        definition:
          "The deterministic checks every order passes through regardless of which model proposed it: notional caps, exposure caps, sector caps, order-type limits, quote freshness, and more.  A block is recorded and (optionally) notified."
      }
    ]
  },
  {
    group: "Protections",
    blurb: "What limits losses, and where each protection actually lives.",
    entries: [
      {
        term: "Guardrails",
        aliases: "risk rules caps limits",
        definition: GUARDRAILS_GLOSSARY_DEFINITION
      },
      {
        term: "Circuit breaker (kill switch)",
        aliases: "kill_switch breaker drawdown",
        definition:
          "An automatic tripwire (e.g. max drawdown) that drops the account to Exit-only and sends a notification.  It limits further damage; it does not sell everything."
      },
      {
        term: "Broker stop vs app stop",
        aliases: "stop loss trailing synthetic stops protection",
        definition:
          "A broker stop is an order resting AT the broker — it keeps protecting even if this app is down.  An app stop is a rule this app enforces on its scheduler tick — it needs the app running and pauses while Stopped.  The Positions table says which one protects each position."
      },
      {
        term: "Wash-sale guard",
        aliases: "wash sale lock 30 days",
        definition:
          "For taxable accounts, blocks or prices rebuying a symbol that was closed at a loss within the last 30 days.  Same-account IRA wash sales are ignored automatically; an IRA buying after another taxable account's loss is governed by the IRA taxable-loss rebuy setting."
      },
      {
        term: "Daily spend",
        aliases: "notional budget daily orders",
        definition:
          "How much buying the strategy has done today against its caps: total notional and opening-order count.  Resets daily; the meters live on the Overview."
      }
    ]
  },
  {
    group: "Accounts & scope",
    blurb: "How connections, scoping, and account-level settings relate.",
    entries: [
      {
        term: "Connected account",
        aliases: "broker connection robinhood alpaca",
        definition:
          "A brokerage login this app can read and trade through (Robinhood via OAuth, Alpaca via API keys, Tradier via access token).  Disconnecting removes the connection from this app only — nothing changes at the broker."
      },
      {
        term: "Active account",
        aliases: "scope switcher",
        definition:
          "Exactly one account is active at a time; the entire console — balances, guardrails, approvals, run state — is scoped to it.  Switch scope from the header.  Each account keeps its own strategy and policy."
      },
      {
        term: "THIS ACCOUNT vs ALL YOUR ACCOUNTS",
        aliases: "settings scope user-level account-level",
        definition:
          "The two storage scopes for configuration.  THIS ACCOUNT settings follow the account and live where you configure the account itself — Strategy (models, prompt, weights) and Guardrails (caps, protective stops, tax treatment, rulebook).  ALL YOUR ACCOUNTS settings follow you (connections, API keys, notifications, scan shape, learning review, typed confirmation) and overlay every account — they live on Connections and Settings."
      },
      {
        term: "Preset (profile)",
        aliases: "strategy profile library apply",
        definition:
          "A saved strategy bundle (policy + prompt + weights).  Applying one COPIES it onto the active account — later edits to the preset never follow, and a preset can never start or stop trading."
      }
    ]
  },
  {
    group: "Data honesty",
    blurb: "What the numbers and dashes actually mean.",
    entries: [
      {
        term: "— (em dash)",
        aliases: "dash missing data empty",
        definition:
          "Data simply wasn't available.  The console never fabricates a number to fill a gap — a dash means 'we don't know', full stop."
      },
      {
        term: "n/a (P/E)",
        aliases: "pe ratio not applicable",
        definition:
          "A real, computed 'no ratio' state: earnings are negative or zero, so a P/E doesn't exist. Different from '—', which means the data wasn't available."
      },
      {
        term: "Source attribution",
        aliases: "provider yahoo finnhub data source",
        definition:
          "Scan data names every provider that actually contributed this run (e.g. yahoo-finance+finnhub).  Every symbol shows real data or an honest gap — never a synthetic placeholder."
      }
    ]
  }
];

export function HelpGlossaryCard() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GLOSSARY;
    return GLOSSARY.map((group) => ({
      ...group,
      entries: group.entries.filter(
        (e) =>
          e.term.toLowerCase().includes(q) ||
          (e.aliases ?? "").toLowerCase().includes(q) ||
          e.definition.toLowerCase().includes(q)
      )
    })).filter((group) => group.entries.length > 0);
  }, [query]);

  return (
    <Card title="Help & glossary">
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        The words this console uses, defined the way the app actually behaves. If a term on any screen is unclear,
        it&apos;s in here — most controls also explain themselves on hover.
      </p>
      <div className="mb-3 max-w-md">
        <TextInput
          value={query}
          placeholder="Search terms — e.g. wash sale, autopilot, red team…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the glossary"
          title="Filters the glossary by term, synonym, or definition text."
        />
      </div>
      {filtered.length === 0 ? (
        <p className="py-4 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
          No term matches &quot;{query.trim()}&quot; — try a shorter word.
        </p>
      ) : (
        <div className="flex flex-col">
          {filtered.map((group) => (
            <details key={group.group} className="con-disclosure" open={query.trim().length > 0}>
              <summary title={group.blurb}>
                {group.group}
                <span className="font-normal text-[color:var(--con-faint)]">· {group.entries.length}</span>
              </summary>
              <dl className="mb-2 flex flex-col divide-y divide-[color:var(--con-line)] rounded-control border border-[color:var(--con-line)]">
                {group.entries.map((entry) => (
                  <div
                    key={entry.term}
                    className="px-3 py-2.5 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-[color:var(--con-surface-2)]"
                  >
                    <dt className="text-[length:var(--con-fs-sm)] font-semibold">{entry.term}</dt>
                    <dd className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                      {entry.definition}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </div>
      )}
    </Card>
  );
}
