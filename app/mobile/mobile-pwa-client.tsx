"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Check,
  CircleStop,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Trash2,
  Wifi,
  X
} from "lucide-react";

type CommandStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
type MobileCommand = {
  id: string;
  commandType: string;
  status: CommandStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
};
type PendingProposal = {
  id: string;
  accountNumber?: string;
  executionMode?: string;
  estimatedNotional?: number;
  proposal: {
    symbol: string;
    side: string;
    type: string;
    dollarAmount?: number;
    quantity?: number;
    rationale?: string;
  };
};
type MobileSnapshot = {
  currentUser?: { email?: string; userId: string };
  readiness: {
    hasAccount: boolean;
    hasUniverse: boolean;
    systemState: string;
    strategyAuthority: string;
    selectedAccountNumber: string | null;
    commandBacklog: { queued: number; running: number };
    activeConnectedAccount?: { id: string; label: string; broker: string; environment: string; accountNumber?: string } | null;
  };
  policy: {
    systemState: string;
    strategyAuthority: string;
    holdingHorizon?: string;
    maxOrderNotional?: number;
    maxDailyNotional?: number;
    maxDailyOrders?: number;
  };
  marketSession?: { label?: string; isOpen?: boolean };
  scheduler?: { lastRunAt: string | null; nextRunAt: string | null };
  portfolio?: { totalMarketValue?: number; buyingPower?: number; cash?: number };
  positions?: Array<{ symbol: string; quantity: number; marketValue: number; averageCost?: number }>;
  pendingProposals?: PendingProposal[];
  connectedAccounts?: Array<{ id: string; label: string; broker: string; environment: string; isActive: boolean; accountNumber?: string }>;
  watchlist?: Array<{ symbol: string; addedAt: string }>;
  alerts?: Array<{ id: string; symbol: string; op: string; price: number; status: string }>;
  recentCommands?: MobileCommand[];
};
type DeletionRequest = {
  requestId: string;
  email?: string;
  userId: string;
  requiredText: string;
  expiresAt: string;
  steps: string[];
};

function money(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function shortTime(value?: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function statusTone(status: CommandStatus): string {
  if (status === "succeeded") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
  }
  if (status === "failed") return "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200";
  return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";
}

function commandLabel(value: string): string {
  return value.replaceAll(".", " / ").replaceAll("_", " ");
}

function liveApprovalText(symbol: string): string {
  return `APPROVE LIVE ${symbol.trim().toUpperCase()}`;
}

export function MobilePwaClient() {
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbolInput, setSymbolInput] = useState("");
  const [alertInput, setAlertInput] = useState({ symbol: "", op: ">", price: "" });
  const [liveTextByProposal, setLiveTextByProposal] = useState<Record<string, string>>({});
  const [deletionRequest, setDeletionRequest] = useState<DeletionRequest | null>(null);
  const [deleteIdentity, setDeleteIdentity] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = async () => {
    setError(null);
    const response = await fetch("/api/mobile/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    setSnapshot((await response.json()) as MobileSnapshot);
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load mobile snapshot."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/mobile/events");
    const refresh = () => {
      void load().catch(() => {
        /* next manual refresh will surface the error */
      });
    };
    events.addEventListener("mobile.command", refresh);
    events.addEventListener("dashboard.run-complete", refresh);
    events.addEventListener("dashboard.proposal", refresh);
    events.addEventListener("dashboard.order", refresh);
    events.addEventListener("dashboard.market-data", refresh);
    events.addEventListener("dashboard.dirty", refresh);
    return () => events.close();
  }, []);

  const submitCommand = async (commandType: string, payload: Record<string, unknown> = {}) => {
    setBusyCommand(commandType);
    setError(null);
    try {
      const response = await fetch("/api/mobile/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${commandType}:${crypto.randomUUID()}` },
        body: JSON.stringify({
          commandType,
          payload,
          client: { platform: "web", appVersion: "pwa" }
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Command failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Command failed.");
    } finally {
      setBusyCommand(null);
    }
  };

  const startDeletion = async () => {
    setDeleteBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mobile/account-deletion/request", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start deletion.");
      setDeletionRequest(body.deletionRequest);
      setDeleteIdentity("");
      setDeletePhrase("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start deletion.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmDeletion = async () => {
    if (!deletionRequest) return;
    setDeleteBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mobile/account-deletion/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: deletionRequest.requestId,
          typedIdentity: deleteIdentity,
          typedText: deletePhrase
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not delete account.");
      window.location.href = body.logoutUrl ?? "/logout";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete account.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const activeCommand = useMemo(() => snapshot?.recentCommands?.find((c) => c.status === "running" || c.status === "queued"), [snapshot]);
  const pendingProposals = snapshot?.pendingProposals ?? [];
  const positions = snapshot?.positions ?? [];
  const watchlist = snapshot?.watchlist ?? [];
  const alerts = snapshot?.alerts ?? [];

  if (loading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-5 text-fg">
        <div className="flex items-center gap-3 text-sm text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading mobile control
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-bg pb-[calc(env(safe-area-inset-bottom)+24px)] text-fg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 pt-[calc(env(safe-area-inset-top)+12px)] backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-faint">
              <Smartphone className="h-3.5 w-3.5" />
              Mobile control
            </div>
            <h1 className="truncate text-lg font-semibold">Socratic Trade</h1>
          </div>
          <button
            className="grid h-11 w-11 place-items-center rounded-md border border-line bg-surface text-muted active:scale-95"
            onClick={() => void load()}
            aria-label="Refresh mobile snapshot"
            title="Refresh"
          >
            <RefreshCw className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-xl space-y-4 px-4 py-4">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
            {error}
          </div>
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-faint">Mode</p>
              <p className="text-xl font-semibold capitalize">{snapshot?.readiness.systemState ?? "unknown"}</p>
            </div>
            <div className="rounded-md border border-line bg-surface px-3 py-2 text-right">
              <p className="text-xs text-faint">Authority</p>
              <p className="text-sm font-medium capitalize">{snapshot?.readiness.strategyAuthority ?? "-"}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-50"
              disabled={busyCommand !== null}
              onClick={() => void submitCommand("strategy.run_once")}
            >
              <Activity className="h-4 w-4" />
              Run once
            </button>
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg disabled:opacity-50"
              disabled={busyCommand !== null}
              onClick={() => void submitCommand("strategy.start")}
            >
              <Wifi className="h-4 w-4" />
              Start
            </button>
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg disabled:opacity-50"
              disabled={busyCommand !== null}
              onClick={() => void submitCommand("strategy.close_only")}
            >
              <ShieldAlert className="h-4 w-4" />
              Close only
            </button>
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 text-sm font-semibold text-red-700 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
              disabled={busyCommand !== null}
              onClick={() => void submitCommand("strategy.stop")}
            >
              <CircleStop className="h-4 w-4" />
              Stop
            </button>
          </div>

          {activeCommand && (
            <div className={`rounded-md border px-3 py-2 text-sm ${statusTone(activeCommand.status)}`}>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                <span className="capitalize">{commandLabel(activeCommand.commandType)}</span>
                <span className="ml-auto capitalize">{activeCommand.status}</span>
              </div>
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-2">
          <Metric label="Equity" value={money(snapshot?.portfolio?.totalMarketValue)} />
          <Metric label="Buying power" value={money(snapshot?.portfolio?.buyingPower)} />
          <Metric label="Account" value={snapshot?.readiness.activeConnectedAccount?.label ?? "None"} />
          <Metric label="Market" value={snapshot?.marketSession?.label ?? (snapshot?.marketSession?.isOpen ? "Open" : "Closed")} />
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Approvals</h2>
            <span className="text-xs text-faint">{pendingProposals.length}</span>
          </div>
          {pendingProposals.length === 0 ? (
            <Empty label="No pending proposals" />
          ) : (
            pendingProposals.map((proposal) => {
              const live = proposal.executionMode === "broker/live";
              const typedText = liveTextByProposal[proposal.id] ?? "";
              const expectedLiveText = liveApprovalText(proposal.proposal.symbol);
              const livePhraseMatches = !live || typedText.trim().toUpperCase() === expectedLiveText;
              return (
                <div key={proposal.id} className="rounded-md border border-line bg-surface p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-base font-semibold">{proposal.proposal.symbol}</p>
                      <p className="text-xs uppercase text-faint">
                        {proposal.proposal.side} · {proposal.proposal.type} · {proposal.executionMode ?? "mode unknown"}
                      </p>
                    </div>
                    <p className="text-sm font-medium">{money(proposal.estimatedNotional)}</p>
                  </div>
                  {proposal.proposal.rationale && (
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">{proposal.proposal.rationale}</p>
                  )}
                  {live && (
                    <div className="mt-3">
                      <label className="text-xs font-semibold uppercase tracking-wide text-faint" htmlFor={`mobile-live-${proposal.id}`}>
                        Type exactly: <span className="font-mono text-fg">{expectedLiveText}</span>
                      </label>
                      <input
                        id={`mobile-live-${proposal.id}`}
                        className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-base text-fg outline-none focus:border-accent"
                        placeholder={expectedLiveText}
                        value={typedText}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        onPaste={(event) => event.preventDefault()}
                        onChange={(event) => setLiveTextByProposal((prev) => ({ ...prev, [proposal.id]: event.target.value }))}
                      />
                      <p className="mt-1 text-xs text-faint">
                        Paste is disabled; mobile approvals use the same broker check as console.
                      </p>
                    </div>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      className="min-h-11 rounded-md bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-50"
                      disabled={busyCommand !== null || !livePhraseMatches}
                      onClick={() =>
                        void submitCommand("proposal.approve", {
                          proposalId: proposal.id,
                          ...(live
                            ? {
                                liveConfirmation: {
                                  proposalId: proposal.id,
                                  accountNumber: proposal.accountNumber,
                                  executionMode: "broker/live",
                                  estimatedNotional: proposal.estimatedNotional ?? null,
                                  typedText: typedText.trim().toUpperCase()
                                }
                              }
                            : {})
                        })
                      }
                    >
                      <Check className="mr-1 inline h-4 w-4" />
                      Approve
                    </button>
                    <button
                      className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm font-semibold text-fg disabled:opacity-50"
                      disabled={busyCommand !== null}
                      onClick={() => void submitCommand("proposal.reject", { proposalId: proposal.id })}
                    >
                      <X className="mr-1 inline h-4 w-4" />
                      Reject
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Watchlist</h2>
          <div className="flex gap-2">
            <input
              className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
              autoCapitalize="characters"
              placeholder="Ticker"
              value={symbolInput}
              onChange={(event) => setSymbolInput(event.target.value)}
            />
            <button
              className="grid h-11 w-11 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
              disabled={busyCommand !== null || !symbolInput.trim()}
              onClick={() => {
                void submitCommand("watchlist.add", { symbol: symbolInput });
                setSymbolInput("");
              }}
              aria-label="Add ticker"
              title="Add ticker"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {watchlist.length === 0 ? (
              <span className="text-sm text-faint">No tickers yet</span>
            ) : (
              watchlist.map((item) => (
                <button
                  key={item.symbol}
                  className="min-h-9 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg"
                  onClick={() => void submitCommand("watchlist.remove", { symbol: item.symbol })}
                >
                  {item.symbol}
                </button>
              ))
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Price Alerts</h2>
          <div className="grid grid-cols-[minmax(0,1fr)_76px_minmax(0,1fr)_44px] gap-2">
            <input
              className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
              placeholder="Ticker"
              value={alertInput.symbol}
              onChange={(event) => setAlertInput((prev) => ({ ...prev, symbol: event.target.value }))}
            />
            <select
              className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-2 text-base text-fg outline-none focus:border-accent"
              value={alertInput.op}
              onChange={(event) => setAlertInput((prev) => ({ ...prev, op: event.target.value }))}
              aria-label="Alert direction"
            >
              <option value=">">Above</option>
              <option value="<">Below</option>
            </select>
            <input
              className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
              inputMode="decimal"
              placeholder="Price"
              value={alertInput.price}
              onChange={(event) => setAlertInput((prev) => ({ ...prev, price: event.target.value }))}
            />
            <button
              className="grid h-11 w-11 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
              disabled={busyCommand !== null || !alertInput.symbol.trim() || !alertInput.price.trim()}
              onClick={() => {
                void submitCommand("alert.create", alertInput);
                setAlertInput({ symbol: "", op: ">", price: "" });
              }}
              aria-label="Create alert"
              title="Create alert"
            >
              <Bell className="h-5 w-5" />
            </button>
          </div>
          <div className="space-y-2">
            {alerts.length === 0 ? (
              <Empty label="No alerts" />
            ) : (
              alerts.slice(0, 8).map((alert) => (
                <div key={alert.id} className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm">
                  <span className="font-semibold">{alert.symbol}</span>
                  <span className="text-muted">
                    {alert.op} {money(alert.price)}
                  </span>
                  <span className="ml-auto capitalize text-faint">{alert.status}</span>
                  <button
                    className="grid h-8 w-8 place-items-center rounded-md text-muted"
                    onClick={() => void submitCommand("alert.delete", { alertId: alert.id })}
                    aria-label={`Delete ${alert.symbol} alert`}
                    title="Delete alert"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Positions</h2>
            <span className="text-xs text-faint">{positions.length}</span>
          </div>
          {positions.length === 0 ? (
            <Empty label="No positions" />
          ) : (
            positions.slice(0, 10).map((position) => (
              <div key={position.symbol} className="flex min-h-11 items-center rounded-md border border-line bg-surface px-3 text-sm">
                <span className="font-semibold">{position.symbol}</span>
                <span className="ml-3 text-muted">{position.quantity} sh</span>
                <span className="ml-auto font-medium">{money(position.marketValue)}</span>
              </div>
            ))
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Command Log</h2>
          {(snapshot?.recentCommands ?? []).length === 0 ? (
            <Empty label="No mobile commands yet" />
          ) : (
            (snapshot?.recentCommands ?? []).slice(0, 8).map((command) => (
              <div key={command.id} className={`rounded-md border px-3 py-2 text-sm ${statusTone(command.status)}`}>
                <div className="flex items-center gap-2">
                  {command.status === "running" || command.status === "queued" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {command.status === "failed" ? <ShieldAlert className="h-4 w-4" /> : null}
                  {command.status === "succeeded" ? <Check className="h-4 w-4" /> : null}
                  {command.status === "cancelled" ? <CircleStop className="h-4 w-4" /> : null}
                  <span className="capitalize">{commandLabel(command.commandType)}</span>
                  <span className="ml-auto">{shortTime(command.updatedAt)}</span>
                </div>
                {command.error && <p className="mt-1 text-xs">{command.error}</p>}
              </div>
            ))
          )}
        </section>

        <section className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/5">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-200" />
            <div>
              <h2 className="text-sm font-semibold text-red-800 dark:text-red-100">Delete app account</h2>
              <p className="mt-1 text-sm leading-relaxed text-red-700 dark:text-red-100/80">
                This deletes the backend account tied to the current Google or Apple login. Broker and provider
                secrets stored on the server are deleted. Signing in later with the same provider creates a fresh
                app account with no prior trading data attached.
              </p>
            </div>
          </div>

          {!deletionRequest ? (
            <button
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-red-300 bg-red-100 px-3 text-sm font-semibold text-red-800 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
              disabled={deleteBusy}
              onClick={() => void startDeletion()}
            >
              <Trash2 className="h-4 w-4" />
              Start deletion steps
            </button>
          ) : (
            <div className="space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-red-700 dark:text-red-100/80">
                {deletionRequest.steps.map((step, index) => (
                  <li key={`${index}-${step}`}>{step}</li>
                ))}
              </ol>
              <input
                className="min-h-11 w-full rounded-md border border-red-200 bg-bg px-3 text-base text-fg outline-none focus:border-red-400 dark:border-red-500/30 dark:focus:border-red-300"
                placeholder={deletionRequest.email ? "Type signed-in email" : "Type app user id"}
                value={deleteIdentity}
                onChange={(event) => setDeleteIdentity(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
              <input
                className="min-h-11 w-full rounded-md border border-red-200 bg-bg px-3 text-base text-fg outline-none focus:border-red-400 dark:border-red-500/30 dark:focus:border-red-300"
                placeholder="Type required phrase"
                value={deletePhrase}
                onChange={(event) => setDeletePhrase(event.target.value)}
                autoCapitalize="characters"
                autoCorrect="off"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg"
                  onClick={() => {
                    setDeletionRequest(null);
                    setDeleteIdentity("");
                    setDeletePhrase("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={
                    deleteBusy ||
                    deleteIdentity.trim().toLowerCase() !== (deletionRequest.email ?? deletionRequest.userId).toLowerCase() ||
                    deletePhrase.trim() !== deletionRequest.requiredText
                  }
                  onClick={() => void confirmDeletion()}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete and sign out
                </button>
              </div>
              <p className="text-xs text-red-700/80 dark:text-red-100/70">
                This resets the backend account. OAuth access at Google or Apple is provider-side; revoke it in
                that account's security settings if you also want to remove this app from your provider account.
              </p>
            </div>
          )}
        </section>

        <footer className="flex items-center justify-center gap-2 py-3 text-xs text-faint">
          <Wifi className="h-3.5 w-3.5" />
          Backend is source of truth. No broker/provider secrets are stored on this device.
        </footer>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-20 rounded-md border border-line bg-surface p-3">
      <p className="text-xs uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-faint">
      {label}
    </div>
  );
}
