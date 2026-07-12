"use client";

/** Global chrome, rendered on every console screen:
 *  - word-first account-state banner for NO ACCOUNT / PAPER only
 *  - account scope selector
 *  - run-state × authority chip in plain words
 *  - run-state action: Start/Resume when paused, STOP when running
 *  - Run once (wired; disabled with a reason when blocked)
 *  - data freshness strip */

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, LogOut, OctagonMinus, Play, ShieldCheck, UserRound } from "lucide-react";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  activeConnectedAccount,
  deriveReality,
  deriveSpend,
  deriveStateInfo,
  realityForAccount
} from "../lib/derive";
import {
  activateAccount,
  ConsoleApiError,
  runOnce,
  setSystemState,
  startStrategy,
  stopEverything
} from "../lib/api";
import { cx, fmtClock, fmtMoney, fmtMoneyWhole, timeAgo, timeUntil, EM_DASH, fmtExact } from "../lib/format";
import type { ConsoleStreamHealth } from "../lib/useConsoleData";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Chip, Dot, Meter, TextInput } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

// ── Reality banner ───────────────────────────────────────────────────────────

export function RealityBanner({ snapshot }: { snapshot: DashboardSnapshot }) {
  const reality = deriveReality(snapshot);
  if (reality.tone === "live") return null;
  return (
    <div className={cx("con-reality", `con-reality-${reality.tone}`)}>
      <div className="mx-auto flex max-w-[1400px] items-baseline gap-2 px-4 py-1.5">
        <span className="con-reality-word text-[length:var(--con-fs-sm)]">{reality.word}</span>
        <span className="font-semibold">· {reality.phrase}</span>
        <span className="hidden truncate text-[color:var(--con-muted)] sm:inline">— {reality.clarification}</span>
      </div>
    </div>
  );
}

// ── Account scope selector ───────────────────────────────────────────────────

function brokerName(broker: string | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "test":
      return "Test Account";
    default:
      return broker ?? "";
  }
}

export function ScopeSelector({ snapshot, compact }: { snapshot: DashboardSnapshot; compact?: boolean }) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reality = deriveReality(snapshot);
  const active = activeConnectedAccount(snapshot);

  const label = active
    ? `${active.label || brokerName(active.broker)}${active.accountNumber ? ` ·· ${active.accountNumber.slice(-4)}` : ""}`
    : "No connected account";

  const switchTo = async (id: string) => {
    setBusyId(id);
    try {
      await activateAccount(id);
      await refresh();
      toast.push("info", "Scope switched", "The whole console now shows this account.");
      setOpen(false);
    } catch (error) {
      toast.push("neg", "Could not switch accounts", error instanceof ConsoleApiError ? error.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-[112px] max-w-[44vw] items-center gap-2 overflow-hidden rounded-lg border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-left transition-colors hover:border-[color:var(--con-accent)] sm:max-w-none"
        title="Switch which account this console shows"
      >
        <span className="min-w-0">
          <span className="block truncate text-[length:var(--con-fs-sm)] font-semibold leading-tight">{label}</span>
          {!compact && (
            <span className="hidden truncate text-[length:var(--con-fs-xs)] leading-tight text-[color:var(--con-faint)] sm:block">
              {reality.tone === "live" ? "Brokerage account" : `${reality.word} · ${reality.phrase}`}
            </span>
          )}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[color:var(--con-faint)]" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Account scope">
        <p className="mb-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Exactly one account is active at a time. Switching rescopes everything — balances, guardrails, approvals,
          the run state, and decision history.
        </p>
        <div className="flex flex-col gap-2">
          {snapshot.connectedAccounts.length === 0 && (
            <div className="rounded-lg border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-sm)]">
              <div className="flex items-center gap-2">
                <span className="font-semibold">No account connected</span>
                <Chip tone="none">NO ACCOUNT · no account connected</Chip>
              </div>
              <p className="mt-1 text-[color:var(--con-muted)]">
                Connect a broker account before the app can place orders.
              </p>
            </div>
          )}
          {snapshot.connectedAccounts.map((account) => {
            const r = realityForAccount(account);
            return (
              <div
                key={account.id}
                className={cx(
                  "rounded-lg border p-3",
                  account.isActive ? "border-[color:var(--con-accent)]" : "border-[color:var(--con-line)]"
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold">{account.label || brokerName(account.broker)}</span>
                    {account.broker === "test" && <Chip tone="paper">local mock</Chip>}
                    {r.tone !== "live" && (
                      <Chip tone={r.tone}>
                        {r.word} · {r.phrase}
                      </Chip>
                    )}
                    {account.isActive && <Chip tone="accent">active</Chip>}
                  </div>
                  {!account.isActive && (
                    <Btn size="sm" variant="outline" disabled={busyId !== null} onClick={() => void switchTo(account.id)}>
                      {busyId === account.id ? "Switching…" : "Switch"}
                    </Btn>
                  )}
                </div>
                <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {account.broker === "test"
                    ? "Local Mock Paper Account - simulated fills, not real money"
                    : `${brokerName(account.broker)} · ${r.tone === "paper" ? "paper account, not real money" : "brokerage account"}`}
                  {account.accountNumber ? ` · ·· ${account.accountNumber.slice(-4)}` : ""}
                  {r.tone !== "live" ? ` — ${r.clarification}` : ""}
                </p>
              </div>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}

// ── Run-state chip + control sheet (STOP never sells) ────────────────────────

const STATE_TONE: Record<string, "pos" | "warn" | "neg" | "muted"> = {
  pos: "pos",
  warn: "warn",
  neg: "neg",
  muted: "muted"
};

export function StateChip({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const info = deriveStateInfo(snapshot.policy);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] px-3 py-1.5 transition-colors hover:border-[color:var(--con-accent)]"
        title={info.detail}
      >
        <Dot tone={STATE_TONE[info.tone]} pulse={info.state === "active" && snapshot.policy.strategyAuthority === "decide"} />
        <span className="whitespace-nowrap text-[length:var(--con-fs-sm)] font-semibold">{info.label}</span>
      </button>
      <ControlSheet snapshot={snapshot} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function RunStateButton({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const state = snapshot.policy.systemState;
  const isStartDirection = state === "halted" || state === "close_only";
  const label = state === "halted" ? "Start" : state === "close_only" ? "Resume" : "STOP";
  const title =
    state === "halted"
      ? "Open start options. Scheduled/autonomous runs stay off until you confirm Start."
      : state === "close_only"
        ? "Open resume options. You can resume full operation or change run state."
        : "Stop the strategy. Stopping never sells anything.";
  return (
    <>
      <button
        type="button"
        className={isStartDirection ? "con-start-btn" : "con-stop-btn"}
        onClick={() => setOpen(true)}
        title={title}
        aria-label={label === "STOP" ? "Stop strategy" : `${label} strategy`}
      >
        {isStartDirection ? <Play size={15} /> : <OctagonMinus size={15} />}
        {label}
      </button>
      <ControlSheet snapshot={snapshot} open={open} onClose={() => setOpen(false)} emergency={!isStartDirection} />
    </>
  );
}

/** One control surface for run-state changes. Asymmetric friction:
 *  stopping = one tap + one confirm, no typing; starting a broker-connected account =
 *  typed ritual; winding down (the one stop verb that SELLS) = typed ritual. */
function ControlSheet({
  snapshot,
  open,
  onClose,
  emergency
}: {
  snapshot: DashboardSnapshot;
  open: boolean;
  onClose: () => void;
  emergency?: boolean;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [armText, setArmText] = useState("");
  const [confirmVerb, setConfirmVerb] = useState<"start" | "liquidate" | null>(null);
  const reality = deriveReality(snapshot);
  const info = deriveStateInfo(snapshot.policy);
  const state = snapshot.policy.systemState;

  const startLabel = state === "close_only" ? "Resume" : "Start";
  const startGerund = state === "close_only" ? "Resuming" : "Starting";
  const startProgressLabel = `${startGerund}…`;
  const startPhrase = reality.tone === "live" ? (state === "close_only" ? "RESUME LIVE" : "START LIVE") : null;
  const liquidatePhrase = "WIND DOWN";
  const sheetTitle = emergency
    ? "Stop the strategy"
    : state === "halted"
      ? "Start the strategy"
      : state === "close_only"
        ? "Resume or change run state"
        : "Run state";

  const act = async (verb: string, fn: () => Promise<unknown>, successTitle: string, successDetail?: string) => {
    setBusy(verb);
    try {
      await fn();
      await refresh();
      toast.push(verb === "stop" ? "warn" : "info", successTitle, successDetail);
      setConfirmVerb(null);
      setArmText("");
      onClose();
    } catch (error) {
      toast.push("neg", "That didn't go through", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const options = useMemo(() => {
    const startOption = {
      id: "start",
      title: state === "halted" ? "Start scheduled runs" : "Resume full operation",
      body:
        snapshot.policy.strategyAuthority === "decide"
          ? "Runs resume on schedule and the strategy may place orders itself, inside your guardrails."
          : "Runs resume on schedule. Every trade still waits for your approval.",
      available: state !== "active",
      danger: false
    };
    const stopOption = {
        id: "stop",
        title: "STOP everything",
        body:
          "Nothing buys, nothing sells — not even this app's automatic stop-losses, which pause too. Broker-held brackets keep resting at your broker. Your positions stay exactly as they are. Nothing is sold.",
        available: state !== "halted",
        danger: true
    };
    const closeOnlyOption = {
        id: "close_only",
        title: "Close-only",
        body:
          "No new buys. Protective sells and the app's stop monitor keep working. This is what the automatic circuit breakers choose.",
        available: state !== "close_only",
        danger: false
    };
    const liquidatingOption = {
        id: "liquidating",
        title: "Wind down",
        body:
          "The strategy sells positions until the account is in cash. This SELLS things — it may realize losses and taxes.",
        available: state !== "liquidating",
        danger: true
    };

    if (state === "halted") {
      return [startOption, closeOnlyOption, liquidatingOption];
    }
    if (state === "close_only") {
      return [startOption, stopOption, liquidatingOption];
    }
    if (state === "liquidating") {
      return [stopOption, startOption, closeOnlyOption];
    }
    return [stopOption, closeOnlyOption, liquidatingOption];
  }, [state, snapshot.policy.strategyAuthority]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={sheetTitle}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[length:var(--con-fs-sm)]">
        {reality.tone !== "live" && (
          <Chip tone={reality.tone}>
            {reality.word} · {reality.phrase}
          </Chip>
        )}
        <span className="text-[color:var(--con-muted)]">
          Now: <strong className="text-[color:var(--con-fg)]">{info.label}</strong>
        </span>
      </div>
      <p className="mb-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">{info.detail}</p>

      <div className="flex flex-col gap-2.5">
        {options
          .filter((o) => o.available)
          .map((o) => (
            <div key={o.id} className="rounded-lg border border-[color:var(--con-line)] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className={cx("font-semibold", o.id === "stop" && "text-[color:var(--con-neg)]")}>{o.title}</span>
                {o.id === "stop" && (
                  <Btn variant="danger" size="sm" disabled={busy !== null} onClick={() => void act("stop", stopEverything, "Stopped", "Nothing was sold. App-managed stops are paused; broker-held brackets keep resting.")}>
                    {busy === "stop" ? "Stopping…" : "Confirm: STOP"}
                  </Btn>
                )}
                {o.id === "close_only" && (
                  <Btn variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("close_only", () => setSystemState("close_only"), "Close-only", "No new buys. Protective exits keep working.")}>
                    {busy === "close_only" ? "Switching…" : "Confirm"}
                  </Btn>
                )}
                {o.id === "liquidating" && (
                  <Btn variant="dangerOutline" size="sm" disabled={busy !== null} onClick={() => setConfirmVerb(confirmVerb === "liquidate" ? null : "liquidate")}>
                    Wind down…
                  </Btn>
                )}
                {o.id === "start" &&
                  (startPhrase ? (
                    <Btn variant="primary" size="sm" disabled={busy !== null} onClick={() => setConfirmVerb(confirmVerb === "start" ? null : "start")}>
                      {startLabel}…
                    </Btn>
                  ) : (
                    <Btn variant="pos" size="sm" disabled={busy !== null} onClick={() => void act("start", startStrategy, "Running", "Scheduled runs are on.")}>
                      {busy === "start" ? startProgressLabel : startLabel}
                    </Btn>
                  ))}
              </div>
              <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{o.body}</p>

              {o.id === "liquidating" && confirmVerb === "liquidate" && (
                <TypedConfirm
                  phrase={liquidatePhrase}
                  value={armText}
                  onChange={setArmText}
                  busy={busy === "liquidating"}
                  confirmLabel="Wind down — this sells"
                  variant="danger"
                  onConfirm={() =>
                    void act("liquidating", () => setSystemState("liquidating"), "Winding down", "Only sell orders until the account is in cash.")
                  }
                />
              )}
              {o.id === "start" && confirmVerb === "start" && startPhrase && (
                <TypedConfirm
                  phrase={startPhrase}
                  value={armText}
                  onChange={setArmText}
                  busy={busy === "start"}
                  confirmLabel={
                    <>
                      {startLabel} scheduled runs
                    </>
                  }
                  variant="primary"
                  note={`${startGerund} a broker-connected account changes automation state, so it costs the typed confirmation phrase — stopping never does.`}
                  onConfirm={() => void act("start", startStrategy, "Running", "Scheduled runs are on.")}
                />
              )}
            </div>
          ))}
      </div>
    </Sheet>
  );
}

export function TypedConfirm({
  phrase,
  value,
  onChange,
  onConfirm,
  busy,
  confirmLabel,
  variant = "danger",
  note
}: {
  phrase: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  busy?: boolean;
  confirmLabel: ReactNode;
  /** "danger" only for DESTRUCTIVE confirms (wind-down/sells). Commit/arm
   *  rituals use "primary" — the typed word is the friction, not the color. */
  variant?: "danger" | "pos" | "primary";
  note?: string;
}) {
  const matches = value.trim().toUpperCase() === phrase;
  // Only a destructive confirm gets the red frame; other typed rituals use the
  // caution (warn) tint so red stays reserved for reality/STOP/destruction.
  const frameClass =
    variant === "danger"
      ? "border-[color:var(--con-live-border)] bg-[color:var(--con-live-soft)]"
      : "border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)]";
  return (
    <div className={cx("mt-3 rounded-lg border p-3", frameClass)}>
      {note && <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{note}</p>}
      <label className="con-label">
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{phrase}</span>
      </label>
      <div className="flex gap-2">
        <TextInput
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          onPaste={(e) => e.preventDefault()}
          placeholder={phrase}
          className="con-mono"
        />
        <Btn variant={variant} disabled={!matches || busy} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </Btn>
      </div>
    </div>
  );
}

// ── Run once ─────────────────────────────────────────────────────────────────

/** Why a manual run can't go ahead, plus where to fix it. Shown in a sheet —
 *  never buried in a disabled button's hover tooltip (useless on mobile). */
interface RunBlock {
  title: string;
  detail: string;
  /** Extra honest context (e.g. what Stopped really pauses). */
  note?: string;
  fixHref?: string;
  fixLabel?: string;
}

/** Pre-flight blocks the snapshot already knows about, before any request. */
function deriveRunBlock(snapshot: DashboardSnapshot): RunBlock | null {
  if (snapshot.llmConfigured === false) {
    return {
      title: "No LLM key is configured",
      detail:
        "Proposal generation is LLM-driven, so a manual run needs a working LLM provider key. Market data, positions, and guardrails all work without one — only runs and chat are gated.",
      fixHref: "/console/settings#api-keys",
      fixLabel: "Open Settings → API keys"
    };
  }
  if (snapshot.accountReadiness && !snapshot.accountReadiness.ok) {
    return {
      title: snapshot.accountReadiness.reason ?? "The account isn't ready to run",
      detail: snapshot.accountReadiness.detail,
      fixHref: "/console/settings#brokers",
      fixLabel: "Open Settings → Broker accounts"
    };
  }
  return null;
}

/** Map a refusal from POST /api/strategy/run (412 LLM gate, 400 failed run)
 *  onto a reason + the screen that fixes it. Matching is on the server's own
 *  summary strings (src/lib/strategy.ts / llm-required.ts). */
function classifyRunFailure(message: string, status?: number): RunBlock {
  const m = message.toLowerCase();
  if (status === 412 || m.includes("llm provider") || m.includes("llm key")) {
    return {
      title: "No LLM key is configured",
      detail: message,
      fixHref: "/console/settings#api-keys",
      fixLabel: "Open Settings → API keys"
    };
  }
  if (m.includes("kill switch")) {
    return {
      title: "A circuit breaker is holding new entries",
      detail: message,
      note: "A breaker tripping means a hard limit did its job. Review what fired before loosening anything.",
      fixHref: "/console/guardrails",
      fixLabel: "Review Guardrails"
    };
  }
  if (m.includes("halted") || m.includes("stopped")) {
    return {
      title: "The system is stopped",
      detail: `${message} Start it (or switch to Close-only) from the run-state chip in the top bar.`,
      note:
        "While stopped, nothing buys or sells — and this app's automatic stop-losses are paused too. Broker-held brackets keep resting at your broker."
    };
  }
  if (m.includes("already in progress")) {
    return {
      title: "A run is already in progress",
      detail: `${message} Wait for it to finish — Activity shows it as it happens.`,
      fixHref: "/console/activity",
      fixLabel: "Open Activity"
    };
  }
  if (m.includes("budget")) {
    return {
      title: "The daily LLM budget is used up",
      detail: message,
      note: "The budget ceiling lives in the strategy's tuning settings. Raising it raises what a day of runs can cost.",
      fixHref: "/console/strategy",
      fixLabel: "Open Strategy"
    };
  }
  if (m.includes("account")) {
    return {
      title: "Account problem",
      detail: message,
      fixHref: "/console/settings#brokers",
      fixLabel: "Open Settings → Broker accounts"
    };
  }
  return {
    title: "The run failed",
    detail: message,
    fixHref: "/console/activity",
    fixLabel: "See the full story in Activity"
  };
}

export function RunOnceButton({ snapshot, size }: { snapshot: DashboardSnapshot; size?: "sm" }) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [block, setBlock] = useState<RunBlock | null>(null);

  const preflight = deriveRunBlock(snapshot);

  const run = async () => {
    // Blocked runs still respond to the click: they open the "why" sheet with
    // the route to the fix, instead of being a dead disabled button.
    if (preflight) {
      setBlock(preflight);
      return;
    }
    setRunning(true);
    try {
      const result = await runOnce();
      await refresh();
      if (result.status === "failed") {
        setBlock(classifyRunFailure(result.summary || "The run failed."));
      } else {
        toast.push("pos", "Run complete", result.summary);
      }
    } catch (error) {
      if (error instanceof ConsoleApiError) {
        setBlock(classifyRunFailure(error.message, error.status));
      } else {
        setBlock(classifyRunFailure(String(error)));
      }
      void refresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Btn
        variant="primary"
        size={size}
        disabled={running}
        onClick={() => void run()}
        title={
          preflight
            ? `Blocked: ${preflight.title}. Click to see why and where to fix it.`
            : "Manual runs always ask first — they can only propose, never place on their own."
        }
      >
        <Play size={13} />
        {running ? "Running…" : "Run once"}
      </Btn>

      <Sheet open={block !== null} onClose={() => setBlock(null)} title="Run once can't go ahead">
        {block && (
          <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
            <div className="flex items-center gap-2">
              <Chip tone="warn">blocked</Chip>
              <span className="font-semibold">{block.title}</span>
            </div>
            <p className="leading-relaxed text-[color:var(--con-muted)]">{block.detail}</p>
            {block.note && (
              <p className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                {block.note}
              </p>
            )}
            {block.fixHref && (
              <Link
                href={block.fixHref}
                onClick={() => setBlock(null)}
                className="con-btn con-btn-primary self-start"
                title="Takes you straight to the screen where this is fixed."
              >
                {block.fixLabel ?? "Go to the fix"}
              </Link>
            )}
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Manual runs always ask first — they can only propose, never place on their own.
            </p>
          </div>
        )}
      </Sheet>
    </>
  );
}

// ── Signed-in identity + sign out ────────────────────────────────────────────

export function UserMenu({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const user = snapshot.currentUser;
  // No session identity (single-user/local operation) → nothing to sign out of.
  if (!user) return null;

  const who = user.name ?? user.email ?? user.userId;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Signed in as ${user.email ?? who}. Click for account and sign out.`}
        aria-label={`Signed in as ${user.email ?? who} — account menu`}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--con-line-strong)] text-[color:var(--con-muted)] transition-colors hover:border-[color:var(--con-accent)] hover:text-[color:var(--con-accent)]"
      >
        <UserRound size={15} />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Your session">
        <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
          <div>
            <div className="font-semibold">{who}</div>
            {user.email && user.name && <div className="text-[color:var(--con-muted)]">{user.email}</div>}
            <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {user.loginProvider ? `Signed in via ${user.loginProvider}` : "Signed in"}
              {user.isAdmin ? " · operator/admin rights" : ""}
            </div>
          </div>
          <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
            Signing out only ends this browser session. The strategy keeps its current run state on the server — it
            does not stop, start, or sell anything.
          </p>
          <Link
            href="/old"
            className="con-btn con-btn-outline self-start"
            title="Open the legacy dashboard at /old. The new Socratic console is the primary app."
            onClick={() => setOpen(false)}
          >
            Old dashboard
          </Link>
          {/* Server route: clears the Auth.js session cookies and redirects to /login. */}
          <a
            href="/logout"
            className="con-btn con-btn-outline self-start"
            title="End this browser session and return to the sign-in page. Does not change the strategy's run state."
          >
            <LogOut size={14} />
            Sign out
          </a>
        </div>
      </Sheet>
    </>
  );
}

// ── Freshness strip ──────────────────────────────────────────────────────────

export function FreshnessStrip({
  snapshot,
  fetchedAt,
  error,
  stream
}: {
  snapshot: DashboardSnapshot;
  fetchedAt: Date | null;
  error: string | null;
  stream: ConsoleStreamHealth;
}) {
  const spend = deriveSpend(snapshot);
  const scanAt = snapshot.latestStrategyRun?.marketScan?.generatedAt;
  const nextRun = snapshot.scheduler?.nextRunAt;
  const freshnessLabel =
    error ? "delayed"
    : fetchedAt == null ? "loading"
    : stream.status === "reconnecting" ? "aging"
    : "fresh";
  const streamLabel =
    stream.status === "live"
      ? "stream live"
      : stream.status === "connecting"
        ? "stream connecting"
        : stream.status === "reconnecting"
          ? "stream reconnecting"
          : "polling only";
  const streamTitle =
    stream.status === "live"
      ? `Connected ${stream.connectedAt ? fmtExact(stream.connectedAt.toISOString()) : "recently"}${stream.lastEventType ? `; last push ${stream.lastEventType}${stream.lastEventAt ? ` at ${fmtExact(stream.lastEventAt.toISOString())}` : ""}` : ""}.`
      : stream.status === "reconnecting"
        ? `The push stream hit an error${stream.lastErrorAt ? ` at ${fmtExact(stream.lastErrorAt.toISOString())}` : ""}; EventSource will retry automatically while polling continues.`
        : stream.status === "connecting"
          ? "Opening the push stream now."
          : "This browser does not expose EventSource, so the console is using polling only.";
  return (
    <div className="border-t border-[color:var(--con-line)] bg-[color:var(--con-surface)] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5">
        <span title="When this console last fetched data. It refreshes about every 15 seconds.">
          Data as of {fetchedAt ? fmtClock(fetchedAt) : EM_DASH} · {freshnessLabel} · quotes may be delayed
        </span>
        <span title={streamTitle}>{streamLabel}</span>
        {stream.lastEventAt && stream.lastEventType && <span title={fmtExact(stream.lastEventAt.toISOString())}>Push {stream.lastEventType} {timeAgo(stream.lastEventAt.toISOString())}</span>}
        {scanAt && <span title={fmtExact(scanAt)}>Scan {timeAgo(scanAt)}</span>}
        {snapshot.marketSession && <span>Market: {snapshot.marketSession}</span>}
        {nextRun && snapshot.policy.systemState === "active" && <span title={fmtExact(nextRun)}>Next run {timeUntil(nextRun)}</span>}
        <span className="con-num flex min-w-32 items-center gap-2" title="Opening orders only. Exits never consume the daily cap.">
          <ShieldCheck size={12} />
          Today: {fmtMoney(spend.usedNotional)}
          {typeof spend.capNotional === "number" ? ` of ${fmtMoneyWhole(spend.capNotional)}` : ""}
          <Meter value={spend.usedNotional} max={spend.capNotional} className="w-16" />
        </span>
        {error && (
          <span className="font-semibold text-[color:var(--con-warn)]" title={error}>
            refresh failing — showing last good data
          </span>
        )}
      </div>
    </div>
  );
}
