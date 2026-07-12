"use client";

/** Destinations: left rail on desktop (≥1024px), bottom tab bar on mobile.
 *  Approvals carries the console's only red badge — its count is everything
 *  waiting for a decision there: pending trade proposals PLUS pending
 *  learned-context confirmations (one badge, one number, never two). */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity as ActivityIcon,
  BarChart3,
  Brain,
  Eye,
  Globe,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Radar,
  ReceiptText,
  Settings as SettingsIcon,
  Shield
} from "lucide-react";
import { Sheet } from "../ui/sheet";
import { cx } from "../lib/format";
import { useNavDirtyGuard } from "../lib/useDirtyGuard";

/** Pending learned-context confirmations (risk-tier queue). Not part of the
 *  dashboard snapshot, so it's polled here — cheap endpoint, 60s cadence,
 *  refreshed when the tab becomes visible. Errors leave the last good count. */
function useLearnedPendingCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/learned-context/pending", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
        .then((rows) => {
          if (!cancelled && Array.isArray(rows)) setCount(rows.length);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      load();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return count;
}

function badgeTitle(proposals: number, learned: number): string {
  const parts: string[] = [];
  if (proposals > 0) parts.push(`${proposals} trade proposal${proposals === 1 ? "" : "s"}`);
  if (learned > 0) parts.push(`${learned} learned-context item${learned === 1 ? "" : "s"}`);
  return `${parts.join(" and ")} waiting for your decision`;
}

interface Destination {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Concise hover explanation (native title) — every destination has one. */
  desc: string;
}

const DESTINATIONS: Destination[] = [
  { href: "/console", label: "Thesis", icon: LayoutDashboard, desc: "Live thesis, actions, evidence, dissent, and framework learning." },
  { href: "/console/approvals", label: "Decisions", icon: Inbox, desc: "Pending trade proposals and learned-context changes awaiting a decision." },
  { href: "/console/activity", label: "Journal", icon: ActivityIcon, desc: "Decision journal: everything the agent did, newest first." },
  { href: "/console/scan", label: "Evidence", icon: Radar, desc: "The market scan: screened and scored symbols from the latest run." },
  { href: "/console/watchlist", label: "Watchlist", icon: Eye, desc: "Symbols the agent monitors, with price alerts that notify you when a level is crossed." },
  { href: "/console/macro", label: "Regime", icon: Globe, desc: "Macro and market-regime board: rates, credit, volatility, breadth." },
  { href: "/console/orders", label: "Orders", icon: ListChecks, desc: "Order history and open orders at the broker." },
  { href: "/console/assistant", label: "Coach", icon: MessageSquare, desc: "Coach Socratic Trade about its reasoning, accounts, and market focus." },
  { href: "/console/strategy", label: "Framework", icon: Brain, desc: "The agent framework: prompts, models, doctrine, and run cadence." },
  { href: "/console/guardrails", label: "Mandates", icon: Shield, desc: "Delegated authority and hard constraints that bind every trade." },
  { href: "/console/results", label: "Outcomes", icon: BarChart3, desc: "Realized performance, equity curve, thesis scorecards, and learning evidence." },
  { href: "/console/usage", label: "Usage", icon: ReceiptText, desc: "Your LLM usage and estimated model cost by key, model, and workflow." },
  { href: "/console/settings", label: "Settings", icon: SettingsIcon, desc: "Accounts, notifications, API keys, and console preferences." }
];

function isActive(pathname: string, href: string): boolean {
  return href === "/console" ? pathname === "/console" : pathname.startsWith(href);
}

export function DesktopRail({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname() ?? "";
  const guardNav = useNavDirtyGuard();
  const learnedCount = useLearnedPendingCount();
  const decisionCount = pendingCount + learnedCount;
  return (
    <nav className="hidden w-52 shrink-0 flex-col gap-1 px-3 py-4 lg:flex" aria-label="Console navigation">
      {DESTINATIONS.map((d) => {
        const Icon = d.icon;
        return (
          <Link
            key={d.href}
            href={d.href}
            className="con-nav-item"
            data-active={isActive(pathname, d.href)}
            title={d.desc}
            onClick={(e) => guardNav(e)}
          >
            <Icon size={16} />
            <span className="flex-1">{d.label}</span>
            {d.href === "/console/approvals" && decisionCount > 0 && (
              <span className="con-badge" title={badgeTitle(pendingCount, learnedCount)}>
                {decisionCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

const MOBILE_PRIMARY = DESTINATIONS.slice(0, 3);
const MOBILE_MORE = DESTINATIONS.slice(3);

export function MobileTabBar({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname() ?? "";
  const [moreOpen, setMoreOpen] = useState(false);
  const guardNav = useNavDirtyGuard();
  const learnedCount = useLearnedPendingCount();
  const decisionCount = pendingCount + learnedCount;
  const moreActive = MOBILE_MORE.some((d) => isActive(pathname, d.href));

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-50 border-t border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Console navigation"
      >
        <div className="flex">
          {MOBILE_PRIMARY.map((d) => {
            const Icon = d.icon;
            return (
              <Link
                key={d.href}
                href={d.href}
                className="con-tab-item"
                data-active={isActive(pathname, d.href)}
                title={d.desc}
                onClick={(e) => guardNav(e)}
              >
                <span className="relative">
                  <Icon size={19} />
                  {d.href === "/console/approvals" && decisionCount > 0 && (
                    <span className="con-badge absolute -right-2.5 -top-1.5" title={badgeTitle(pendingCount, learnedCount)}>
                      {decisionCount}
                    </span>
                  )}
                </span>
                {d.label}
              </Link>
            );
          })}
          <button
            type="button"
            className={cx("con-tab-item")}
            data-active={moreActive}
            title="All remaining console screens"
            onClick={() => setMoreOpen(true)}
          >
            <MoreHorizontal size={19} />
            More
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div className="flex flex-col gap-1">
          {MOBILE_MORE.map((d) => {
            const Icon = d.icon;
            return (
              <Link
                key={d.href}
                href={d.href}
                className="con-nav-item"
                data-active={isActive(pathname, d.href)}
                title={d.desc}
                onClick={(e) => {
                  if (guardNav(e)) setMoreOpen(false);
                }}
              >
                <Icon size={16} />
                {d.label}
              </Link>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
