"use client";

/** The console shell: providers + global chrome + navigation. Every screen
 *  renders inside this frame, so account scope, run state, STOP, Run once,
 *  and freshness are visible everywhere. Paper/no-account states get explicit
 *  banners; ordinary brokerage accounts do not get a red global frame. Theme: system
 *  preference by default, explicit light/dark via the chrome toggle
 *  (persisted, applied as data-theme on this root). */

import type { ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleDataProvider, useConsoleData } from "../lib/useConsoleData";
import { useConsoleTextBoxFont } from "../lib/useConsoleTextBoxFont";
import { useConsoleTheme, type ConsoleTheme } from "../lib/useConsoleTheme";
import { DirtyGuardProvider } from "../lib/useDirtyGuard";
import { SymbolDrawerProvider } from "../ui/symbol-drawer";
import { ToastProvider } from "../ui/toast";
import { FreshnessStrip, RealityBanner, RunOnceButton, RunStateButton, ScopeSelector, StateChip, UserMenu } from "./chrome";
import { ConsentGate } from "./consent-gate";
import { DesktopRail, MobileTabBar } from "./nav";

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <ConsoleDataProvider>
      {/* DirtyGuardProvider wraps the nav AND the pages so unsaved drafts can
          intercept both tab-close (beforeunload) and in-console navigation. */}
      <DirtyGuardProvider>
        <ShellFrame>{children}</ShellFrame>
      </DirtyGuardProvider>
    </ConsoleDataProvider>
  );
}

const THEME_LABEL: Record<ConsoleTheme, string> = {
  system: "Theme: following your system setting. Click for dark.",
  dark: "Theme: dark. Click for light.",
  light: "Theme: light. Click to follow your system setting."
};

function ThemeToggle({ theme, cycle }: { theme: ConsoleTheme; cycle: () => void }) {
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={cycle}
      title={THEME_LABEL[theme]}
      aria-label={THEME_LABEL[theme]}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)]"
    >
      <Icon size={15} />
    </button>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const { snapshot, fetchedAt, loading, error, stream } = useConsoleData();
  const { theme, dataTheme, cycle } = useConsoleTheme();
  const { dataTextBoxFont } = useConsoleTextBoxFont();

  if (loading) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        suppressHydrationWarning
      >
        <div className="text-center">
          <div className="con-card-title">Socratic Trade</div>
          <p className="mt-2 text-[color:var(--con-muted)]">Loading the autonomy desk…</p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div
        className="console-root flex min-h-dvh items-center justify-center px-6"
        data-theme={dataTheme}
        data-textbox-font={dataTextBoxFont}
        suppressHydrationWarning
      >
        <div className="con-card max-w-md p-6 text-center">
          <div className="con-card-title">Socratic Trade</div>
          <p className="mt-2 font-semibold">Couldn&apos;t load the autonomy desk</p>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {error ?? "The dashboard API did not respond."} The console retries automatically.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="console-root flex min-h-dvh flex-col"
      data-theme={dataTheme}
      data-textbox-font={dataTextBoxFont}
      suppressHydrationWarning
    >
      {/* ToastProvider must live INSIDE .console-root: it renders the .con-toasts
          viewport as its last child, and the --con-* design tokens (colors, radii,
          shadows) are scoped to .console-root — a toast mounted outside it would
          render unstyled. The provider adds no DOM around the children, so the
          flex column layout is unchanged; the toasts div is position:fixed. */}
      <SymbolDrawerProvider>
        <ToastProvider>
          {/* Sticky chrome: reality + STOP stay reachable on every screen, especially mobile. */}
          <div className="sticky top-0 z-50 bg-[color:var(--con-bg)]">
            <RealityBanner snapshot={snapshot} />
            <ChromeBar snapshot={snapshot} theme={theme} cycleTheme={cycle} />
          </div>
          <div className="mx-auto flex w-full max-w-[1400px] flex-1">
            <DesktopRail pendingCount={snapshot.pendingProposals.length} />
            <main className="min-w-0 flex-1 px-4 pb-24 pt-4 lg:px-6 lg:pb-8">{children}</main>
          </div>
          <FreshnessStrip snapshot={snapshot} fetchedAt={fetchedAt} error={error} stream={stream} />
          <MobileTabBar pendingCount={snapshot.pendingProposals.length} />
          {/* Blocking shared-data-pool consent gate — same semantics as the
              legacy dashboard gate; renders nothing once answered. */}
          <ConsentGate />
        </ToastProvider>
      </SymbolDrawerProvider>
    </div>
  );
}

function ChromeBar({
  snapshot,
  theme,
  cycleTheme
}: {
  snapshot: DashboardSnapshot;
  theme: ConsoleTheme;
  cycleTheme: () => void;
}) {
  return (
    <header className="border-b border-[color:var(--con-line)] bg-[color:var(--con-surface)]">
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-2">
        <span className="hidden pr-2 text-[length:var(--con-fs-md)] font-bold tracking-tight lg:block">Socratic.Trade</span>
        <ScopeSelector snapshot={snapshot} />
        <StateChip snapshot={snapshot} />
        <div className="flex-1" />
        <ThemeToggle theme={theme} cycle={cycleTheme} />
        <UserMenu snapshot={snapshot} />
        <div className="hidden sm:block">
          <RunOnceButton snapshot={snapshot} />
        </div>
        <RunStateButton snapshot={snapshot} />
      </div>
    </header>
  );
}
