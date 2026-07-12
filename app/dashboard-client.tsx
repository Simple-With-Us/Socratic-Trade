"use client";

import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BrainCircuit,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Columns3,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  HelpCircle,
  Hourglass,
  Info,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LineChartIcon,
  LogOut,
  Moon,
  Network,
  Pause,
  Percent,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings as SettingsIcon,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
  Sun,
  Wallet,
  X,
  XCircle,
  Zap
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { TableVirtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { DEFAULT_STRATEGY_PROMPT } from "@/lib/defaults";
import { deriveMetrics } from "@/lib/derived-metrics";
import { deriveExecutionState, type ExecutionState } from "@/lib/execution-mode";
import {
  STOPPED_PROPOSAL_ACTION_DESCRIPTION,
  STOPPED_PROPOSAL_ACTION_TITLE,
  isProposalActionStopped
} from "@/lib/proposal-actions";
import {
  companyTitle,
  enrichPositionsForDisplay,
  formatSourceList,
  formatNotificationDisplay,
  formatShareQuantity,
  friendlySource,
  quoteTitle,
  ratingTitle,
  receivedLabel,
  sentimentTitle
} from "@/lib/dashboard-ui";
import type { EnrichedPosition } from "@/lib/dashboard-ui";
import { buildStrategyReviewDisplay, type StrategyReviewChange } from "@/lib/strategy-review-display";
import {
  INDEX_UNIVERSES,
  SUPPORTED_INDEX_UNIVERSES,
  indexUniverseSymbolCount,
  isValidAppSymbol,
  policyUniverseSymbolCount,
  toggleIncludedIndex
} from "@/lib/index-universes";
import { DEFAULT_TICKER_LOGO_DISPLAY, isTickerLogoDisplay } from "@/lib/ticker-logos";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import {
  DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  DEFAULT_MARKET_SCAN_OUTLIER_RESERVE,
  MAX_MARKET_SCAN_CANDIDATE_LIMIT,
  MAX_MARKET_SCAN_OUTLIER_RESERVE,
  MIN_MARKET_SCAN_CANDIDATE_LIMIT,
  MIN_MARKET_SCAN_OUTLIER_RESERVE,
  normalizeMarketScanCandidateLimit,
  normalizeMarketScanOutlierReserve
} from "@/lib/scan-settings";
import type {
  EquityOrder,
  EquityPosition,
  ExecutionMode,
  IndexUniverse,
  MarketQuote,
  MarketScan,
  NotificationSettings,
  ScoringWeights,
  StrategyTuningProposal,
  TradingPolicy,
  TradeProposal,
  ConnectedAccount
} from "@/lib/types";
import type { DashboardSnapshot, UnifiedActivityGroup } from "./dashboard-types";
import {
  scopeTagForSection,
  settingsTierForSection,
  type SettingsSection,
  type SettingsTier
} from "./settings-scope";
import {
  FEED_TAB_KEY,
  WORKSPACE_TAB_KEY,
  isFeedTab,
  isNavV2Enabled,
  isStrategyConsolidationEnabled,
  isWorkspaceTab,
  migrateNavKeysToDestinations,
  type FeedTab,
  type WorkspaceTab
} from "./nav-destinations";
import { GLOSSARY_RULE_OF_THUMB, SETTINGS_GLOSSARY } from "./settings-search";
import { compactMoney, compactNum, formatPct, money, pnlTone, signedMoney } from "./dashboard-widgets";
import { cn } from "./ui/cn";
import dynamic from "next/dynamic";
import { AllocationDonut, EquityCurve, ScorecardBars } from "./ui/charts";
import { MacroBoardView } from "./ui/macro-panel";
import { AssistantView } from "./ui/assistant-console";
import { DeliveryChannelsPanel } from "./ui/delivery-channels";
import { SymbolButton } from "./ui/symbol-button";
import { TickerLogo } from "./ui/ticker-logo";
import { ConfirmModal, Modal, SlideOver } from "./ui/overlays";
import { LearnedContextQueue, LearnedContextQueueBadge } from "./ui/learned-context-queue";
import {
  Button,
  buttonClass,
  Card,
  Chip,
  Dot,
  EmptyState,
  Field,
  ICON,
  IconButton,
  PanelHeader,
  Segmented,
  StatTile,
  Switch,
  Tabs,
  inputClass
} from "./ui/primitives";
import { useTheme } from "./ui/theme";
import { CommandPalette, type Command } from "./ui/command-palette";
import { ConfirmationModal } from "./components/ConfirmationModal";
import {
  CURATED_LLM_MODEL_GROUPS,
  CURATED_LLM_MODEL_IDS as STRATEGY_MODEL_IDS,
  CUSTOM_MODEL_ID_SEED as CUSTOM_STRATEGY_MODEL_SEED,
  DEFAULT_LLM_MODEL
} from "./ui/llm-model-catalog";

// Code-split the two heaviest tab payloads out of the initial dashboard bundle:
//  • StrategyFlow pulls in @xyflow/react (~3.9MB) + its CSS — only needed when the Strategy Flow
//    modal opens.
//  • SymbolDrilldown pulls in PriceChart (which lazy-loads lightweight-charts) — only needed when a
//    symbol drilldown slide-over opens.
// Both are client-only (`ssr: false`) with lightweight loading fallbacks matching our skeleton /
// EmptyState conventions, so @xyflow/react and the drilldown chart boundary never ship on first load.
const StrategyFlow = dynamic(() => import("./ui/strategy-flow").then((m) => m.StrategyFlow), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center py-10">
      <EmptyState icon={<Network size={18} />} title="Loading strategy flow…" />
    </div>
  )
});
const SymbolDrilldown = dynamic(() => import("./ui/symbol-drilldown").then((m) => m.SymbolDrilldown), {
  ssr: false,
  loading: () => <EmptyState title="Loading symbol details…" />
});
const SymbolDrilldownTitle = dynamic(() => import("./ui/symbol-drilldown").then((m) => m.SymbolDrilldownTitle), {
  ssr: false,
  loading: () => <span className="text-sm font-medium text-muted">Symbol</span>
});

type SortDir = "asc" | "desc";
type PolicyPatch = Partial<TradingPolicy> & { strategyPrompt?: string };

function renderCuratedModelOptions(descriptive: boolean = true): React.ReactNode {
  return CURATED_LLM_MODEL_GROUPS.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.options.map((option) => (
        <option key={option.value} value={option.value}>
          {descriptive ? option.label : option.value === DEFAULT_LLM_MODEL ? `${option.value} (default)` : option.value}
        </option>
      ))}
    </optgroup>
  ));
}

type MarketReplaceCandidate = {
  order: EquityOrder;
  ageMinutes: number;
  thresholdMinutes: number;
  remainingQuantity: number;
};
type AccountDeletionPreview = {
  userId: string;
  email?: string;
  isLocalOperatorAccount: boolean;
  prepared: boolean;
  requestedAt?: string;
  connectedAccounts: Array<{ id: string; label: string; broker: string; environment: string; accountNumber?: string; isActive: boolean }>;
  blockers: { runningStrategyRuns: number; placingProposals: number; pendingReconciliationFills: number; activeMobileCommands: number };
  counts: Record<string, number>;
};
const TICKER_LOGO_DISPLAY_KEY = "ticker-logo-display";
const EXECUTION_BANNER_COMPACT_KEY = "execution-banner-compact";
const LEGACY_EXECUTION_BANNER_HIDDEN_KEY = "execution-banner-hidden";
// New source-of-truth for the 3-way banner mode. The legacy keys above were both boolean and only
// ever produced a VISIBLE banner (compact), so they must NOT be read as the new "hidden" state —
// they migrate to compact instead (see the read effect) so upgrading users never lose the safety
// banner without explicitly choosing Hidden.
const EXECUTION_BANNER_MODE_KEY = "execution-banner-mode";
type ExecutionBannerMode = "full" | "compact" | "hidden";
const HIDE_TEST_ACCOUNT_KEY = "hide-test-account";
const STRATEGY_TUNING_STORAGE_KEY = "strategy-tuning-proposal";
const ALPACA_PAPER_ENDPOINT = "https://paper-api.alpaca.markets/v2";
const ALPACA_BROKERAGE_ENDPOINT = "https://api.alpaca.markets";
const ACCOUNT_DELETE_PHRASE = "DELETE MY ACCOUNT";
const LOCAL_OPERATOR_DELETE_PHRASE = "DELETE LOCAL OPERATOR ACCOUNT";
const DEFAULT_STALE_LIMIT_ORDER_MINUTES = 15;
const MARKET_REPLACE_ORDER_TYPES = new Set(["limit", "stop_limit"]);
const MARKET_REPLACE_ACTIVE_ORDER_STATES = new Set([
  "accepted",
  "accepted_for_bidding",
  "confirmed",
  "held",
  "new",
  "open",
  "partially_filled",
  "pending_cancel",
  "pending_new",
  "pending_replace",
  "queued",
  "submitted",
  "suspended",
  "unconfirmed",
  "done_for_day",
  "stopped",
  "calculated"
]);
type RobinhoodMcpHealth = {
  adapter?: "mcp";
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  url?: string;
  protocolVersion?: string;
  transport?: string;
  tools: string[];
  checkedAt: string;
  error?: string;
  warning?: string;
};

function alpacaDefaultEndpointFor(environment: ConnectedAccount["environment"] | undefined): string {
  return environment === "live" ? ALPACA_BROKERAGE_ENDPOINT : ALPACA_PAPER_ENDPOINT;
}

function inferAlpacaEnvironment(input: { accountNumber?: string; apiKey?: string; environment?: ConnectedAccount["environment"] }): ConnectedAccount["environment"] {
  const accountNumber = input.accountNumber?.trim().toUpperCase() ?? "";
  const apiKey = input.apiKey?.trim().toUpperCase() ?? "";
  if (accountNumber.startsWith("PA") || apiKey.startsWith("PK")) return "paper";
  // Credential-authoritative once creds are entered: non-PA/PK Alpaca creds are LIVE. This matches
  // the server, which infers environment purely from the credentials and ignores body.environment —
  // so the client must not stay stuck on a seeded "paper" (which previously made a live account fall
  // back to the paper host / baseUrl and 401). Only fall back to the prior/seeded environment when NO
  // credentials have been entered yet, so a brand-new draft still shows the paper default until typed.
  if (accountNumber || apiKey) return "live";
  return input.environment === "paper" ? "paper" : "live";
}

function normalizeEndpoint(value?: string): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function hasCustomAlpacaEndpoint(account: Partial<ConnectedAccount>): boolean {
  if (account.broker !== "alpaca") return Boolean(account.baseUrl?.trim());
  const endpoint = normalizeEndpoint(account.baseUrl);
  if (!endpoint) return false;
  return endpoint !== normalizeEndpoint(alpacaDefaultEndpointFor(account.environment));
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function readStoredWorkspaceTab(): WorkspaceTab {
  if (typeof window === "undefined") return "decision";
  try {
    const saved = window.localStorage.getItem(WORKSPACE_TAB_KEY);
    return isWorkspaceTab(saved) ? saved : "decision";
  } catch {
    return "decision";
  }
}

function readStoredFeedTab(): FeedTab {
  if (typeof window === "undefined") return "activity";
  try {
    const saved = window.localStorage.getItem(FEED_TAB_KEY);
    return isFeedTab(saved) ? saved : "activity";
  } catch {
    return "activity";
  }
}

function isStrategyTuningProposal(value: unknown): value is StrategyTuningProposal {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<StrategyTuningProposal>;
  return (
    typeof proposal.summary === "string" &&
    typeof proposal.rationale === "string" &&
    typeof proposal.marketContext === "string" &&
    typeof proposal.performanceReadout === "string" &&
    proposal.proposedPatch !== null &&
    typeof proposal.proposedPatch === "object" &&
    Array.isArray(proposal.cautions) &&
    typeof proposal.confidenceScore === "number" &&
    (proposal.generatedBy === "llm" || proposal.generatedBy === "local_rules")
  );
}

function readStoredStrategyTuning(): StrategyTuningProposal | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(STRATEGY_TUNING_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as unknown;
    return isStrategyTuningProposal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function plainAppError(raw: string, fallback = "Something went wrong."): string {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  let message = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; summary?: unknown; message?: unknown };
    const nested = parsed.error;
    if (typeof parsed.summary === "string") message = parsed.summary;
    else if (typeof parsed.message === "string") message = parsed.message;
    else if (typeof nested === "string") message = nested;
    else if (nested && typeof nested === "object" && "error" in nested && typeof (nested as { error?: unknown }).error === "string") message = String((nested as { error: string }).error);
  } catch {
    if (trimmed.startsWith("<")) return fallback;
  }
  if (/Incorrect API key provided/i.test(message) && /console\.x\.ai|x\.ai/i.test(message)) {
    return "The xAI API key was rejected. Open Settings -> Connections to update the xAI key, or choose an OpenAI model in Strategy Studio.";
  }
  if (/Incorrect API key provided/i.test(message) && /openai|platform\.openai/i.test(message)) {
    return "The OpenAI API key was rejected. Open Settings -> Connections to update the OpenAI key, or choose a model your key can access in Strategy Studio.";
  }
  if (/System is halted/i.test(message)) {
    return "The system is stopped. Press Start for scheduled/autonomous runs, or use Run once for a manual proposal check.";
  }
  if (/No account selected/i.test(message)) {
    return "Select an account before running the strategy. Use the account menu or Accounts modal.";
  }
  if (/agentic_allowed/i.test(message)) {
    return "The selected broker account is not approved for agentic execution. Choose an agentic-enabled account.";
  }
  return message.length > 280 ? `${message.slice(0, 277)}...` : message;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const raw = await response.text().catch(() => "");
  return new Error(plainAppError(raw, `${fallback} (${response.status}).`));
}

function showStoppedProposalActionToast() {
  toast.warning(STOPPED_PROPOSAL_ACTION_TITLE, { description: STOPPED_PROPOSAL_ACTION_DESCRIPTION });
}

function humanizeBrokerError(msg: string): string {
  if (/robinhood mcp http 401/i.test(msg)) return "Robinhood session expired — reconnect in Settings → Connections";
  if (/robinhood.*not connected/i.test(msg)) return "Robinhood not connected — reconnect in Settings → Connections";
  if (/robinhood.*session expired/i.test(msg)) return "Robinhood session expired — reconnect in Settings → Connections";
  return msg;
}

function activeConnectedAccountFor(snapshot: DashboardSnapshot) {
  return (
    snapshot.connectedAccounts?.find((account) => account.id === snapshot.policy.connectedAccountId) ??
    snapshot.connectedAccounts?.find((account) => account.isActive)
  );
}

function executionStateFor(snapshot: DashboardSnapshot): ExecutionState {
  return deriveExecutionState(snapshot.policy, activeConnectedAccountFor(snapshot));
}

function visibleConnectedAccounts(
  accounts: ConnectedAccount[] | undefined,
  hideTestAccount: boolean,
  activeAccountId?: string
): ConnectedAccount[] {
  return (accounts ?? []).filter((account) => {
    if (!hideTestAccount || account.broker !== "test") return true;
    // Keep the active Test row visible until the user switches away; hiding the active
    // selection would make the account state look blank while Test is still in force.
    return Boolean(activeAccountId && account.id === activeAccountId);
  });
}

// Persistent tri-state safety banner (blueprint R1 §1.3): the active-account-driven mode
// decides the color + message so a live (Brokerage) session can never be mistaken for a
// Test sandbox. Display-only — it does not place or gate orders.
function brokerNameForBanner(state: ExecutionState): string {
  if (state.broker === "alpaca" || state.broker === "alpaca-mcp") return "Alpaca";
  if (state.broker === "robinhood") return "Robinhood";
  return state.accountLabel ?? "Broker";
}

function executionBanner(state: ExecutionState): { className: string; title: string; content: React.ReactNode } {
  if (state.mode === "broker/live") {
    const brokerName = brokerNameForBanner(state);
    const title = `${brokerName} Brokerage Account`;
    const detail = `orders route to ${state.accountLabel ?? `${brokerName} Brokerage`}`;
    return {
      className: "border-red-900 bg-red-950/70 text-red-200 ring-1 ring-red-500/40 motion-safe:animate-pulse",
      title: `${title} • ${detail}`,
      content: (
        <>
          <strong className="font-semibold not-italic">{title}</strong>
          <span className="font-normal italic"> • {detail}</span>
        </>
      )
    };
  }
  if (state.mode === "broker/paper") {
    const brokerName = brokerNameForBanner(state);
    const title = `${brokerName} Paper Account`;
    const routeLabel = state.broker === "alpaca" || state.broker === "alpaca-mcp" ? "Alpaca Paper" : `${brokerName} Paper`;
    const detail = `orders route to ${routeLabel} • not real money`;
    return {
      className: "border-emerald-900/60 bg-emerald-950/40 text-emerald-300",
      title: `${title} • ${detail}`,
      content: (
        <>
          <strong className="font-semibold not-italic">{title}</strong>
          <span className="font-normal italic"> • {detail}</span>
        </>
      )
    };
  }
  const title = "No Account Connected";
  const detail = "connect a broker account (paper or live) before the app can place orders";
  return {
    className: "border-slate-800 bg-slate-900/70 text-slate-300",
    title: `${title} • ${detail}`,
    content: (
      <>
        <strong className="font-semibold not-italic">{title}</strong>
        <span className="font-normal italic"> • {detail}</span>
      </>
    )
  };
}

type ReadinessItem = {
  label: string;
  detail: string;
  ok: boolean;
  actionLabel?: string;
  onAction?: () => void;
};

function ReadinessStrip({ items }: { items: ReadinessItem[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface/70 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted sm:text-[11px]">Readiness</span>
          {items.map((item) => (
            <span
              key={item.label}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium sm:px-2 sm:py-1 sm:text-[11px]",
                item.ok ? "bg-up/10 text-up" : "bg-warn/10 text-warn"
              )}
              title={item.detail}
            >
              {item.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
              {item.label}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {items
            .filter((item) => !item.ok && item.onAction)
            .slice(0, 2)
            .map((item) => (
              <Button key={item.label} size="sm" variant="ghost" onClick={item.onAction}>
                {item.actionLabel ?? item.label}
              </Button>
            ))}
        </div>
      </div>
    </div>
  );
}

type DashboardCurrentUser = NonNullable<DashboardSnapshot["currentUser"]>;

function loginProviderLabel(provider?: string): string {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "google") return "Google";
  if (normalized === "github") return "GitHub";
  if (normalized === "apple") return "Apple";
  if (!normalized) return "App";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function userInitials(user?: DashboardCurrentUser): string {
  const source = user?.name?.trim() || user?.email?.split("@")[0] || "User";
  const parts = source
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("");
  return initials || "U";
}

function AccountMenu({
  user,
  pendingCount,
  onOpenActivity,
  onOpenSettings,
  onOpenAccounts,
  onOpenHelp,
  onSignOut
}: {
  user?: DashboardCurrentUser;
  pendingCount: number;
  onOpenActivity: () => void;
  onOpenSettings: () => void;
  onOpenAccounts: () => void;
  onOpenHelp: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { theme, toggle } = useTheme();
  const provider = loginProviderLabel(user?.loginProvider);
  const email = user?.email ?? "Local session";
  const name = user?.name ?? (user?.email ? user.email.split("@")[0] : "Signed in");
  const imageUrl = user?.imageUrl && !imageFailed ? user.imageUrl : undefined;

  useEffect(() => {
    setImageFailed(false);
  }, [user?.imageUrl]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  const avatar = (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center lg:h-9 lg:w-9">
      <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-line bg-accent/15 text-xs font-semibold text-accent">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          userInitials(user)
        )}
      </span>
      {pendingCount > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn px-0.5 text-[9px] font-bold text-black ring-2 ring-surface"
        >
          {pendingCount}
        </span>
      )}
    </span>
  );

  const menuItemClass =
    "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm text-fg transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none";
  const menuItemLeftClass = "flex min-w-0 items-center gap-2.5";

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Profile menu"
        title={`${name} · ${email}`}
        onClick={() => setOpen((value) => !value)}
        className="relative inline-flex h-8 items-center gap-1 rounded-full border border-line bg-surface/60 pr-1.5 text-fg shadow-sm transition-colors hover:bg-surface-2/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:h-9"
      >
        {avatar}
        <ChevronDown size={14} className="text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-[1200] mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-line bg-surface p-2 text-fg shadow-[var(--shadow-lg)]"
        >
          <div className="flex items-center gap-3 border-b border-line px-2.5 py-2.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-accent/15 text-sm font-semibold text-accent">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                  onError={() => setImageFailed(true)}
                />
              ) : (
                userInitials(user)
              )}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">{name}</div>
              <div className="truncate text-xs text-muted" title={email}>{email}</div>
              <div className="mt-0.5 text-[11px] text-faint">{provider} account</div>
            </div>
          </div>

          <div className="mt-1 space-y-0.5">
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => run(onOpenSettings)}>
              <span className={menuItemLeftClass}><SettingsIcon size={16} /> Settings</span>
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => run(onOpenAccounts)}>
              <span className={menuItemLeftClass}><Wallet size={16} /> Account Management</span>
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => run(onOpenActivity)}>
              <span className={menuItemLeftClass}><ActivityIcon size={16} /> Activity Log</span>
              {pendingCount > 0 && (
                <span className="rounded-full bg-warn/20 px-2 py-0.5 text-[11px] font-semibold text-warn">
                  {pendingCount}
                </span>
              )}
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => run(onOpenHelp)}>
              <span className={menuItemLeftClass}><HelpCircle size={16} /> System Help</span>
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => run(toggle)}>
              <span className={menuItemLeftClass}>
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                {theme === "dark" ? "Light Mode" : "Dark Mode"}
              </span>
            </button>
          </div>

          <div className="mt-1 border-t border-line pt-1">
            <button type="button" role="menuitem" className={cn(menuItemClass, "text-down hover:bg-down/10")} onClick={() => run(onSignOut)}>
              <span className={menuItemLeftClass}><LogOut size={16} /> Sign Out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Workspace tab IA: the five primary tabs stay inline; Macro and Tax are demoted
// behind a "More" overflow so the single-screen tab row stays scannable. Both
// remain deep-linkable and persisted via the same WORKSPACE_TAB_KEY/workspaceTab
// state (see readStoredWorkspaceTab) — the overflow only changes presentation.
const PRIMARY_WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "decision", label: "Decision" },
  { id: "assistant", label: "Assistant" },
  { id: "market", label: "Market Scan" },
  { id: "performance", label: "Performance" },
  { id: "strategy", label: "Strategy" }
];
const OVERFLOW_WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "macro", label: "Macro" },
  { id: "tax", label: "Tax" }
];

/**
 * Workspace tab bar: primary tabs via the shared `Tabs` primitive (which keeps
 * `role="tablist"` + roving arrow-key nav) plus a "More" overflow menu holding
 * Macro and Tax. The overflow menu items are `role="tab"` with `aria-selected`
 * so an active overflow tab is announced correctly, and the "More" trigger
 * reflects/labels the active overflow tab so the user always sees where they are.
 */
function WorkspaceTabsBar({
  value,
  onChange
}: {
  value: WorkspaceTab;
  onChange: (v: WorkspaceTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const activeOverflow = OVERFLOW_WORKSPACE_TABS.find((t) => t.id === value);

  // The tab row lives inside an `overflow-x-auto` scroll container, which also clips VERTICAL
  // overflow — an absolutely-positioned `top-full` dropdown gets cut off on exactly the narrow
  // layouts this overflow menu exists for. So position the menu with `fixed` coords derived from the
  // trigger's rect, escaping the clip; recompute on open and close on scroll/resize (fixed coords
  // would otherwise drift as the row scrolls).
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function close() {
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div className="flex items-center gap-1">
      <Tabs value={value} onChange={onChange} tabs={PRIMARY_WORKSPACE_TABS} />
      <div ref={menuRef} className="relative">
        <button
          ref={btnRef}
          type="button"
          id="tab-more"
          role="tab"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-selected={Boolean(activeOverflow)}
          aria-controls={activeOverflow ? `tabpanel-${activeOverflow.id}` : undefined}
          title="More workspaces"
          onClick={() => (open ? setOpen(false) : openMenu())}
          className={cn(
            "inline-flex items-center gap-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-[13px] font-medium transition-colors touch-manipulation max-sm:min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
            activeOverflow ? "text-fg shadow-sm" : "text-muted hover:text-fg"
          )}
        >
          {activeOverflow ? activeOverflow.label : "More"}
          <ChevronDown size={ICON.sm} className={cn("transition-transform", open && "rotate-180")} />
        </button>
        {open && menuPos && (
          <div
            role="menu"
            aria-label="More workspaces"
            style={{ top: menuPos.top, right: menuPos.right }}
            className="fixed z-[1200] w-44 rounded-lg border border-line bg-surface p-1 text-fg shadow-[var(--shadow-lg)]"
          >
            {OVERFLOW_WORKSPACE_TABS.map((tab) => {
              const active = value === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={active}
                  aria-controls={`tabpanel-${tab.id}`}
                  onClick={() => {
                    onChange(tab.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors focus:outline-none focus-visible:bg-surface-2 focus-visible:outline-none",
                    active ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function DashboardClient({ initialSnapshot }: { initialSnapshot: DashboardSnapshot | null }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!initialSnapshot) return mounted ? <DashboardBootstrap /> : <DashboardSsrShell />;
  if (!mounted) return <DashboardSsrShell snapshot={initialSnapshot} />;
  return <DashboardApp initialSnapshot={initialSnapshot} />;
}

function DashboardBootstrap() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadInitialSnapshot() {
      try {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        if (!response.ok) throw await responseError(response, "Dashboard load failed");
        const body = (await response.json()) as DashboardSnapshot;
        if (active) setSnapshot(body);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : "Dashboard load failed.");
      }
    }
    void loadInitialSnapshot();
    return () => {
      active = false;
    };
  }, []);

  if (snapshot) return <DashboardApp initialSnapshot={snapshot} />;
  return <DashboardSsrShell message={loadError ?? undefined} detail={loadError ? "Refresh the page after checking the preview server." : undefined} />;
}

function DashboardSsrShell({ snapshot, message, detail }: { snapshot?: DashboardSnapshot | null; message?: string; detail?: string }) {
  const executionState = snapshot ? executionStateFor(snapshot) : undefined;
  const mode = executionState ? `${executionState.label} Mode` : undefined;
  const state = snapshot ? (snapshot.policy.accountNumber ? snapshot.policy.systemState : "setup needed") : "starting";
  const hasError = Boolean(message);
  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header className="flex min-h-16 shrink-0 flex-col gap-3 border-b border-line bg-surface/70 px-4 py-3 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Zap size={16} className="fill-current" />
          </span>
          <div>
            <div className="text-sm font-semibold">Socratic Trade</div>
            {(mode || snapshot) && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                {mode && <span>{mode}</span>}
                {snapshot && <span>{labelize(state)}</span>}
              </div>
            )}
          </div>
        </div>
      </header>
      <main
        className={cn("flex flex-1 p-4 sm:p-6", hasError ? "items-center justify-center" : "items-start")}
        role={hasError ? "alert" : "status"}
        aria-live={hasError ? "assertive" : "polite"}
        aria-busy={!hasError}
        aria-atomic="true"
      >
        {hasError ? (
          <div className="w-full max-w-md rounded-lg border border-line bg-surface/80 px-4 py-3 text-sm text-muted shadow-[var(--shadow)] backdrop-blur-md">
            <p className="font-medium text-fg">{message}</p>
            {detail && <p className="mt-1 text-xs text-faint">{detail}</p>}
          </div>
        ) : (
          <div className="w-full pt-[18dvh] sm:pt-[22dvh]">
            <span className="sr-only">Preparing dashboard.</span>
            <div aria-hidden="true" className="mx-auto w-full max-w-3xl">
              <div className="relative h-1 overflow-hidden rounded-full bg-line shadow-[0_0_0_1px_var(--line)]">
                <span className="boot-strip-glow absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />
              </div>
              <div className="mt-2 grid grid-cols-6 gap-1.5 sm:grid-cols-12">
                {Array.from({ length: 12 }).map((_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-px rounded-full bg-line-strong",
                      index % 3 === 0 && "bg-accent/45",
                      index > 5 && "hidden sm:block"
                    )}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// Symbols the user SENT (watchlist + ignore list) that the server dropped as malformed legacy entries,
// so we can warn explicitly instead of silently losing them. Newly added unsupported custom symbols now
// fail the save with a specific server message before reaching this diff.
function droppedUnsupportedSymbols(sent: TradingPolicy, saved: TradingPolicy): string[] {
  const up = (list: string[] | undefined): string[] => (list ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const savedSet = new Set([...up(saved.additionalSymbols), ...up(saved.blocklist)]);
  const sentAll = [...up(sent.additionalSymbols), ...up(sent.blocklist)];
  return Array.from(new Set(sentAll.filter((s) => !savedSet.has(s))));
}

// ── Shared market-data pool consent gate ─────────────────────────────────

type ConsentGateState = "loading" | "needed" | "done";

function ConsentGate({ onResolved }: { onResolved: () => void }) {
  const [submitting, setSubmitting] = useState(false);

  async function respond(accepted: boolean) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accepted })
      });
      if (!response.ok) throw new Error("Consent could not be saved.");
      onResolved();
    } catch {
      toast.error("Consent could not be saved. The dashboard will stay locked until this is resolved.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      aria-describedby="consent-body"
      className="fixed inset-0 z-[2000] flex items-center justify-center p-4"
    >
      {/* Opaque backdrop — blocks all interaction beneath */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-scrim" />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)] p-6 flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Network size={20} />
          </span>
          <div>
            <h2 id="consent-title" className="text-base font-semibold text-fg">
              Shared market-data pool
            </h2>
            <p className="mt-0.5 text-xs text-muted">Can be changed later in Settings</p>
          </div>
        </div>

        {/* Body */}
        <div id="consent-body" className="space-y-3 text-sm leading-relaxed text-muted">
          <p>
            When enabled, general market data you pull through your own API keys or broker MCP —
            quotes, fundamentals, price history, and news — is contributed to a shared cache
            that other consenting users can read. In return, you read data others have contributed,
            reducing API spend and enriching everyone&apos;s market view.
          </p>
          <p>
            <strong className="font-semibold text-fg">Your personal account data is never shared.</strong>{" "}
            Positions, orders, balances, P&amp;L, and credentials remain private to your account;
            credentials stay encrypted and server-only.
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(false)}
            className="min-h-11 rounded-lg border border-line bg-surface px-4 text-sm font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50 sm:h-9 sm:min-h-0"
          >
            Decline
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(true)}
            className="min-h-11 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 disabled:opacity-50 sm:h-9 sm:min-h-0"
          >
            {submitting ? "Saving…" : "Agree & Continue"}
          </button>
        </div>

        {/* Muted reassurance */}
        <p className="text-[11px] text-faint text-center">
          You can enable or disable pooling at any time under Settings → Data.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function DashboardApp({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(readStoredWorkspaceTab);
  const [feedTab, setFeedTab] = useState<FeedTab>(readStoredFeedTab);
  const [feedOpen, setFeedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>("operate");
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [learnedQueueOpen, setLearnedQueueOpen] = useState(false);
  const [learnedQueueCount, setLearnedQueueCount] = useState(0);

  // Consent gate: "loading" → fetch in progress; "needed" → show modal; "done" → clear
  const [consentGate, setConsentGate] = useState<ConsentGateState>("loading");
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/consent")
      .then((r) => (r.ok ? (r.json() as Promise<{ needsConsent: boolean }>) : null))
      .then((data) => {
        if (cancelled) return;
        setConsentGate(data?.needsConsent === true ? "needed" : "done");
      })
      .catch(() => {
        if (!cancelled) setConsentGate("needed");
      });
    return () => { cancelled = true; };
  }, []);

  const [killConfirm, setKillConfirm] = useState(false);
  const [decideConfirm, setDecideConfirm] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [liveConfirmation, setLiveConfirmation] = useState<{
    proposalId: string;
    symbol: string;
    side: string;
    quantity?: number;
    dollarAmount?: number;
    price?: number;
    estimatedNotional?: number;
    accountNumber?: string;
  } | null>(null);
  const [replaceMarketOrder, setReplaceMarketOrder] = useState<MarketReplaceCandidate | null>(null);
  const [replaceMarketText, setReplaceMarketText] = useState("");
  const [drilldownSymbol, setDrilldownSymbol] = useState<MarketQuote | null>(null);
  // A live market scan used solely to resolve a symbol → full quote when a ticker is
  // clicked anywhere outside Market Scan. The persisted `latestStrategyRun.marketScan`
  // isn't rehydrated after a restart, so we fetch the current scan (same source the
  // Market Scan tab uses) once on mount and keep it for drilldown lookups.
  const [tickerScan, setTickerScan] = useState<MarketScan | null>(null);
  const [tickerLogoDisplay, setTickerLogoDisplay] = useState<TickerLogoDisplay>(DEFAULT_TICKER_LOGO_DISPLAY);
  const [compactExecutionBanner, setCompactExecutionBanner] = useState(false);
  const [executionBannerHidden, setExecutionBannerHidden] = useState(false);
  const [hideTestAccount, setHideTestAccount] = useState(false);

  const headerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!headerRef.current) return;
    const updateHeight = () => {
      if (headerRef.current) {
        const rect = headerRef.current.getBoundingClientRect();
        document.documentElement.style.setProperty("--header-height", `${rect.height}px`);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MarketScan | null) => {
        if (!cancelled && data && Array.isArray(data.topCandidates)) setTickerScan(data);
      })
      .catch(() => {
        /* ticker drilldown is a nice-to-have; ignore scan fetch failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TICKER_LOGO_DISPLAY_KEY);
      if (isTickerLogoDisplay(saved)) setTickerLogoDisplay(saved);
      const bannerMode = localStorage.getItem(EXECUTION_BANNER_MODE_KEY);
      if (bannerMode === "full" || bannerMode === "compact" || bannerMode === "hidden") {
        setCompactExecutionBanner(bannerMode === "compact");
        setExecutionBannerHidden(bannerMode === "hidden");
      } else {
        // Migrate legacy prefs: BOTH the legacy compact key AND the legacy "hidden" key map to compact
        // (the old build kept the safety banner visible in both cases), so upgrading users never lose
        // the Test/Paper/Brokerage banner until they explicitly pick the new Hidden option.
        const legacyCompact =
          localStorage.getItem(EXECUTION_BANNER_COMPACT_KEY) === "true" ||
          localStorage.getItem(LEGACY_EXECUTION_BANNER_HIDDEN_KEY) === "true";
        setCompactExecutionBanner(legacyCompact);
        setExecutionBannerHidden(false);
      }
      setHideTestAccount(localStorage.getItem(HIDE_TEST_ACCOUNT_KEY) === "true");
    } catch {
      /* ignore storage failures */
    }
  }, []);

  function updateTickerLogoDisplay(next: TickerLogoDisplay) {
    setTickerLogoDisplay(next);
    try {
      localStorage.setItem(TICKER_LOGO_DISPLAY_KEY, next);
    } catch {
      /* ignore storage failures */
    }
  }

  const executionBannerMode: ExecutionBannerMode = executionBannerHidden
    ? "hidden"
    : compactExecutionBanner
      ? "compact"
      : "full";
  function updateExecutionBannerMode(next: ExecutionBannerMode) {
    const hidden = next === "hidden";
    const compact = next === "compact";
    setExecutionBannerHidden(hidden);
    setCompactExecutionBanner(compact);
    try {
      // Persist to the new mode key only; keep the legacy compact key in sync for backward-compat
      // and clear the legacy hidden key so it can never be misread as the new Hidden state.
      localStorage.setItem(EXECUTION_BANNER_MODE_KEY, next);
      localStorage.setItem(EXECUTION_BANNER_COMPACT_KEY, String(compact));
      localStorage.removeItem(LEGACY_EXECUTION_BANNER_HIDDEN_KEY);
    } catch {
      /* ignore storage failures */
    }
  }

  function updateHideTestAccount(next: boolean) {
    setHideTestAccount(next);
    try {
      localStorage.setItem(HIDE_TEST_ACCOUNT_KEY, String(next));
    } catch {
      /* ignore storage failures */
    }
  }

  const [newProfileName, setNewProfileName] = useState("");
  const [strategyTuning, setStrategyTuning] = useState<StrategyTuningProposal | null>(() => readStoredStrategyTuning());
  const [tuningBusy, setTuningBusy] = useState(false);
  const [tuningError, setTuningError] = useState("");
  const promptSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // NAV_V2 PR #2: one-time, flag-INDEPENDENT migration of the legacy tab keys to
  // the new destination keys. Additive (legacy keys are left intact so a flag-off
  // render path still finds them) and idempotent (no-op once the new keys exist),
  // so it is safe to run on every mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    migrateNavKeysToDestinations(window.localStorage);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_TAB_KEY, workspaceTab);
    } catch {
      /* ignore storage failures */
    }
  }, [workspaceTab]);

  useEffect(() => {
    try {
      localStorage.setItem(FEED_TAB_KEY, feedTab);
    } catch {
      /* ignore storage failures */
    }
  }, [feedTab]);

  useEffect(() => {
    try {
      if (strategyTuning) {
        localStorage.setItem(STRATEGY_TUNING_STORAGE_KEY, JSON.stringify(strategyTuning));
      } else {
        localStorage.removeItem(STRATEGY_TUNING_STORAGE_KEY);
      }
    } catch {
      /* ignore storage failures */
    }
  }, [strategyTuning]);

  // Fallback poll — now a safety net (2 min) behind the SSE live-push below, not the primary
  // refresh path. Covers missed events, SSE-unsupported browsers, and dropped streams.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load({ quiet: true });
    }, 120_000);
    return () => clearInterval(interval);
  }, []);

  // Live push: refresh immediately when the server emits a dashboard event (strategy run
  // complete, order placed, etc.) via Server-Sent Events — replacing the old 30s blind poll.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const es = new EventSource("/api/events/stream");
    const refresh = () => {
      if (document.visibilityState === "visible") void load({ quiet: true });
    };
    const refreshMarketData = (event: MessageEvent) => {
      window.dispatchEvent(new CustomEvent("market-data-filled", { detail: safeJson(event.data) }));
      refresh();
    };
    for (const type of ["run-complete", "order", "proposal", "dirty"]) es.addEventListener(type, refresh);
    es.addEventListener("market-data", refreshMarketData);
    // Refresh the pending-learned badge when a new pending item is queued server-side
    es.addEventListener("pending-learned-change", () => {
      void fetch("/api/learned-context/pending", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Array<{ status: string }>>) : []))
        .then((data) => { setLearnedQueueCount(data.filter((i) => i.status === "pending").length); })
        .catch(() => { /* badge stays as-is on error */ });
    });
    es.onerror = () => {
      // The browser auto-reconnects EventSource; the fallback poll covers any gap.
    };
    return () => es.close();
  }, []);

  // Seed the learned-context queue badge count on mount so the button is visible immediately
  // if there are pending items, without waiting for the user to open the SlideOver.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/learned-context/pending", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ status: string }>>) : []))
      .then((data) => {
        if (!cancelled) setLearnedQueueCount(data.filter((i) => i.status === "pending").length);
      })
      .catch(() => { /* badge stays at 0 on error */ });
    return () => { cancelled = true; };
  }, []);

  // ⌘K / Ctrl-K command palette
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  async function load(options: { quiet?: boolean } = {}) {
    if (!options.quiet) setBusy(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw await responseError(response, "Dashboard refresh failed");
      setSnapshot((await response.json()) as DashboardSnapshot);
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Dashboard refresh failed.");
    } finally {
      if (!options.quiet) setBusy(false);
    }
  }

  function openSettings(section: SettingsSection = "operate") {
    setSettingsInitialSection(section);
    setSettingsOpen(true);
  }

  async function updatePolicy(patch: PolicyPatch) {
    setBusy(true);
    try {
      const response = await fetch("/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Serialize `undefined` as `null` so CLEARING an optional field reaches the server (JSON.stringify
        // would otherwise drop the key, and the server's `...current` merge would restore the old value —
        // making "blank = off" silently fail). The route strips these nulls back to absent (clears the field).
        body: JSON.stringify({ ...snapshot.policy, ...patch }, (_key, value) => (value === undefined ? null : value))
      });
      if (!response.ok) {
        throw await responseError(response, "Policy update failed");
      }
      // The server drops malformed legacy symbols from the watchlist / ignore list. Detect any that were
      // removed and warn explicitly, so nothing is ever thought to be watched when it isn't.
      const saved = (await response.json().catch(() => null)) as TradingPolicy | null;
      const dropped = saved ? droppedUnsupportedSymbols({ ...snapshot.policy, ...patch }, saved) : [];
      if (dropped.length > 0) {
        toast.warning(`Removed unsupported symbol${dropped.length > 1 ? "s" : ""}: ${dropped.join(", ")}`, {
          description: "These entries are not valid ticker formats, so they were not kept on the list."
        });
      } else {
        toast.success("Policy updated.");
      }
      await load({ quiet: true });
    } catch (policyError) {
      toast.error(policyError instanceof Error ? policyError.message : "Policy update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveStrategyPrompt(prompt: string) {
    await updatePolicy({ strategyPrompt: prompt });
  }

  function editStrategyPrompt(value: string) {
    setSnapshot((current) => ({ ...current, strategyPrompt: value }));
    if (promptSaveTimer.current) clearTimeout(promptSaveTimer.current);
    promptSaveTimer.current = setTimeout(() => saveStrategyPrompt(value), 800);
  }

  async function runStrategy() {
    setBusy(true);
    try {
      const response = await fetch("/api/strategy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manual: true })
      });
      if (!response.ok) throw await responseError(response, "Strategy run failed");
      const body = (await response.json()) as { summary?: string };
      toast.success(body.summary ?? "Strategy run completed.");
      await load({ quiet: true });
    } catch (runError) {
      toast.error(runError instanceof Error ? runError.message : "Strategy run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approveProposal(proposalId: string) {
    if (isProposalActionStopped(snapshot.policy)) {
      showStoppedProposalActionToast();
      return;
    }
    const pending = snapshot.pendingProposals.find((proposal) => proposal.id === proposalId);
    if (executionState.mode === "broker/live") {
      if (!pending) {
        toast.error("Live approval is unavailable because the proposal snapshot is stale. Refresh and try again.");
        return;
      }
      // Show the in-app confirmation modal instead of window.prompt()
      setLiveConfirmation({
        proposalId,
        symbol: pending.proposal.symbol,
        side: pending.proposal.side,
        quantity: pending.proposal.quantity,
        dollarAmount: pending.proposal.dollarAmount,
        price: pending.proposal.limitPrice ?? pending.proposal.referencePrice,
        estimatedNotional: pending.estimatedNotional ?? pending.review?.estimatedNotional,
        accountNumber: pending.accountNumber || snapshot.policy.accountNumber
      });
      return; // The modal flow takes over from here
    }
    await submitProposalApproval(proposalId, {});
  }

  /** Submit a proposal approval request, optionally with live-confirmation payload. */
  async function submitProposalApproval(proposalId: string, liveConfirmationPayload: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${proposalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: liveConfirmationPayload && Object.keys(liveConfirmationPayload).length > 0
          ? JSON.stringify({ liveConfirmation: liveConfirmationPayload })
          : JSON.stringify({})
      });
      if (!response.ok) throw await responseError(response, "Proposal approval failed");
      const body = (await response.json()) as { status: string; orderId?: string; brokerState?: string; fillStatus?: string; reasons?: string[] };
      if (body.status === "blocked") {
        const reasonsMsg = body.reasons?.map((r) => `• ${r}`).join("\n") ?? "No reasons provided.";
        toast.warning("Proposal blocked by policy", { description: reasonsMsg });
      } else if (body.status === "error" || body.status === "placing_failed") {
        const reasonsMsg = body.reasons?.filter(Boolean).join("\n") || "The broker did not confirm the order.";
        toast.error("Order placement failed", { description: reasonsMsg });
      } else {
        if (body.status === "placed" && body.fillStatus === "pending_reconciliation") {
          toast.info("Order accepted by broker and pending execution.", {
            description: [
              body.brokerState ? `Broker state: ${readableOrderState(body.brokerState)}.` : undefined,
              body.orderId ? `Order ${body.orderId}.` : undefined,
              "The Activity feed will update when the broker reports filled, rejected, canceled, or expired."
            ].filter(Boolean).join(" ")
          });
        } else {
          toast.success(
            body.status === "placed"
              ? `Order submitted${body.orderId ? `: ${body.orderId}` : ""}.`
              : `Result: ${body.status}`
          );
        }
      }
      await load({ quiet: true });
    } catch (approvalError) {
      const errMsg = approvalError instanceof Error ? approvalError.message : "Proposal approval failed.";
      toast.error("Execution error", { description: errMsg });
    } finally {
      setBusy(false);
    }
  }

  /** Called by the ConfirmationModal when the user has typed the confirmation phrase and clicks Confirm. */
  function handleLiveConfirm() {
    const pending = liveConfirmation;
    if (!pending) return;
    setLiveConfirmation(null);
    const confirmationPayload = {
      proposalId: pending.proposalId,
      accountNumber: pending.accountNumber,
      executionMode: executionState.mode,
      estimatedNotional: pending.estimatedNotional,
      typedText: `APPROVE LIVE ${pending.symbol.trim().toUpperCase()}`
    };
    void submitProposalApproval(pending.proposalId, confirmationPayload);
  }

  async function submitMarketReplace() {
    const pending = replaceMarketOrder;
    if (!pending) return;
    const live = executionState.mode === "broker/live";
    const expectedText = marketReplaceText(pending.order.symbol);
    if (live && replaceMarketText.trim().toUpperCase() !== expectedText) {
      toast.error("Typed confirmation does not match.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/orders/replace-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: pending.order.id,
          liveConfirmation: live
            ? {
                orderId: pending.order.id,
                accountNumber: snapshot.policy.accountNumber,
                executionMode: executionState.mode,
                remainingQuantity: pending.remainingQuantity,
                typedText: replaceMarketText
              }
            : undefined
        })
      });
      if (!response.ok) throw await responseError(response, "Market replacement failed");
      const body = (await response.json()) as { status: string; replacementOrderId?: string; brokerState?: string; remainingQuantity?: number };
      setReplaceMarketOrder(null);
      setReplaceMarketText("");
      if (body.status === "already_filled") {
        toast.info("Original order already filled; no market replacement was placed.");
      } else {
        toast.success("Market replacement submitted.", {
          description: [
            body.replacementOrderId ? `Order ${body.replacementOrderId}.` : undefined,
            body.brokerState ? `Broker state: ${readableOrderState(body.brokerState)}.` : undefined
          ].filter(Boolean).join(" ")
        });
      }
      await load({ quiet: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Market replacement failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rejectProposal(proposalId: string) {
    if (isProposalActionStopped(snapshot.policy)) {
      showStoppedProposalActionToast();
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${proposalId}/reject`, { method: "POST" });
      if (!response.ok) throw await responseError(response, "Proposal rejection failed");
      toast.info("Proposal rejected.");
      await load({ quiet: true });
    } catch (rejectError) {
      toast.error(rejectError instanceof Error ? rejectError.message : "Proposal rejection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function activateProfile(profileId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/profiles/${profileId}/activate`, { method: "POST" });
      if (!response.ok) throw await responseError(response, "Profile activation failed");
      toast.success("Profile activated.");
      await load({ quiet: true });
    } catch (profileError) {
      toast.error(profileError instanceof Error ? profileError.message : "Profile activation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createProfile() {
    const name = newProfileName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const response = await fetch("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, policy: snapshot.policy, prompt: snapshot.strategyPrompt, active: true })
      });
      if (!response.ok) throw await responseError(response, "Profile creation failed");
      toast.success("Profile created.");
      setNewProfileName("");
      await load({ quiet: true });
    } catch (profileError) {
      toast.error(profileError instanceof Error ? profileError.message : "Profile creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyProfileToAccount(profileId: string, connectedAccountId: string) {
    if (!profileId || !connectedAccountId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/profiles/${profileId}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectedAccountId })
      });
      if (!response.ok) throw await responseError(response, "Copy to account failed");
      toast.success("Strategy copied to account.");
      await load({ quiet: true });
    } catch (copyError) {
      toast.error(copyError instanceof Error ? copyError.message : "Copy to account failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestStrategyTuning(tuningModel?: string) {
    setTuningBusy(true);
    setTuningError("");
    try {
      const response = await fetch("/api/strategy/tune", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: tuningModel || undefined })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(plainAppError(typeof body?.error === "string" ? body.error : JSON.stringify(body), "Strategy tuning review failed."));
      setStrategyTuning(body as StrategyTuningProposal);
    } catch (tuneError) {
      setTuningError(tuneError instanceof Error ? tuneError.message : "Strategy tuning review failed.");
    } finally {
      setTuningBusy(false);
    }
  }

  async function applyStrategyTuning() {
    if (!strategyTuning) return;
    const patch = strategyTuning.proposedPatch;
    await updatePolicy({
      ...(patch.policy ?? {}),
      ...(patch.scoringWeights ? { scoringWeights: { ...policy.scoringWeights, ...patch.scoringWeights } } : {}),
      ...(patch.policy?.riskRules ? { riskRules: { ...policy.riskRules, ...patch.policy.riskRules } } : {}),
      ...(patch.prompt ? { strategyPrompt: patch.prompt } : {})
    });
    toast.success("Strategy tuning changes applied.");
  }

  function discardStrategyTuning() {
    setStrategyTuning(null);
    setTuningError("");
    toast.info("Strategy review discarded.");
  }

  const policy = snapshot.policy;
  const dailyStats = snapshot.dailyStats ?? { orderCount: 0, openingOrderCount: 0, notional: 0 };
  const remainingNotional = Math.max(0, (policy.maxDailyNotional ?? 0) - dailyStats.notional);
  const remainingOrders = Math.max(0, policy.maxDailyOrders - (dailyStats.openingOrderCount ?? dailyStats.orderCount));
  const accountReadiness = snapshot.accountReadiness;
  const accountBlockedReason = accountReadiness
    ? (accountReadiness.ok ? undefined : accountReadiness.reason ?? accountReadiness.detail)
    : (!policy.accountNumber ? "Select an account before enabling autonomy." : undefined);
  const enableBlockedReason = accountBlockedReason ?? (
    policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0
      ? "Select at least one base index or additional watchlist symbol before enabling autonomy."
      : undefined
  );
  // A strategy session is LLM-driven. When NO LLM provider has a resolvable credential for this user
  // (own key OR operator failover; see userHasAnyLlmCredential), "Run once" is gated with an actionable
  // message — matching the /api/strategy/run 412 — rather than firing a run that only errors deep inside.
  // The flag is optional on older payloads; treat a missing value as configured so we never false-block.
  const llmGateReason = snapshot.llmConfigured === false ? "Connect an LLM provider in Settings to run a strategy session." : undefined;
  // "Run once" requires BOTH setup (account + universe) AND a resolvable LLM credential — either
  // missing should disable the button with its own actionable message, so the run never fires only to
  // hit the /api/strategy/run 412. Setup is the more fundamental blocker, so it takes precedence in copy.
  const runOnceBlockedReason = enableBlockedReason ?? llmGateReason;
  const allowedUniverse = policyUniverseSymbolCount(policy);
  const allowedCount = allowedUniverse.count;
  
  const isDefault = policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0;
  const selectedIndexLabels = policy.includedIndices
    .map((index) => INDEX_UNIVERSES[index]?.label)
    .filter((label): label is string => Boolean(label));
  const isOnlyOneIndex = selectedIndexLabels.length === 1 && policy.additionalSymbols.length === 0 && (policy.blocklist || []).length === 0;
  const universeLabelText = isDefault ? "TBD" : isOnlyOneIndex ? selectedIndexLabels[0] ?? "Custom" : "Custom";
  const executionState = executionStateFor(snapshot);
  const activeAccountId = executionState.accountId ?? policy.connectedAccountId ?? "";
  const selectorAccounts = visibleConnectedAccounts(snapshot.connectedAccounts, hideTestAccount, activeAccountId);
  const mode = executionState.mode === "broker/live" ? "live" : "paper";
  const accountModeLabel = executionState.label;
  const signedInEmail = snapshot.currentUser?.email;
  const isAdmin = snapshot.currentUser?.isAdmin ?? false;
  const symbolMetaBySymbol = snapshot.symbolMetaBySymbol ?? {};
  // Best available scan for resolving clicked tickers → full quotes: the freshly
  // fetched live scan, falling back to the captured run's scan if it's still loading.
  const drilldownScan = tickerScan ?? snapshot.latestStrategyRun?.marketScan ?? null;
  const dailyNotionalPct = (policy.maxDailyNotional ?? 0) > 0 ? Math.round((dailyStats.notional / (policy.maxDailyNotional ?? 1)) * 100) : 0;
  const pendingCount = snapshot.pendingProposals.length;
  const setupBlocked = Boolean(enableBlockedReason);
  // The chip reflects the RUN state (Start/Stop), not the approval mode. "Stopped" until you press
  // Start; once running it also names the mode so choosing Autonomous is visibly reflected
  // ("Running · Autonomous" vs "Running · Propose"). Choosing a mode alone never starts the system.
  const autonomyStatus = policy.systemState === "active"
    ? setupBlocked
      ? { tone: "warn" as const, label: "Setup Needed" }
      : { tone: "up" as const, label: policy.strategyAuthority === "decide" ? "Running · Autonomous Mode" : "Running · Propose Mode" }
    : policy.systemState === "halted"
      ? { tone: "down" as const, label: "Stopped" }
      : policy.systemState === "close_only"
        ? { tone: "warn" as const, label: "Close-Only" }
        : { tone: "down" as const, label: "Liquidating" };
  const marketStatus = marketStatusFor(snapshot.marketSession);

  function routeSetupBlocker(reason: string) {
    const accountIsBlocked = accountReadiness ? !accountReadiness.ok : (!policy.accountNumber && !policy.connectedAccountId);
    toast.warning(reason, {
      description: accountIsBlocked
        ? "Open Accounts to connect or select a supported account."
        : "Open Settings to choose a tradable universe."
    });
    if (accountIsBlocked) setAccountsOpen(true);
    else openSettings("operate");
  }

  async function activateAccount(id: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/connected-accounts/${id}/activate`, { method: "POST" });
      if (!response.ok) throw await responseError(response, "Account switch failed");
      await load({ quiet: true });
    } catch (switchError) {
      toast.error(switchError instanceof Error ? switchError.message : "Account switch failed.");
    } finally {
      setBusy(false);
    }
  }

  function requestAutonomy(nextActive: boolean) {
    if (nextActive && enableBlockedReason) {
      routeSetupBlocker(enableBlockedReason);
      return;
    }
    void updatePolicy({ systemState: nextActive ? "active" : "halted" });
  }

  const riskCapsReady =
    (policy.maxDailyNotional ?? 0) > 0 &&
    (policy.maxOrderNotional ?? 0) > 0 &&
    (policy.maxDailyOrders ?? 0) > 0;
  const readinessItems: ReadinessItem[] = [
    {
      label: "Account",
      ok: accountReadiness?.ok ?? Boolean(policy.accountNumber),
      detail: accountReadiness?.detail ?? (policy.accountNumber ? `Selected account ${policy.accountNumber}.` : "No account is selected."),
      actionLabel: "Accounts",
      onAction: () => setAccountsOpen(true)
    },
    {
      label: "Universe",
      ok: allowedCount > 0,
      detail: allowedCount > 0 ? `${allowedUniverse.approximate ? "About " : ""}${allowedCount} symbols are allowed.` : "No base index or additional watchlist symbol is selected.",
      actionLabel: "Settings",
      onAction: () => openSettings("operate")
    },
    {
      label: "Risk Caps",
      ok: riskCapsReady,
      detail: riskCapsReady ? "Daily, order, and count caps are configured." : "Daily notional, order notional, and order-count caps must be positive.",
      actionLabel: "Settings",
      onAction: () => openSettings("operate")
    },
    ...(policy.activeBroker === "robinhood" && !snapshot.robinhoodMcpConnected ? [{
      label: "Robinhood",
      ok: false,
      detail: "Robinhood MCP session not connected — reconnect your account in Connections.",
      actionLabel: "Connections",
      onAction: () => setAccountsOpen(true)
    }] : [])
  ];

  const safetyBanner = executionBanner(executionState);

  const paletteCommands: Command[] = [
    { id: "tab-decision", label: "Go to Decision", hint: "Decision tab", icon: <LayoutDashboard size={16} />, run: () => setWorkspaceTab("decision") },
    { id: "tab-assistant", label: "Go to Assistant", hint: "Assistant tab", icon: <BrainCircuit size={16} />, run: () => setWorkspaceTab("assistant") },
    { id: "tab-market", label: "Go to Market Scan", hint: "Market tab", icon: <LineChartIcon size={16} />, run: () => setWorkspaceTab("market") },
    { id: "tab-macro", label: "Go to Macro", hint: "Macro tab", icon: <Network size={16} />, run: () => setWorkspaceTab("macro") },
    { id: "tab-performance", label: "Go to Performance", hint: "Performance tab", icon: <TrendingUp size={16} />, run: () => setWorkspaceTab("performance") },
    { id: "tab-strategy", label: "Go to Strategy", hint: "Strategy tab", icon: <Sparkles size={16} />, run: () => setWorkspaceTab("strategy") },
    { id: "open-activity", label: "Open Activity feed", icon: <ActivityIcon size={16} />, run: () => setFeedOpen(true) },
    { id: "open-settings", label: "Open Settings", icon: <SettingsIcon size={16} />, run: () => openSettings("operate") },
    { id: "open-accounts", label: "Open Accounts", icon: <Wallet size={16} />, run: () => setAccountsOpen(true) },
    { id: "open-flow", label: "Open Strategy Flow", icon: <Network size={16} />, run: () => setNodeEditorOpen(true) },
    { id: "open-strategy-studio", label: "Open Strategy Studio", icon: <BrainCircuit size={16} />, run: () => setStudioOpen(true) },
    { id: "open-help", label: "Open Help", icon: <HelpCircle size={16} />, run: () => setHelpOpen(true) },
    { id: "run-strategy", label: "Run strategy once", icon: <Zap size={16} />, run: () => { if (!runOnceBlockedReason) void runStrategy(); else routeSetupBlocker(runOnceBlockedReason); } },
    { id: "sign-out", label: "Sign out", hint: signedInEmail ?? "Current session", icon: <LogOut size={16} />, run: () => { window.location.href = "/logout"; } },
  ];

  return (
    <div className="flex min-h-dvh flex-col overflow-x-hidden lg:h-dvh lg:overflow-hidden">
      {/* ── ⌘K Command Palette ──────────────────────────────────────── */}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} commands={paletteCommands} />
      {/* ── Shared market-data pool consent gate (blocking until answered) ── */}
      {consentGate === "needed" && (
        <ConsentGate onResolved={() => setConsentGate("done")} />
      )}
      {/* Sticky top container for Safety Banner and Header/Command Bar */}
      <div
        ref={headerRef}
        className="sticky top-0 z-[1100] flex shrink-0 flex-col"
      >
        {!executionBannerHidden && (
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "shrink-0 border-b text-center font-semibold tracking-wide",
              compactExecutionBanner ? "px-3 py-1 text-[10px]" : "px-4 py-1.5 text-[11px]",
              safetyBanner.className
            )}
            title={safetyBanner.title}
          >
            {safetyBanner.content}
          </div>
        )}
        {/* ── Command bar ─────────────────────────────────────────── */}
        <header className="relative z-10 flex min-h-16 shrink-0 flex-col gap-2 border-b border-line bg-surface/70 px-3 py-2 backdrop-blur-md sm:px-4 sm:py-3 lg:flex-row lg:items-center lg:justify-between lg:h-16 lg:gap-3 lg:py-0 lg:px-4">
        {/* Left Side: Logo, Title, Status, and Pills */}
        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-2 w-full lg:w-auto lg:justify-start lg:gap-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Zap size={16} className="fill-current" />
            </span>
            <div className="leading-tight">
              <div className="whitespace-nowrap text-sm font-semibold text-fg">Socratic Trade</div>
              <div className="mt-0.5 space-y-0.5 text-[11px] text-muted">
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <Dot tone={autonomyStatus.tone} pulse={policy.systemState === "active"} />
                  {autonomyStatus.label}
                </div>
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <Dot tone={marketStatus.tone} />
                  {marketStatus.label}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <StatusPill label="Universe" value={universeLabelText} title="The set of symbols the agent is allowed to trade (Settings → Operate)." />
            <DailyRiskPill pct={dailyNotionalPct} used={dailyStats.notional} cap={policy.maxDailyNotional ?? 0} />
          </div>
        </div>

        {/* Right Side: Selects, Utilities, Actions */}
        <div className="flex flex-col gap-1.5 w-full sm:gap-2 lg:flex-row lg:items-center lg:justify-end lg:w-auto lg:flex-nowrap lg:gap-3">
          {/* Sub-container 1: Selects and Utility tools */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 flex-nowrap justify-end w-full lg:w-auto">
            <div
              className="hidden h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface/50 px-2 py-0.5 backdrop-blur-xl md:flex lg:h-9 lg:px-2.5 lg:py-1"
              title="Approval mode — Propose: the agent proposes and you approve each order. Autonomous: while the system is running, the agent executes orders automatically. Either way, nothing trades until you press Start."
            >
              <span className="text-xs font-medium text-muted lg:text-sm">Mode:</span>
              <select
                aria-label="Approval mode"
                className="min-w-[9.5rem] bg-transparent text-xs font-medium text-fg outline-none lg:min-w-[11rem] lg:text-sm"
                value={policy.strategyAuthority}
                onChange={(e) => {
                  const next = e.target.value as TradingPolicy["strategyAuthority"];
                  if (next === "decide" && policy.strategyAuthority !== "decide") {
                    setDecideConfirm(true);
                  } else {
                    void updatePolicy({ strategyAuthority: next });
                  }
                }}
              >
                <option value="propose">Propose Mode</option>
                <option value="decide">Autonomous Mode</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5 lg:gap-2">
              <select
                aria-label="Active account"
                className="h-8 max-w-[8rem] rounded-lg border border-line bg-surface/50 px-2 text-xs font-medium text-fg outline-none backdrop-blur-xl focus:border-accent sm:max-w-[12rem] lg:h-9 lg:max-w-[14rem] lg:px-2.5 lg:text-sm"
                value={activeAccountId}
                onChange={async (e) => {
                  const id = e.target.value;
                  if (id === "manage") {
                    setAccountsOpen(true);
                    return;
                  }
                  await activateAccount(id);
                }}
              >
                <option value="" disabled>Select Account...</option>
                {(() => {
                  const accts = selectorAccounts;
                  // Append the environment only when two accounts would otherwise render the same option
                  // text — disambiguating identical labels (e.g. two "Alpaca") so a live account is never
                  // mistaken for paper in this real-money switcher, while distinct labels stay uncluttered.
                  const labelCounts = new Map<string, number>();
                  for (const a of accts) labelCounts.set(a.label, (labelCounts.get(a.label) ?? 0) + 1);
                  return accts.map(acc => {
                    const ambiguous = (labelCounts.get(acc.label) ?? 0) > 1 && acc.broker !== "test"
                      && !acc.label.toLowerCase().includes(acc.environment.toLowerCase());
                    return <option key={acc.id} value={acc.id}>{ambiguous ? `${acc.label} (${acc.environment})` : acc.label}</option>;
                  });
                })()}
                <option value="manage" className="italic">Manage Accounts...</option>
              </select>
            </div>
            <AccountMenu
              user={snapshot.currentUser}
              pendingCount={pendingCount}
              onOpenActivity={() => setFeedOpen(true)}
              onOpenSettings={() => openSettings("operate")}
              onOpenAccounts={() => setAccountsOpen(true)}
              onOpenHelp={() => setHelpOpen(true)}
              onSignOut={() => { window.location.href = "/logout"; }}
            />
          </div>

          {/* Sub-container 2: Action buttons */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0 flex-nowrap justify-end w-full lg:w-auto">
            {/* Discoverable entry point for the ⌘K command palette (in addition to the
                keyboard shortcut). Opens the same palette the keydown listener toggles. */}
            <button
              type="button"
              aria-label="Open command palette"
              aria-keyshortcuts="Meta+K Control+K"
              title="Open command palette (⌘K / Ctrl-K)"
              onClick={() => setCmdOpen(true)}
              className="inline-flex h-8 max-sm:min-h-11 touch-manipulation items-center gap-1.5 rounded-lg border border-line bg-surface/50 px-2 text-muted backdrop-blur-xl transition-colors hover:text-fg hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 lg:h-9 lg:px-2.5"
            >
              <Search size={ICON.sm} />
              <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-faint sm:inline">⌘K</kbd>
            </button>
            <LearnedContextQueueBadge
              count={learnedQueueCount}
              onClick={() => setLearnedQueueOpen(true)}
            />
            <Button
              variant={runOnceBlockedReason ? "ghost" : "primary"}
              className="h-8 px-2 text-xs max-sm:min-w-11 lg:h-9 lg:px-3 lg:text-[13px]"
              aria-label="Run strategy once"
              title={runOnceBlockedReason ?? "Run one manual proposal check. This works while stopped and routes results to approval; scheduled/autonomous runs still require Start."}
              onClick={() => {
                if (runOnceBlockedReason) {
                  routeSetupBlocker(runOnceBlockedReason);
                  return;
                }
                void runStrategy();
              }}
              disabled={busy}
            >
              <Zap size={16} /> <span className="hidden sm:inline">Run once</span>
            </Button>
            <Button
              variant={policy.systemState === "halted" ? "primary" : "danger"}
              className="h-8 px-2 text-xs max-sm:min-w-11 lg:h-9 lg:px-3 lg:text-[13px]"
              aria-label={policy.systemState === "halted" ? "Start system" : "Stop system"}
              title={policy.systemState === "halted" ? "Start the system — only while running can orders be placed (per your approval mode)" : "Halts new activity in one click. Always safe — never sells anything you hold."}
              onClick={() => {
                if (policy.systemState === "halted" && enableBlockedReason) {
                  routeSetupBlocker(enableBlockedReason);
                  return;
                }
                setKillConfirm(true);
              }}
            >
              {policy.systemState === "halted" ? <Play size={15} /> : <X size={15} />}{" "}
              <span className="hidden sm:inline">{policy.systemState === "halted" ? "Start" : "STOP"}</span>
            </Button>
          </div>
        </div>
      </header>
      </div>

      {/* ── Body grid ───────────────────────────────────────────── */}
      <div className="grid flex-1 grid-cols-1 gap-3 p-3 lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 lg:block">
          <PortfolioRail snapshot={snapshot} mode={mode} modeLabel={accountModeLabel} symbolMetaBySymbol={symbolMetaBySymbol} scan={drilldownScan} onDrilldown={setDrilldownSymbol} tickerLogoDisplay={tickerLogoDisplay} />
        </aside>

        <main className="flex min-w-0 flex-col gap-3 lg:min-h-0">
          <div className="lg:hidden">
            <MobilePortfolioSummary snapshot={snapshot} mode={mode} modeLabel={accountModeLabel} />
          </div>
          <ReadinessStrip items={readinessItems} />
          <div className="scroll-fade-edge flex min-w-0 items-center justify-between overflow-x-auto">
            <WorkspaceTabsBar value={workspaceTab} onChange={setWorkspaceTab} />
            {workspaceTab === "decision" && pendingCount > 0 && (
              <Chip tone="warn">
                {pendingCount} pending approval{pendingCount === 1 ? "" : "s"}
              </Chip>
            )}
          </div>

          <div
            role="tabpanel"
            id={`tabpanel-${workspaceTab}`}
            aria-labelledby={`tab-${workspaceTab}`}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-visible lg:overflow-auto"
          >
            {workspaceTab === "decision" && (
              <DecisionView
                snapshot={snapshot}
                symbolMetaBySymbol={symbolMetaBySymbol}
                busy={busy}
                approve={approveProposal}
                reject={rejectProposal}
                scan={drilldownScan}
                onDrilldown={setDrilldownSymbol}
                tickerLogoDisplay={tickerLogoDisplay}
              />
            )}
            {workspaceTab === "assistant" && (
              <AssistantView executionState={executionStateFor(snapshot)} approveProposal={approveProposal} rejectProposal={rejectProposal} />
            )}
            {workspaceTab === "market" && (
              <div className="space-y-3">
                <MarketScanView
                  snapshot={snapshot}
                  onDrilldown={setDrilldownSymbol}
                  onConfigureUniverse={() => openSettings("operate")}
                  onConfigureScanSettings={() => openSettings("data")}
                  tickerLogoDisplay={tickerLogoDisplay}
                />
                <SmartMoneyView snapshot={snapshot} scan={drilldownScan} onDrilldown={setDrilldownSymbol} tickerLogoDisplay={tickerLogoDisplay} />
              </div>
            )}
            {workspaceTab === "macro" && <MacroBoardView snapshot={snapshot} scan={drilldownScan} onDrilldown={setDrilldownSymbol} tickerLogoDisplay={tickerLogoDisplay} />}
            {workspaceTab === "performance" && <PerformanceView snapshot={snapshot} mode={mode} modeLabel={accountModeLabel} symbolMetaBySymbol={symbolMetaBySymbol} />}
            {workspaceTab === "tax" && <TaxView snapshot={snapshot} symbolMetaBySymbol={symbolMetaBySymbol} scan={drilldownScan} onDrilldown={setDrilldownSymbol} tickerLogoDisplay={tickerLogoDisplay} />}
            {workspaceTab === "strategy" && (
              <StrategyView
                snapshot={snapshot}
                policy={policy}
                updatePolicy={updatePolicy}
                onEdit={() => setStudioOpen(true)}
                onOpenFlow={() => setNodeEditorOpen(true)}
                activateProfile={activateProfile}
                copyProfileToAccount={copyProfileToAccount}
                newProfileName={newProfileName}
                setNewProfileName={setNewProfileName}
                createProfile={createProfile}
                requestStrategyTuning={requestStrategyTuning}
                tuningBusy={tuningBusy}
                tuningError={tuningError}
                strategyTuning={strategyTuning}
                applyStrategyTuning={applyStrategyTuning}
                discardStrategyTuning={discardStrategyTuning}
              />
            )}
          </div>
        </main>
      </div>

      {/* ── Overlays ────────────────────────────────────────────── */}
      <SlideOver
        open={feedOpen}
        onClose={() => setFeedOpen(false)}
        title="Activity"
        subtitle="Trading log, runs & alerts"
        icon={<ActivityIcon size={18} />}
        width="max-w-2xl"
      >
        <div className="p-4">
          <Tabs
            value={feedTab}
            onChange={setFeedTab}
            tabs={[
              { id: "activity", label: "Activity" },
              { id: "runs", label: "Runs" },
              { id: "notifications", label: "Alert history" },
              { id: "audit", label: "Audit Log" }
            ]}
          />
        </div>
        <div className="px-4 pb-4">
          {feedTab === "activity" && (
            <ActivityFeed
              snapshot={snapshot}
              onReplaceMarket={(candidate) => {
                setReplaceMarketOrder(candidate);
                setReplaceMarketText("");
              }}
            />
          )}
          {feedTab === "runs" && <RunHistory snapshot={snapshot} />}
          {feedTab === "notifications" && <NotificationsList snapshot={snapshot} />}
          {feedTab === "audit" && <AuditLog snapshot={snapshot} />}
        </div>
      </SlideOver>

      <SlideOver
        open={!!drilldownSymbol}
        onClose={() => setDrilldownSymbol(null)}
        title={drilldownSymbol ? <SymbolDrilldownTitle quote={drilldownSymbol} logoDisplay={tickerLogoDisplay} /> : "Symbol"}
        ariaLabel={drilldownSymbol ? `${drilldownSymbol.symbol} details` : "Symbol details"}
        width="max-w-xl"
      >
        {drilldownSymbol && (
          <SymbolDrilldown
            quote={drilldownSymbol}
            logoDisplay={tickerLogoDisplay}
            onQuoteUpdate={(patch) => {
              setDrilldownSymbol((current) => current && current.symbol === drilldownSymbol.symbol ? { ...current, ...patch } : current);
            }}
          />
        )}
      </SlideOver>

      <LearnedContextQueue
        open={learnedQueueOpen}
        onClose={() => setLearnedQueueOpen(false)}
        onCountChange={setLearnedQueueCount}
      />

      <Modal open={nodeEditorOpen} onClose={() => setNodeEditorOpen(false)} title="Strategy Flow" subtitle="Live pipeline status" icon={<Network size={20} />} size="full">
        <div className="h-full w-full">
          <StrategyFlow snapshot={snapshot} />
        </div>
      </Modal>

      <Modal open={studioOpen} onClose={() => setStudioOpen(false)} title="Strategy Studio" subtitle="Prompt, sliders, scoring weights & LLM review" icon={<BrainCircuit size={20} />} size="xl">
        <StrategyStudio
          snapshot={snapshot}
          policy={policy}
          editStrategyPrompt={editStrategyPrompt}
          resetPrompt={() => {
            setSnapshot((c) => ({ ...c, strategyPrompt: DEFAULT_STRATEGY_PROMPT }));
            void saveStrategyPrompt(DEFAULT_STRATEGY_PROMPT);
          }}
          updatePolicy={updatePolicy}
          requestStrategyTuning={requestStrategyTuning}
          tuningBusy={tuningBusy}
          tuningError={tuningError}
          strategyTuning={strategyTuning}
          applyStrategyTuning={applyStrategyTuning}
          discardStrategyTuning={discardStrategyTuning}
        />
      </Modal>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Settings"
        icon={<SettingsIcon size={20} />}
        size="xl"
        headerAction={
          <div className="flex items-center gap-2 max-sm:gap-1">
            {snapshot.currentUser?.isAdmin && (
              <a href="/admin/connections" className={buttonClass({ variant: "ghost", size: "sm", className: "max-sm:px-2" })}>
                <Network size={14} />
                <span className="hidden sm:inline">Connection Status</span>
                <span className="sm:hidden">Status</span>
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="max-sm:px-2"
              onClick={() => {
                setSettingsOpen(false);
                setAccountsOpen(true);
              }}
            >
              <Wallet size={14} />
              <span className="hidden sm:inline">Manage Accounts</span>
              <span className="sm:hidden">Accounts</span>
            </Button>
          </div>
        }
      >
        <SettingsContent
          snapshot={snapshot}
          policy={policy}
          initialSection={settingsInitialSection}
          allowedCount={allowedCount}
          enableBlockedReason={enableBlockedReason}
          remainingNotional={remainingNotional}
          remainingOrders={remainingOrders}
          updatePolicy={updatePolicy}
          tickerLogoDisplay={tickerLogoDisplay}
          setTickerLogoDisplay={updateTickerLogoDisplay}
          executionBannerMode={executionBannerMode}
          setExecutionBannerMode={updateExecutionBannerMode}
          openAccounts={() => setAccountsOpen(true)}
          openStrategyStudio={() => {
            setSettingsOpen(false);
            setStudioOpen(true);
          }}
          load={load}
          onChangeAccount={activateAccount}
          onRequestDecideConfirm={() => setDecideConfirm(true)}
          onRequestSystemToggle={() => setKillConfirm(true)}
        />
      </Modal>

      <Modal open={accountsOpen} onClose={() => setAccountsOpen(false)} title="Accounts" icon={<Wallet size={20} />} size="lg">
        <IntegrationsSection accounts={snapshot.connectedAccounts || []} policy={policy} onSaved={load} hideTestAccount={hideTestAccount} setHideTestAccount={updateHideTestAccount} />
      </Modal>

      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="System Help" subtitle="How it works, safeguards, costs & data sources" icon={<HelpCircle size={20} />} size="xl">
        <HelpContent policy={policy} snapshot={snapshot} />
      </Modal>

      <ConfirmModal
        open={killConfirm}
        onClose={() => setKillConfirm(false)}
        onConfirm={async () => {
          requestAutonomy(policy.systemState === "halted");
          setKillConfirm(false);
        }}
        title={policy.systemState === "halted" ? "Start the system?" : "Stop the system?"}
        body={
          policy.systemState === "halted"
            ? `This starts the system running. Only while running can orders be placed — and in ${policy.strategyAuthority === "decide" ? "Autonomous mode the agent executes approved orders automatically" : "Propose mode each order still waits for your approval"}. Account and universe checks still apply.`
            : "This immediately stops all automated trading runs and blocks any new orders until you start it again."
        }
        confirmLabel={policy.systemState === "halted" ? "Start" : "Stop"}
        tone={policy.systemState === "halted" ? "primary" : "danger"}
      />

      <ConfirmModal
        open={decideConfirm}
        onClose={() => setDecideConfirm(false)}
        onConfirm={() => {
          setDecideConfirm(false);
          setSnapshot((s) => ({ ...s, policy: { ...s.policy, strategyAuthority: "decide" } }));
          void updatePolicy({ strategyAuthority: "decide" });
        }}
        title="Enable autonomous execution?"
        body="Autonomous mode allows the agent to execute approved orders automatically without requiring per-order confirmation. Only enable this if you have reviewed your risk limits, universe, and daily caps — the agent will trade on your behalf while the system is running."
        confirmLabel="Enable auto-execute"
        tone="primary"
      />

      <ConfirmationModal
        open={!!liveConfirmation}
        onClose={() => setLiveConfirmation(null)}
        onConfirm={handleLiveConfirm}
        symbol={liveConfirmation?.symbol ?? ""}
        side={liveConfirmation?.side ?? ""}
        quantity={liveConfirmation?.quantity}
        dollarAmount={liveConfirmation?.dollarAmount}
        price={liveConfirmation?.price}
        estimatedNotional={liveConfirmation?.estimatedNotional}
        accountNumber={liveConfirmation?.accountNumber}
      />

      <MarketReplaceModal
        candidate={replaceMarketOrder}
        live={executionState.mode === "broker/live"}
        accountNumber={snapshot.policy.accountNumber}
        typedText={replaceMarketText}
        onTypedText={setReplaceMarketText}
        busy={busy}
        onClose={() => {
          setReplaceMarketOrder(null);
          setReplaceMarketText("");
        }}
        onConfirm={submitMarketReplace}
      />
    </div>
  );
}

/* ───────────────────────── Command-bar pieces ───────────────────────── */

function StatusPill({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-3 py-1" title={title}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      <span className="tnum text-[13px] leading-tight text-fg">{value}</span>
    </div>
  );
}

function DailyRiskPill({ pct, used, cap }: { pct: number; used: number; cap: number }) {
  const tone = pct >= 90 ? "down" : pct >= 60 ? "warn" : "accent";
  const bar = tone === "down" ? "bg-down" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-3 py-1" title={`${money(used)} of ${money(cap)} daily volume limit used`}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">Daily volume</span>
      <div className="flex items-center gap-1.5">
        <span className="tnum text-[13px] leading-tight text-fg">{pct}%</span>
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3/50 backdrop-blur-md">
          <span className={cn("block h-full rounded-full", bar)} style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      </div>
    </div>
  );
}


/* ───────────────────────── Portfolio rail ───────────────────────── */

function MobilePortfolioSummary({ snapshot, mode, modeLabel }: { snapshot: DashboardSnapshot; mode: "paper" | "live"; modeLabel: string }) {
  const portfolio = snapshot.portfolio;
  const positions = snapshot.positions;
  const total = portfolio?.totalMarketValue ?? 0;
  const perf = snapshot.performance;
  const pnl = mode === "paper"
    ? (perf?.paperUnrealizedPnl ?? 0) + (perf?.paperRealizedPnl ?? 0)
    : (perf?.liveUnrealizedPnl ?? 0) + (perf?.liveRealizedPnl ?? 0);

  const [posOpen, setPosOpen] = useState(false);
  const enriched = enrichPositionsForDisplay(positions, total).sort((a, b) => b.marketValue - a.marketValue);

  return (
    <Card className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Portfolio</h2>
          <p className="text-xs text-faint">{getPortfolioAccountSubtitle(snapshot)}</p>
        </div>
        <Chip tone={mode === "paper" ? "info" : "up"}>{modeLabel}</Chip>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Value</div>
          <div className="tnum mt-1 text-base text-fg">{money(total)}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">P&L</div>
          <div className={cn("tnum mt-1 text-base", pnl >= 0 ? "text-up" : "text-down")}>{signedMoney(pnl)}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Positions</div>
          <button
            onClick={() => setPosOpen((o) => !o)}
            className="mt-1 flex items-center gap-0.5 tnum text-base text-fg"
          >
            {positions.length}
            <ChevronDown size={14} className={cn("transition-transform", posOpen && "rotate-180")} />
          </button>
        </div>
      </div>
      {posOpen && (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-line/50">
          {enriched.length === 0 ? (
            <EmptyState icon={<Wallet size={ICON.md} />} title="No Open Positions" />
          ) : (
            enriched.map((p) => (
              <div key={p.symbol} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                <span className="flex-1 font-semibold text-fg">{p.symbol}</span>
                <span className="tnum text-fg">{money(p.marketValue)}</span>
                <span className={cn("tnum", p.pnl > 0 ? "text-up" : p.pnl < 0 ? "text-down" : "text-fg")}>
                  {signedMoney(p.pnl)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}

function PortfolioRail({
  snapshot,
  mode,
  modeLabel,
  symbolMetaBySymbol,
  scan,
  onDrilldown,
  tickerLogoDisplay
}: {
  snapshot: DashboardSnapshot;
  mode: "paper" | "live";
  modeLabel: string;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
  tickerLogoDisplay: TickerLogoDisplay;
}) {
  const portfolio = snapshot.portfolio;
  const positions = snapshot.positions;
  const total = portfolio?.totalMarketValue ?? 0;
  const perf = snapshot.performance;
  const dayPnl = mode === "paper" ? (perf?.paperUnrealizedPnl ?? 0) + (perf?.paperRealizedPnl ?? 0) : (perf?.liveUnrealizedPnl ?? 0) + (perf?.liveRealizedPnl ?? 0);

  const equityValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const cashValue = Math.max(0, total - equityValue);
  const segments = [
    ...positions.map((p) => ({ label: p.symbol, value: p.marketValue, pct: total > 0 ? (p.marketValue / total) * 100 : 0 })),
    { label: "Cash", value: cashValue, pct: total > 0 ? (cashValue / total) * 100 : 0 }
  ].filter((s) => s.pct > 0.05);

  const enriched = enrichPositionsForDisplay(positions, total).sort((a, b) => b.marketValue - a.marketValue);

  // Portfolio balances come from the active *broker* account (its API). Attribute Value/P&L to that
  // broker + the account's last-synced time — but ONLY for a real broker. The local Test-broker
  // account (test infrastructure) has no upstream provider, so we leave the plain label rather than
  // invent one.
  const activeAcc = activeConnectedAccountFor(snapshot);
  const brokerSource = activeAcc && activeAcc.broker !== "test" ? activeAcc.broker : undefined;
  const brokerAsOf = brokerSource ? activeAcc?.updatedAt : undefined;
  const valueTitle = brokerSource ? dataPointTitle("Account value", brokerSource, brokerAsOf) : undefined;

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <PanelHeader title="Portfolio" subtitle={getPortfolioAccountSubtitle(snapshot)} icon={<Wallet size={16} />} />
      <div className="grid grid-cols-2 gap-2 px-4 pt-3">
        <StatTile label="Value" value={money(total)} title={valueTitle} />
        <StatTile label="P&L" value={signedMoney(dayPnl)} tone={pnlTone(dayPnl)} />
      </div>
      <div className="px-4 py-3">
        {segments.length > 0 ? <AllocationDonut segments={segments} /> : <EmptyState title="No Allocation Yet" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {enriched.length === 0 ? (
          <EmptyState icon={<Wallet size={20} />} title="No Open Positions" hint="Run the strategy to start building a position set." />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface/50 backdrop-blur-xl">
              <tr className="text-[11px] uppercase text-faint">
                <th className="px-2 py-1.5 text-left font-semibold">Symbol</th>
                <th className="px-2 py-1.5 text-right font-semibold">Value</th>
                <th className="px-2 py-1.5 text-right font-semibold">P&L</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((p) => (
                <tr key={p.symbol} className="border-t border-line/60 hover:bg-surface-2/50 backdrop-blur-lg">
                  <td className="px-2 py-1.5">
                    <SymbolButton symbol={p.symbol} scan={scan} onDrilldown={onDrilldown} className="block font-semibold text-fg" title={companyTitle(p.symbol, symbolMetaBySymbol)} logoDisplay={tickerLogoDisplay} showLogo />
                    <div className="tnum text-[11px] text-faint">{formatShareQuantity(p.quantity, p.symbol)} sh · {p.allocPct.toFixed(1)}%</div>
                  </td>
                  <td className="px-2 py-1.5 text-right tnum text-fg">{money(p.marketValue)}</td>
                  <td className={cn("px-2 py-1.5 text-right tnum", p.pnl > 0 ? "text-up" : p.pnl < 0 ? "text-down" : "text-fg")}>
                    <div>{signedMoney(p.pnl)}</div>
                    <div className="text-[11px]">{formatPct(p.returnPct)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

/* ───────────────────────── Decision view ───────────────────────── */

/**
 * Bull rationale paragraph with tap-to-expand. The default 3-line clamp keeps the
 * card compact, but a hover-only `title` tooltip is unreachable on touch, so this
 * adds an explicit, keyboard-focusable "Show more"/"Show less" toggle that expands
 * the text in place. The `title` tooltip is kept as a secondary desktop affordance.
 */
function ProposalRationale({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // Only offer the toggle when the text is long enough to plausibly clamp — short
  // rationales render as a plain paragraph with no dangling control.
  const canExpand = text.length > 140;
  return (
    <div className="mt-2">
      <p
        className={cn("text-[13px] leading-snug text-fg/85", !expanded && "line-clamp-3")}
        title={text}
      >
        {text}
      </p>
      {canExpand && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-0.5 text-[11px] font-medium text-accent transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 rounded"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * Bear Review callout — surfaces the Red Team (Bear) verdict as its own tinted
 * block instead of burying it in the truncated Bull rationale. Renders nothing
 * for older proposals that predate the `redTeamVerdict` field (backward compat).
 */
function BearReview({ verdict }: { verdict: TradeProposal["redTeamVerdict"] }) {
  if (!verdict) return null;
  const { rejected, available, reason } = verdict;
  // Three states: unavailable (Bear didn't run) → neutral; rejected → down/red;
  // survived → up/green. Each gets a matching tint, border, label, and icon.
  const state = !available ? "unavailable" : rejected ? "rejected" : "survived";
  const styles = {
    survived: { box: "border-up/30 bg-up/10", label: "text-up", icon: <ShieldCheck size={ICON.sm} className="text-up" /> },
    rejected: { box: "border-down/40 bg-down/10", label: "text-down", icon: <ShieldAlert size={ICON.sm} className="text-down" /> },
    unavailable: { box: "border-line bg-surface-3/40", label: "text-muted", icon: <Shield size={ICON.sm} className="text-faint" /> }
  }[state];
  const heading = state === "survived" ? "Bear Review — Survived" : state === "rejected" ? "Bear Review — Rejected" : "Bear Review — Unavailable";
  return (
    <div className={cn("mt-2 rounded-lg border px-2.5 py-2", styles.box)}>
      <div className={cn("flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider", styles.label)}>
        {styles.icon}
        <span>{heading}</span>
      </div>
      {reason && <p className="mt-1 text-[12px] leading-snug text-fg/80">{reason}</p>}
    </div>
  );
}

function DecisionView({
  snapshot,
  symbolMetaBySymbol,
  busy,
  approve,
  reject,
  scan,
  onDrilldown,
  tickerLogoDisplay
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  busy: boolean;
  approve: (id: string) => void;
  reject: (id: string) => void;
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
  tickerLogoDisplay: TickerLogoDisplay;
}) {
  const decision = snapshot.latestStrategyRun;
  const pending = snapshot.pendingProposals;
  const executionState = executionStateFor(snapshot);
  const recentDecisionItems = decisionLedgerItems(snapshot);
  return (
    <div className="space-y-3">
      {pending.length === 0 && snapshot.policy.strategyAuthority === "propose" && snapshot.policy.systemState === "active" && (
        <Card className="overflow-hidden">
          <PanelHeader title="Pending Approval" subtitle="No Proposals Awaiting Review" icon={<CheckCircle size={16} />} />
          <EmptyState icon={<CheckCircle size={20} />} title="All Clear — No Pending Approvals" hint="The agent will surface new proposals here when it identifies tradeable opportunities on the next run." />
        </Card>
      )}
      {pending.length > 0 && (
        <Card className="overflow-hidden">
          <PanelHeader title="Pending Approval" subtitle="Review And Approve Or Reject" icon={<CheckCircle size={16} />} />
          {snapshot.policy.strategyAuthority === "decide" && (
            <div className="mx-4 mt-3 rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[12px] leading-snug text-muted">
              Run once stages manual proposals for review. Start runs scheduled autonomous placement while the system is running and account/risk checks pass.
            </div>
          )}
          <div className="grid gap-2 p-4 pt-3 sm:grid-cols-2">
            {pending.map((p) => {
              const accountLabel = getProposalAccountLabel(p.accountNumber || snapshot.policy.accountNumber, snapshot.connectedAccounts);
              const age = proposalAgeTone(p.createdAt);
              const modeMismatch = Boolean(p.executionMode && p.executionMode !== executionState.mode);
              const stoppedActionReason =
                isProposalActionStopped(snapshot.policy) ? STOPPED_PROPOSAL_ACTION_DESCRIPTION : undefined;
              const approvalBlockReason =
                stoppedActionReason ??
                (modeMismatch
                    ? `Generated in ${executionModeLabel(p.executionMode)}. Current mode is ${executionModeLabel(executionState.mode)}; re-run before approving.`
                    : undefined);
              return (
                <div
                  key={p.id}
                  className={cn(
                    "rounded-xl border border-line bg-surface-2/50 backdrop-blur-lg p-3",
                    stoppedActionReason && "border-warn/60 bg-warn/10 ring-1 ring-warn/20"
                  )}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted">
                    {accountLabel && <span>{accountLabel}</span>}
                    {p.executionMode && <Chip tone={modeMismatch ? "warn" : "neutral"}>{executionModeLabel(p.executionMode)}</Chip>}
                    {p.createdAt && <ProposalTimeMeta iso={p.createdAt} label="Proposed" />}
                    {age && <Chip tone={age.tone}>{age.label}</Chip>}
                    {typeof p.performanceSinceProposalPct === "number" && (
                      <span title="Side-adjusted move since this proposal was made.">
                        <Chip tone={p.performanceSinceProposalPct >= 0 ? "up" : "down"}>
                          since {formatPct(p.performanceSinceProposalPct)}
                        </Chip>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip tone={p.proposal.side === "buy" ? "up" : "down"}>{p.proposal.side.toUpperCase()}</Chip>
                    <SymbolButton
                      symbol={p.proposal.symbol}
                      scan={scan}
                      onDrilldown={onDrilldown}
                      className="text-base font-semibold text-fg"
                      title={companyTitle(p.proposal.symbol, symbolMetaBySymbol)}
                      logoDisplay={tickerLogoDisplay}
                      showLogo
                    />
                    <span className="ml-auto tnum text-xs text-fg font-medium" title="Estimated total cost and share count. The '~' means it's an estimate — the actual fill price (and so the exact shares) can differ slightly.">{proposalSize(p.proposal, p.review?.estimatedNotional, decision?.marketScan?.quotesBySymbol[p.proposal.symbol]?.price)}</span>
                  </div>
                  <ProposalRationale text={p.proposal.rationale} />
                  <BearReview verdict={p.proposal.redTeamVerdict} />
                  {p.lastRevalidatedAt && (
                    <p className="mt-1.5 text-[11px] text-faint" title={p.revalidationNote}>
                      Revalidated {proposalTimeLabel(p.lastRevalidatedAt)}
                    </p>
                  )}
                  {stoppedActionReason && (
                    <div className="mt-3 flex gap-2 rounded-lg border border-warn/40 bg-warn/10 p-2 text-[12px] leading-snug text-warn">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <div>
                        <div className="font-semibold">System stopped</div>
                        <p className="text-fg/80">{stoppedActionReason}</p>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <span className="flex-1" title={approvalBlockReason}>
                      <Button
                        variant={approvalBlockReason ? "ghost" : "primary"}
                        size="sm"
                        className={cn(
                          "w-full",
                          approvalBlockReason && "border-warn/60 bg-warn/10 text-warn hover:bg-warn/15"
                        )}
                        disabled={busy}
                        onClick={() => {
                          if (approvalBlockReason) {
                            toast.warning(stoppedActionReason ? STOPPED_PROPOSAL_ACTION_TITLE : "Approval unavailable.", {
                              description: approvalBlockReason
                            });
                            return;
                          }
                          approve(p.id);
                        }}
                      >
                        {approvalBlockReason ? <AlertTriangle size={14} /> : <Check size={14} />}
                        {stoppedActionReason ? "Start to Accept" : "Accept"}
                      </Button>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "flex-1",
                        stoppedActionReason && "border-warn/60 bg-warn/10 text-warn hover:bg-warn/15"
                      )}
                      disabled={busy}
                      onClick={() => {
                        if (stoppedActionReason) {
                          showStoppedProposalActionToast();
                          return;
                        }
                        reject(p.id);
                      }}
                    >
                      {stoppedActionReason ? <AlertTriangle size={14} /> : <XCircle size={14} />}
                      {stoppedActionReason ? "Start to Reject" : "Reject"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <PanelHeader
          title="Latest Decisions"
          subtitle={
            recentDecisionItems.length > 0
              ? `${Math.min(recentDecisionItems.length, 100)} recent proposal decisions`
              : decision?.marketScan
                ? `${decision.marketScan.scannedSymbols} symbols scanned · ${formatSourceList(decision.marketScan.source)}`
                : "Run the strategy to generate a decision"
          }
          icon={<Sparkles size={16} />}
        />
        {!decision && recentDecisionItems.length === 0 ? (
          <EmptyState icon={<BrainCircuit size={20} />} title="No Decision Yet" hint="Set your tradable universe in Settings → Operate, then use Run to generate the agent's first decision." />
        ) : (
          <div className="space-y-3 p-4 pt-3">
            {decision && (() => {
              const decisionSummary = decision.status === "failed"
                ? plainAppError(decision.summary, "Strategy run failed.")
                : decision.summary;
              return (
            <div className={cn("rounded-xl border px-3 py-2 text-[13px]",
              decision.status !== "failed"
                ? "border-info/25 bg-info/10 text-fg"
                : /no account|account selected|no symbols|universe is empty|empty universe/i.test(decisionSummary || "")
                  ? "border-warn/30 bg-warn/10 text-warn"
                  : "border-down/30 bg-down/10 text-down")}>
              {decisionSummary}
            </div>
              );
            })()}
            <div className="max-h-[760px] space-y-2 overflow-y-auto overflow-x-hidden pr-1">
            {recentDecisionItems.slice(0, 100).map((item) => {
              const accountLabel = getProposalAccountLabel(item.accountNumber || decision?.accountNumber || snapshot.policy.accountNumber, snapshot.connectedAccounts);
              const age = proposalAgeTone(item.createdAt);
              const quote = scan?.quotesBySymbol[item.proposal.symbol] ?? decision?.marketScan?.quotesBySymbol[item.proposal.symbol];
              const reasons = decisionLedgerReasons(item);
              const hypothetical = decisionHypotheticalNote(item, quote);
              return (
                <div key={item.id} className={cn("rounded-lg border bg-surface-2/50 p-3", decisionCardTone(item.status))}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted">
                    {accountLabel && <span>{accountLabel}</span>}
                      {item.executionMode && <Chip tone="neutral">{executionModeLabel(item.executionMode)}</Chip>}
                      {item.createdAt && <ProposalTimeMeta iso={item.createdAt} label="Decided" />}
                    {age && <Chip tone={age.tone}>{age.label}</Chip>}
                  </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(() => {
                        const perf = proposalPerformancePct(item, quote);
                        if (perf == null) return null;
                        const missed = isMissedProposal(item.status);
                        return (
                          <span
                            title={missed
                              ? "Side-adjusted move since this proposal — what it would have returned if accepted (counterfactual)."
                              : "Side-adjusted move since this proposal was made."}
                          >
                            <Chip tone={perf >= 0 ? "up" : "down"}>
                              {missed ? "missed " : "since "}{formatPct(perf)}
                            </Chip>
                          </span>
                        );
                      })()}
                      <Chip tone={statusTone(item.status)}>{displayStatus(item.status)}</Chip>
                    </div>
                  </div>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Chip tone={item.proposal.side === "buy" ? "up" : "down"}>{item.proposal.side.toUpperCase()}</Chip>
                    <SymbolButton
                      symbol={item.proposal.symbol}
                      scan={scan}
                      onDrilldown={onDrilldown}
                      className="font-semibold text-fg"
                      title={companyTitle(item.proposal.symbol, symbolMetaBySymbol)}
                      logoDisplay={tickerLogoDisplay}
                      showLogo
                    />
                    {item.proposal.tradeThesisTag && <Chip tone="accent">{item.proposal.tradeThesisTag}</Chip>}
                    </div>
                    <div className="rounded-md border border-line/70 bg-bg/35 px-2 py-1 text-right">
                      <div className="tnum text-xs font-semibold text-fg" title="Estimated total cost and share count. The '~' means it's an estimate — the actual fill price and exact shares can differ.">
                        {proposalSize(item.proposal, item.estimatedNotional ?? item.review?.estimatedNotional, quote?.price)}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-faint">{labelize(item.proposal.type)}</div>
                    </div>
                  </div>
                  <p className="mt-2 break-words text-[13px] leading-snug text-fg/85">{item.proposal.rationale}</p>
                  {(reasons.length > 0 || hypothetical) && (
                    <div className="mt-2 grid gap-1.5 text-[11px] text-faint sm:grid-cols-2">
                      {reasons.length > 0 && <p className="rounded-md bg-surface-3/50 px-2 py-1">{reasons.join("; ")}</p>}
                      {hypothetical && <p className="rounded-md border border-info/20 bg-info/10 px-2 py-1 text-muted">{hypothetical}</p>}
                    </div>
                  )}
                  {item.errorMessage && (
                    <p className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-[11px] text-muted">
                      <span className="font-semibold">Order error: </span>{humanizeBrokerError(item.errorMessage)}
                    </p>
                  )}
                </div>
              );
            })}
            </div>
            <p className="text-[11px] text-faint">Automated, for this single owner account — not investment advice. Past performance is not indicative of future results.</p>
          </div>
        )}
      </Card>
    </div>
  );
}

type DecisionLedgerItem = {
  id: string;
  createdAt?: string;
  accountNumber?: string;
  executionMode?: ExecutionMode;
  proposal: TradeProposal;
  status: string;
  reasons: string[];
  estimatedNotional?: number;
  review?: { estimatedNotional?: number };
  performanceSinceProposalPct?: number;
  proposalReferencePrice?: number;
  proposalCurrentPrice?: number;
  errorMessage?: string;
};

function decisionLedgerItems(snapshot: DashboardSnapshot): DecisionLedgerItem[] {
  const recent = snapshot.recentProposals ?? [];
  if (recent.length > 0) {
    const feedStatusByProposalId = new Map(
      (snapshot.unifiedFeed ?? [])
        .filter((group) => group.proposalId)
        .map((group) => [group.proposalId!, group.status])
    );
    return recent.map((item) => {
      const effectiveStatus = feedStatusByProposalId.get(item.id) ?? item.status;
      return {
        id: item.id,
        createdAt: item.createdAt,
        accountNumber: item.accountNumber,
        executionMode: item.executionMode,
        proposal: item.proposal,
        status: effectiveStatus,
        reasons: item.decision?.reasons ?? [],
        estimatedNotional: item.estimatedNotional,
        review: item.review,
        performanceSinceProposalPct: item.performanceSinceProposalPct,
        proposalReferencePrice: item.proposalReferencePrice,
        proposalCurrentPrice: item.proposalCurrentPrice,
        errorMessage: item.errorMessage
      };
    });
  }
  const decision = snapshot.latestStrategyRun;
  if (!decision) return [];
  return decision.proposals.map((item, index) => ({
    id: `${decision.runId}-${index}`,
    createdAt: decision.createdAt,
    accountNumber: decision.accountNumber,
    proposal: item.proposal,
    status: item.status,
    reasons: item.reasons ?? []
  }));
}

function decisionLedgerReasons(item: DecisionLedgerItem): string[] {
  if (item.reasons.length > 0) return item.reasons;
  if (item.status === "rejected") return ["Rejected manually."];
  if (item.status === "blocked") return ["Blocked by policy."];
  if (item.status === "expired") return ["Expired before approval."];
  if (item.status === "withdrawn") return ["Withdrawn after revalidation."];
  return [];
}

function decisionCardTone(status: string): string {
  if (status === "rejected" || status === "blocked" || status === "failed" || status === "expired") return "border-down/35";
  if (status === "proposed" || status === "placing" || status === "pending_order" || status === "pending_reconciliation" || status === "placed" || status === "partially_filled") return "border-warn/35";
  if (status === "paper" || status === "filled") return "border-up/30";
  return "border-line";
}

/** A rejected/blocked/expired/withdrawn proposal shows a "didn't take it" counterfactual framing. */
function isMissedProposal(status: string): boolean {
  return ["rejected", "blocked", "expired", "withdrawn"].includes(status);
}

/** Side-adjusted performance since the proposal — prefers the server figure, falls back to the live quote. */
function proposalPerformancePct(item: DecisionLedgerItem, quote?: { price: number }): number | undefined {
  if (typeof item.performanceSinceProposalPct === "number") return item.performanceSinceProposalPct;
  const referencePrice = item.proposalReferencePrice ?? item.proposal.referencePrice ?? item.proposal.limitPrice ?? item.proposal.stopPrice;
  if (!quote || typeof referencePrice !== "number" || referencePrice <= 0) return undefined;
  const sideMultiplier = item.proposal.side === "sell" || item.proposal.side === "short" ? -1 : 1;
  return ((quote.price - referencePrice) / referencePrice) * 100 * sideMultiplier;
}

function decisionHypotheticalNote(item: DecisionLedgerItem, quote?: { price: number }): string | undefined {
  const pct = proposalPerformancePct(item, quote);
  const missed = isMissedProposal(item.status);
  if (pct == null) {
    // Only nag about a pending counterfactual for the missed cases; accepted ones simply omit it.
    return missed ? "Counterfactual pending a current quote." : undefined;
  }
  const ref = item.proposalReferencePrice ?? item.proposal.referencePrice ?? item.proposal.limitPrice ?? item.proposal.stopPrice;
  const cur = item.proposalCurrentPrice ?? quote?.price;
  const fromTo = typeof ref === "number" && ref > 0 && typeof cur === "number" && cur > 0 ? ` (from ${money(ref)} → ${money(cur)})` : "";
  return missed
    ? `Counterfactual since proposal: ${formatPct(pct)} if accepted${fromTo}.`
    : `Performance since proposal: ${formatPct(pct)}${fromTo}.`;
}

function ProposalTimeMeta({ iso, label }: { iso?: string; label: string }) {
  const display = proposalTimeParts(iso);
  if (!display) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 normal-case tracking-normal" title={display.full}>
      <span className="font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="rounded-md bg-surface-3/55 px-1.5 py-0.5 text-[10px] font-semibold text-fg">{display.display}</span>
    </span>
  );
}

/* ───────────────────────── Market scan view ───────────────────────── */

const DASH = <span className="text-faint">—</span>;

type ScanColumn = {
  id: string;
  label: string;
  title: string; // rich header tooltip: acronym expansion + methodology + source
  align?: "right";
  defaultHidden?: boolean;
  /** Sort by a raw quote field… */
  sortKey?: keyof MarketQuote;
  /** …or by a computed value (for backend-derived columns not stored on the quote). */
  sortValue?: (q: MarketQuote) => number | string | undefined;
  render: (q: MarketQuote) => React.ReactNode;
  cellClass?: (q: MarketQuote) => string;
  cellTitle?: (q: MarketQuote) => string | undefined;
};

/** Resolve the value a column sorts on — its computed value if any, else the raw quote field. */
function scanSortValue(col: ScanColumn, q: MarketQuote): unknown {
  if (col.sortValue) return col.sortValue(q);
  return col.sortKey ? q[col.sortKey] : undefined;
}

function vwapDeltaPct(q: MarketQuote): number | undefined {
  if (typeof q.vwap !== "number" || !Number.isFinite(q.vwap) || q.vwap <= 0) return undefined;
  return ((q.price - q.vwap) / q.vwap) * 100;
}

// Debt/equity normalized to a true RATIO. Providers report D/E as a ratio (1.5) or a percentage (150);
// the `>10 → ÷100` heuristic converts the percentage form, but is SOURCE-AWARE — sec-xbrl always emits a
// true ratio (a genuine 12x must stay 12, not become 0.12). Used by BOTH the renderer and the column
// sort so clicking the header orders by the visible value (a Yahoo 150 → 1.50 must not sort above a SEC
// 12 → 12.00). Mirrors the same normalization in market.ts qualityScore.
function normalizedDebtToEquity(q: MarketQuote): number | undefined {
  if (typeof q.debtToEquity !== "number") return undefined;
  return q.sources?.debtToEquity !== "sec-xbrl" && q.debtToEquity > 10 ? q.debtToEquity / 100 : q.debtToEquity;
}

/**
 * Shared "what is this data point, where did it come from, and when did it arrive?" tooltip.
 * Returns the label on its own, then `Source: <pretty provider>` when a source is known, then
 * the human "Received HH:MM" stamp when an `asOf` timestamp is known — each on its own line.
 * Source attribution must be the *specific field's* provider (e.g. `quote.sources?.peRatio`),
 * never a fabricated or quote-level provider. With no source and no time it is just the label.
 */
function dataPointTitle(label: string, source?: string, asOf?: string): string {
  const parts = [label];
  if (source) parts.push(`Source: ${friendlySource(source)}`);
  const received = receivedLabel(asOf);
  if (received) parts.push(received);
  return parts.join("\n");
}

/**
 * Tooltip for a DERIVED/[CALCULATED] column: keep the column's existing methodology blurb,
 * then append "Computed from <input fields> · Received HH:MM". Attribution is to the INPUT
 * fields' own providers (gathered honestly from `quote.sources`) — we never invent a provider
 * for a value no upstream API emitted. The provider line is only shown when at least one input
 * field actually has a recorded source.
 */
function derivedTitle(
  explanation: string,
  inputs: string,
  q: MarketQuote,
  sourceFields: Array<keyof NonNullable<MarketQuote["sources"]>>
): string {
  const providers = Array.from(
    new Set(
      sourceFields
        .map((field) => q.sources?.[field])
        .filter((value): value is string => Boolean(value))
        .map((value) => friendlySource(value))
    )
  );
  const received = receivedLabel(q.asOf);
  const computed = [`Computed from ${inputs}`, received].filter(Boolean).join(" · ");
  const provenance = providers.length > 0 ? `\nInput source: ${providers.join(" + ")}` : "";
  return `${explanation}\n${computed}${provenance}`;
}

function vwapTitle(q: MarketQuote): string | undefined {
  const delta = vwapDeltaPct(q);
  if (typeof delta !== "number") return undefined;
  return `Price ${money(q.price)} vs VWAP ${money(q.vwap)} (${formatPct(delta)}). ${dataPointTitle("VWAP", q.sources?.vwap, q.asOf)}`;
}

function formatScanSources(sourceString: string): string {
  return formatSourceList(sourceString);
}

const SCAN_COLUMNS: ScanColumn[] = [
  { id: "symbol", label: "Symbol", title: "Ticker symbol. Hover a row for the company name.", sortKey: "symbol",
    render: (q) => <span className="font-semibold text-fg">{q.symbol}</span>, cellTitle: (q) => q.companyName },
  { id: "price", label: "Price", title: "Last traded price (delayed). Source: NASDAQ delayed screener, refined by Yahoo / broker quotes when available.", align: "right", sortKey: "price",
    render: (q) => <span className="tnum">{money(q.price)}</span>, cellTitle: (q) => quoteTitle("Quote", q) },
  { id: "intradayChangePct", label: "Chg", title: "Intraday price change, percent vs the prior session's close.", align: "right", sortKey: "intradayChangePct",
    render: (q) => <span className="tnum">{formatPct(q.intradayChangePct)}</span>, cellClass: (q) => (q.intradayChangePct >= 0 ? "text-up" : "text-down"),
    cellTitle: (q) => dataPointTitle("Intraday change", q.sources?.intradayChangePct, q.asOf) },
  { id: "vsVwap", label: "vs VWAP", title: "Last price vs latest daily VWAP. Source: Alpaca real-time snapshot, or Massive grouped daily bars — hover a cell for the actual source.", align: "right", sortValue: vwapDeltaPct,
    render: (q) => { const v = vwapDeltaPct(q); return typeof v === "number" ? <span className="tnum">{formatPct(v)}</span> : DASH; },
    cellClass: (q) => { const v = vwapDeltaPct(q); return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; },
    cellTitle: vwapTitle },
  { id: "volume", label: "Vol", title: "Shares traded today (falls back to the 10-day average when reported after hours). Source: screener / Finnhub.", align: "right", sortKey: "volume",
    render: (q) => (q.volume > 0 ? <span className="tnum text-muted">{compactNum(q.volume)}</span> : DASH),
    cellTitle: (q) => dataPointTitle("Volume", q.sources?.volume, q.asOf) },
  { id: "marketCap", label: "Mkt Cap", title: "Market capitalization = share price × shares outstanding.", align: "right", sortKey: "marketCap",
    render: (q) => (q.marketCap && q.marketCap > 0 ? <span className="tnum text-muted">{compactMoney(q.marketCap)}</span> : DASH),
    // marketCap = price × shares outstanding; no API emits it directly, so attribute to the price source.
    cellTitle: (q) => derivedTitle("Market capitalization = share price × shares outstanding.", "price × shares outstanding", q, ["price"]) },
  { id: "peRatio", label: "P/E", title: "Price-to-Earnings ratio = price ÷ trailing-12-month earnings per share; lower is cheaper relative to earnings. 'n/a' = negative/zero earnings (no meaningful ratio); '—' = no data. Source: Yahoo / FMP / Finnhub.", align: "right", sortKey: "peRatio",
    render: (q) => <span className="tnum text-muted">{q.peRatio && q.peRatio > 0 ? q.peRatio.toFixed(1) : typeof q.eps === "number" && q.eps <= 0 ? "n/a" : "—"}</span>, cellTitle: (q) => dataPointTitle("P/E ratio", q.sources?.peRatio, q.asOf) },
  { id: "fcfYield", label: "FCF%", title: "Free-cash-flow yield = trailing free cash flow ÷ market cap; higher means more cash generated per dollar of value. Source: Yahoo Finance.", align: "right", sortKey: "fcfYield",
    render: (q) => (typeof q.fcfYield === "number" ? <span className="tnum text-muted">{q.fcfYield.toFixed(1)}%</span> : DASH), cellTitle: (q) => dataPointTitle("Free-cash-flow yield", q.sources?.fcfYield, q.asOf) },
  { id: "debtToEquity", label: "D/E", title: "Debt-to-Equity = total debt ÷ shareholder equity; lower means less leverage. Source: Yahoo Finance.", align: "right", sortValue: normalizedDebtToEquity,
    render: (q) => { const de = normalizedDebtToEquity(q); return de !== undefined ? <span className="tnum text-muted">{de.toFixed(2)}</span> : DASH; }, cellTitle: (q) => dataPointTitle("Debt / equity", q.sources?.debtToEquity, q.asOf) },
  { id: "epsGrowth", label: "EPS gr", title: "Earnings-per-share growth, year over year (e.g. +15%). Source: Yahoo Finance.", align: "right", sortKey: "epsGrowth",
    render: (q) => (typeof q.epsGrowth === "number" ? <span className="tnum">{(q.epsGrowth * 100).toFixed(0)}%</span> : DASH), cellClass: (q) => (typeof q.epsGrowth === "number" ? (q.epsGrowth >= 0 ? "text-up" : "text-down") : ""), cellTitle: (q) => dataPointTitle("EPS growth (YoY)", q.sources?.epsGrowth, q.asOf) },
  { id: "dividendYield", label: "Div", title: "Annual dividend yield = trailing dividends per share ÷ price. Source: Yahoo / Finnhub.", align: "right", sortKey: "dividendYield",
    render: (q) => (typeof q.dividendYield === "number" ? <span className="tnum text-muted">{q.dividendYield.toFixed(2)}%</span> : DASH),
    cellTitle: (q) => dataPointTitle("Dividend yield", q.sources?.dividendYield, q.asOf) },
  // ── Backend-derived ratios (computed by us, not returned by any API). See src/lib/derived-metrics.ts. ──
  { id: "peg", label: "PEG", title: "[CALCULATED] PEG ratio = P/E ÷ EPS-growth%. <1 is cheap for its growth, >2 is expensive. Blank when unprofitable or no growth.", align: "right", sortValue: (q) => deriveMetrics(q).peg,
    render: (q) => { const v = deriveMetrics(q).peg; return typeof v === "number" ? <span className="tnum">{v.toFixed(2)}</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).peg; return typeof v === "number" ? (v < 1 ? "text-up" : v > 2.5 ? "text-down" : "") : ""; },
    cellTitle: (q) => derivedTitle("[CALCULATED] PEG ratio = P/E ÷ EPS-growth%. <1 is cheap for its growth, >2 is expensive.", "P/E and EPS growth", q, ["peRatio", "epsGrowth"]) },
  { id: "roe", label: "ROE", title: "[CALCULATED] Return on equity = EPS ÷ book value per share, where BVPS = price ÷ P/B. Higher = more efficient use of capital; negative = losing money on equity.", align: "right", sortValue: (q) => deriveMetrics(q).roe,
    render: (q) => { const v = deriveMetrics(q).roe; return typeof v === "number" ? <span className="tnum">{v.toFixed(1)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).roe; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Return on equity = EPS ÷ book value per share, where BVPS = price ÷ P/B.", "EPS, P/B and price", q, ["eps", "price"]) },
  { id: "earnYld", label: "Earn Yld", title: "[CALCULATED] Earnings yield = EPS ÷ price (the inverse of P/E). Usable when P/E is n/a; negative = the company is losing money.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).earnYld,
    render: (q) => { const v = deriveMetrics(q).earnYld; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(2)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).earnYld; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Earnings yield = EPS ÷ price (the inverse of P/E).", "EPS and price", q, ["eps", "price"]) },
  { id: "payout", label: "Payout", title: "[CALCULATED] Dividend payout ratio = dividends per share ÷ EPS. >100% means the dividend exceeds earnings and may be unsustainable.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).payout,
    render: (q) => { const v = deriveMetrics(q).payout; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(0)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).payout; return typeof v === "number" && v > 100 ? "text-down" : ""; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Dividend payout ratio = dividends per share ÷ EPS.", "dividend yield, EPS and price", q, ["dividendYield", "eps", "price"]) },
  { id: "dollarVolM", label: "$ Vol", title: "[CALCULATED] Daily dollar volume = price × volume — liquidity gauge for position sizing and slippage.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).dollarVolM,
    render: (q) => { const v = deriveMetrics(q).dollarVolM; return typeof v === "number" ? <span className="tnum text-muted">{compactMoney(v * 1e6)}</span> : DASH; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Daily dollar volume = price × volume — liquidity gauge for sizing and slippage.", "price and volume", q, ["price", "volume"]) },
  { id: "spreadBps", label: "Spread", title: "[CALCULATED] Bid-ask spread in basis points = (ask − bid) ÷ mid × 10000 — execution cost; wide spreads favor limit orders.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).spreadBps,
    render: (q) => { const v = deriveMetrics(q).spreadBps; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(1)}</span> : DASH; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Bid-ask spread in basis points = (ask − bid) ÷ mid × 10000 — execution cost.", "bid and ask", q, ["bid", "ask"]) },
  { id: "sectorRelStrength", label: "Sec RS", title: "[CALCULATED] Sector relative strength = this name's intraday % move minus the average move of its sector among the scan candidates. Positive = outperforming its sector today.", align: "right", defaultHidden: true, sortKey: "sectorRelStrength",
    render: (q) => (typeof q.sectorRelStrength === "number" ? <span className="tnum">{q.sectorRelStrength >= 0 ? "+" : ""}{q.sectorRelStrength.toFixed(2)}%</span> : DASH),
    cellClass: (q) => (typeof q.sectorRelStrength === "number" ? (q.sectorRelStrength >= 0 ? "text-up" : "text-down") : ""),
    cellTitle: (q) => derivedTitle("[CALCULATED] Sector relative strength = this name's intraday % move minus the average move of its sector among scan candidates.", "intraday change and sector", q, ["intradayChangePct", "sector"]) },
  { id: "marginOfSafety", label: "MoS", title: "[CALCULATED] Margin of safety = (Graham value − price) ÷ price, where Graham value = √(22.5 × EPS × book value per share). Positive = trading below intrinsic value.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).marginOfSafety,
    render: (q) => { const v = deriveMetrics(q).marginOfSafety; return typeof v === "number" ? <span className="tnum">{v >= 0 ? "+" : ""}{v.toFixed(0)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).marginOfSafety; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Margin of safety = (Graham value − price) ÷ price, where Graham value = √(22.5 × EPS × book value per share).", "EPS, P/B and price", q, ["eps", "price"]) },
  { id: "pctFromHigh", label: "% off Hi", title: "[CALCULATED] % from the 52-week high = (price − 52w high) ÷ high. 0 = at the high (breakout zone); deeply negative = a large pullback.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).pctFromHigh,
    render: (q) => { const v = deriveMetrics(q).pctFromHigh; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(1)}%</span> : DASH; },
    cellTitle: (q) => derivedTitle("[CALCULATED] % from the 52-week high = (price − 52w high) ÷ high.", "price and 52-week high", q, ["price"]) },
  { id: "rr52w", label: "R:R", title: "[CALCULATED] Reward:risk to the 52-week band = (52w high − price) ÷ (price − 52w low). >1 = more upside room to the high than downside to the low.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).rr52w,
    render: (q) => { const v = deriveMetrics(q).rr52w; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(2)}</span> : DASH; },
    cellTitle: (q) => derivedTitle("[CALCULATED] Reward:risk to the 52-week band = (52w high − price) ÷ (price − 52w low).", "price and the 52-week high/low band", q, ["price"]) },
  // shortPercentOfFloat / beta carry no per-field provenance in EnrichmentSources, so we stamp
  // the value's freshness (asOf) but never fabricate a provider for them.
  { id: "shortPercentOfFloat", label: "Short %", title: "Percent of the tradable float sold short. High (>15–20%) raises short-squeeze potential but also signals bearish positioning. Source: Yahoo Finance.", align: "right", defaultHidden: true, sortKey: "shortPercentOfFloat",
    render: (q) => (typeof q.shortPercentOfFloat === "number" ? <span className="tnum text-muted">{q.shortPercentOfFloat.toFixed(1)}%</span> : DASH),
    cellTitle: (q) => dataPointTitle("Short % of float", undefined, q.asOf) },
  { id: "beta", label: "Beta", title: "Beta — sensitivity to the broad market (1.0 = moves with the market; >1 amplifies moves, <1 dampens them). Source: Yahoo Finance.", align: "right", defaultHidden: true, sortKey: "beta",
    render: (q) => (typeof q.beta === "number" ? <span className="tnum text-muted">{q.beta.toFixed(2)}</span> : DASH),
    cellTitle: (q) => dataPointTitle("Beta", undefined, q.asOf) },
  { id: "bid", label: "Bid", title: "Best bid — the highest price a buyer is currently willing to pay. Shown when broker quotes are available.", align: "right", defaultHidden: true, sortKey: "bid",
    render: (q) => (typeof q.bid === "number" ? <span className="tnum text-muted">{money(q.bid)}</span> : DASH),
    cellTitle: (q) => dataPointTitle("Best bid", q.sources?.bid, q.asOf) },
  { id: "ask", label: "Ask", title: "Best ask — the lowest price a seller is currently willing to accept. Shown when broker quotes are available.", align: "right", defaultHidden: true, sortKey: "ask",
    render: (q) => (typeof q.ask === "number" ? <span className="tnum text-muted">{money(q.ask)}</span> : DASH),
    cellTitle: (q) => dataPointTitle("Best ask", q.sources?.ask, q.asOf) },
  { id: "sentiment", label: "Sentiment", title: "News sentiment 0–100 (50 = neutral), scored from recent headlines with keyword/NLP analysis. Source: Alpha Vantage / Finnhub.", sortKey: "sentiment",
    render: (q) => (typeof q.sentiment === "number" ? <SentimentChip value={q.sentiment} /> : DASH), cellTitle: (q) => sentimentTitle(q) },
  { id: "analystScore", label: "Rating", title: "Analyst consensus 0–100, blended across providers (Strong Buy = 100 … Strong Sell = 0). Source: Yahoo / FMP / Finnhub.", sortKey: "analystScore",
    render: (q) => (q.analystRating ? <RatingChip score={q.analystScore} label={q.analystRating} /> : DASH), cellTitle: (q) => ratingTitle(q) },
  { id: "senateTrades", label: "Congress", title: "Net recent congressional trades = distinct members buying minus selling over the last ~60 days; positive = net buying (a positioning tailwind). Source: configured congressional-trade feeds. Hover a cell for the disclosures.", align: "right", sortKey: "senateTrades",
    render: (q) => (typeof q.senateTrades === "number" ? <span className="tnum">{q.senateTrades > 0 ? `+${q.senateTrades}` : q.senateTrades}</span> : DASH), cellClass: (q) => (typeof q.senateTrades === "number" && q.senateTrades !== 0 ? (q.senateTrades > 0 ? "text-up" : "text-down") : ""), cellTitle: (q) => q.evidenceBulletins?.join("\n") || "No recent congressional disclosures for this symbol." },
  { id: "sector", label: "Sector", title: "Company sector classification. Source: Yahoo / Finnhub.", defaultHidden: true, sortKey: "sector",
    render: (q) => (q.sector ? <Chip tone="info">{q.sector}</Chip> : DASH),
    cellTitle: (q) => dataPointTitle("Sector", q.sources?.sector, q.asOf) },
  { id: "score", label: "Score", title: "Composite 0–100 score = weighted blend of liquidity, momentum, value, quality, volatility, sentiment & diversification factors. Adjust the weights on the Strategy tab.", align: "right", sortKey: "score",
    render: (q) => <span className="tnum font-semibold text-fg">{q.score.toFixed(1)}</span>,
    // Composite of many scored factors; attribute to the underlying input fields' providers, never a single invented source.
    cellTitle: (q) => derivedTitle("[CALCULATED] Composite 0–100 score = weighted blend of liquidity, momentum, value, quality, volatility, sentiment & diversification factors (weights on the Strategy tab).", "the scan's per-factor inputs", q, ["price", "volume", "intradayChangePct", "peRatio", "sentiment"]) }
];

// Default-visible columns — chosen by UI + market specialists for fast triage:
// identity → verdict → price action → relative strength/execution cost → sector/value/growth/news.
// The order in this list is rendered directly; hidden columns stay available in Configure columns.
const DEFAULT_SCAN_COLS = ["symbol", "score", "price", "intradayChangePct", "sector", "sectorRelStrength", "vsVwap", "dollarVolM", "spreadBps", "peRatio", "epsGrowth", "fcfYield", "sentiment", "senateTrades"];
// v5: Sector is visible before Sec RS by default, and the chooser persists column order.
const SCAN_COLS_KEY = "scan-visible-cols-v5";

function MarketScanView({
  snapshot,
  onDrilldown,
  onConfigureUniverse,
  onConfigureScanSettings,
  tickerLogoDisplay
}: {
  snapshot: DashboardSnapshot;
  onDrilldown: (q: MarketQuote) => void;
  onConfigureUniverse: () => void;
  onConfigureScanSettings: () => void;
  tickerLogoDisplay: TickerLogoDisplay;
}) {
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: "score", dir: "desc" });
  const [visible, setVisible] = useState<string[]>(DEFAULT_SCAN_COLS);
  const [colsOpen, setColsOpen] = useState(false);
  const [scanDetailsOpen, setScanDetailsOpen] = useState(false);
  const [liveScan, setLiveScan] = useState<MarketScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanCheckedAt, setScanCheckedAt] = useState(0);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SCAN_COLS_KEY);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr) && arr.length > 0) setVisible(arr.filter((id) => SCAN_COLUMNS.some((c) => c.id === id)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  function saveVisibleColumns(next: string[]) {
    setVisible(next);
    try {
      localStorage.setItem(SCAN_COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  function toggleCol(id: string) {
    if (id === "symbol") return; // symbol is always shown, but can still be reordered.
    const next = visible.includes(id) ? visible.filter((c) => c !== id) : [...visible, id];
    saveVisibleColumns(next);
  }

  function moveCol(id: string, delta: -1 | 1) {
    const from = visible.indexOf(id);
    if (from === -1) return;
    const to = Math.max(0, Math.min(visible.length - 1, from + delta));
    if (from === to) return;
    const next = visible.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    saveVisibleColumns(next);
  }

  function resetScanColumns() {
    saveVisibleColumns(DEFAULT_SCAN_COLS);
  }

  const refreshScan = useCallback(async () => {
    const checkedAt = Date.now();
    setScanLoading(true);
    setScanError("");
    setScanCheckedAt(checkedAt);
    try {
      const res = await fetch("/api/scan");
      if (!res.ok) throw await responseError(res, "Market scan failed");
      const data = (await res.json()) as MarketScan;
      if (data && Array.isArray(data.topCandidates)) setLiveScan(data);
    } catch (error) {
      // A network-level fetch rejection surfaces an unhelpful, browser-specific message
      // ("Load failed" on WebKit/Safari, "Failed to fetch" on Chromium). Translate those to a
      // plain sentence; pass through real server messages (a non-OK response with body text).
      const raw = error instanceof Error ? error.message : "";
      const isNetwork = /load failed|failed to fetch|networkerror|the network connection was lost|aborted/i.test(raw);
      setScanError(isNetwork ? "Couldn't reach the scan service." : plainAppError(raw, "Market scan failed."));
    } finally {
      setScanLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshScan();
  }, [refreshScan]);

  const scan = liveScan ?? snapshot.latestStrategyRun?.marketScan;
  if (!scan) {
    return (
      <Card>
        <PanelHeader
          title="Market Scan"
          subtitle={scanError || undefined}
          icon={<LineChartIcon size={16} />}
          actions={
            <div className="flex items-center gap-1.5">
              <IconButton label="Scan settings" onClick={onConfigureScanSettings}>
                <SlidersHorizontal size={14} />
              </IconButton>
              <IconButton label="Run scan" onClick={() => void refreshScan()} disabled={scanLoading}>
                <RefreshCw size={14} className={cn(scanLoading && "animate-spin")} />
              </IconButton>
            </div>
          }
        />
        <EmptyState
          icon={<LineChartIcon size={20} />}
          title={scanLoading ? "Scanning The Market…" : "No Market Scan Yet"}
          hint={scanError || (scanLoading ? "Fetching quotes and enrichment data…" : "Choose a base index or add symbols, then refresh the scan.")}
        />
        <div className="flex justify-center px-4 pb-4">
          <Button variant="ghost" size="sm" onClick={onConfigureUniverse}><SettingsIcon size={14} /> Configure universe</Button>
        </div>
      </Card>
    );
  }
  const cols = visible
    .map((id) => SCAN_COLUMNS.find((c) => c.id === id))
    .filter((column): column is ScanColumn => Boolean(column));
  const columnChooserRows = [
    ...cols,
    ...SCAN_COLUMNS.filter((column) => !visible.includes(column.id))
  ];
  // The quote `asOf` is a display string, not a timestamp; the scan's ISO generatedAt
  // is the real "received" time for every value in this table.
  const dataReceived = receivedLabel(scan.generatedAt);
  const sortCol = SCAN_COLUMNS.find((c) => c.id === sort.col);
  const sorted = sortCol
    ? [...scan.topCandidates].sort((a, b) => compare(scanSortValue(sortCol, a), scanSortValue(sortCol, b), sort.dir))
    : [...scan.topCandidates];
  const scanSources = formatScanSources(scan.source);
  const freshness = liveScan ? "Live" : scan.cached ? "Cached" : "Latest";
  const candidateLimit = scan.candidateLimit ?? snapshot.policy.marketScanCandidateLimit ?? DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT;
  const outlierCount = scan.outlierCandidateCount ?? 0;
  const candidateSummary = `${scan.topCandidates.length}/${candidateLimit} candidates${outlierCount > 0 ? ` · ${outlierCount} outlier${outlierCount === 1 ? "" : "s"}` : ""}`;
  const subtitle = scan.returnedQuotes === 0
    ? `No quotes returned · ${freshness}`
    : `${scan.returnedQuotes} quotes · ${candidateSummary} · ${freshness}${scanSources ? ` · Sources: ${scanSources}` : ""}`;
  const scanWarningText = scan.warnings && scan.warnings.length > 0
    ? scan.warnings.length === 1
      ? scan.warnings[0]
      : `${scan.warnings[0]} (${scan.warnings.length - 1} more warning${scan.warnings.length === 2 ? "" : "s"})`
    : "";
  const scanAgeMs = scanCheckedAt > 0 ? scanCheckedAt - Date.parse(scan.generatedAt) : Number.NaN;
  const scanTime = new Date(scan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const scanFallbackText = scanError
    ? Number.isFinite(scanAgeMs) && scanAgeMs >= 0 && scanAgeMs < 15 * 60_000
      ? `Fresh scan refresh failed; still showing the recent scan from ${scanTime}.`
      : `${scanError} Showing the last scan from ${scanTime}.`
    : "";
  const mobileSubtitle = scan.returnedQuotes === 0
    ? "No quotes returned"
    : `${scan.returnedQuotes} quotes`;
  return (
    <Card className="overflow-hidden">
      <PanelHeader
        title="Market Scan"
        subtitle={<>
          <span className="hidden sm:inline">{subtitle}</span>
          <span className="inline sm:hidden">{mobileSubtitle}</span>
        </>}
        icon={<LineChartIcon size={16} />}
        actions={
          <div className="flex items-center gap-1.5">
            <IconButton label={`Scan settings: ${scan.candidateLimit ?? snapshot.policy.marketScanCandidateLimit ?? DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT} candidates, ${scan.outlierReserve ?? snapshot.policy.marketScanOutlierReserve ?? DEFAULT_MARKET_SCAN_OUTLIER_RESERVE} outlier reserve`} onClick={onConfigureScanSettings}>
              <SlidersHorizontal size={14} />
            </IconButton>
            <Chip tone="neutral">{new Date(scan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Chip>
            <IconButton label="Refresh scan" onClick={() => void refreshScan()} disabled={scanLoading}>
              <RefreshCw size={14} className={cn(scanLoading && "animate-spin")} />
            </IconButton>
            <div className="relative">
              <IconButton label="Configure columns" onClick={() => setColsOpen((v) => !v)}>
                <Columns3 size={14} />
              </IconButton>
              {colsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 max-h-[60vh] w-72 overflow-auto rounded-lg border border-line bg-surface/50 backdrop-blur-xl p-1.5 shadow-[var(--shadow-lg)]">
                    <div className="flex items-center justify-between gap-2 px-2 py-1">
                      <p className="text-[11px] font-semibold uppercase text-faint">Columns</p>
                      <button type="button" onClick={resetScanColumns} className="text-[11px] font-medium text-muted hover:text-fg">Reset</button>
                    </div>
                    {columnChooserRows.map((c) => {
                      const isVisible = visible.includes(c.id);
                      const index = visible.indexOf(c.id);
                      return (
                        <div key={c.id} className={cn("grid grid-cols-[1fr_auto] items-center gap-2 rounded px-2 py-1 text-[13px] text-muted hover:bg-surface-2/50 backdrop-blur-lg", !isVisible && "opacity-70")} title={c.title}>
                          <label className={cn("flex min-w-0 items-center gap-2", c.id === "symbol" ? "opacity-70" : "cursor-pointer")}>
                            <input type="checkbox" checked={isVisible} onChange={() => toggleCol(c.id)} disabled={c.id === "symbol"} className="accent-[var(--accent)]" />
                            <span className="truncate">{c.label}</span>
                          </label>
                          <div className="flex items-center gap-1">
                            {isVisible && (
                              <>
                                <button
                                  type="button"
                                  aria-label={`Move ${c.label} earlier`}
                                  onClick={() => moveCol(c.id, -1)}
                                  disabled={index <= 0}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-fg disabled:opacity-30"
                                >
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  type="button"
                                  aria-label={`Move ${c.label} later`}
                                  onClick={() => moveCol(c.id, 1)}
                                  disabled={index === visible.length - 1}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-surface-3 hover:text-fg disabled:opacity-30"
                                >
                                  <ArrowDown size={14} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        }
      />
      {/* Mobile-only: collapsible scan details row (hidden on sm+) */}
      <div className="sm:hidden px-4 pt-1 pb-0.5">
        <button
          type="button"
          onClick={() => setScanDetailsOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-muted transition-colors"
          aria-expanded={scanDetailsOpen}
        >
          <ChevronDown size={14} className={cn("transition-transform", scanDetailsOpen && "rotate-180")} />
          Scan details
        </button>
        {scanDetailsOpen && (
          <p className="mt-1 text-[11px] text-faint leading-relaxed">{subtitle}</p>
        )}
      </div>
      {scanError && (
        // We're past the no-data guard, so the table below is showing a valid (captured/last)
        // scan — a failed live refresh is non-critical here. Show a subtle muted note, not an
        // alarming red banner, so "Couldn't reach the scan service" never contradicts a populated
        // table (the previous behavior the user flagged).
        <p className="mx-4 mt-3 rounded-lg border border-line bg-surface-2/40 px-3 py-1.5 text-[12px] text-faint">
          {scanFallbackText}
        </p>
      )}
      {scan.warnings && scan.warnings.length > 0 && (
        <p className="mx-4 mt-3 rounded-lg border border-warn/25 bg-warn/10 px-3 py-1.5 text-[12px] text-warn" title={scan.warnings.join("\n")}>
          {scanWarningText}
        </p>
      )}
      {sorted.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState
            icon={<LineChartIcon size={20} />}
            title="No Scan Quotes"
            hint="The current universe is empty or no provider returned quotes. Choose a base index or add symbols, then refresh the scan."
          />
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" onClick={onConfigureUniverse}><SettingsIcon size={14} /> Configure universe</Button>
          </div>
        </div>
      ) : (
        <div className="h-[min(600px,65vh)] overflow-x-auto p-2">
          <TableVirtuoso
            data={sorted}
            overscan={600}
            initialItemCount={Math.min(sorted.length, 20)}
            components={{
              Table: (props) => <table {...props} className="w-full min-w-max text-[13px]" />,
              TableHead: React.forwardRef((props, ref) => <thead {...props} ref={ref} className="bg-surface/50 backdrop-blur-xl" />),
              TableRow: (props) => <tr {...props} onClick={() => onDrilldown(props.item)} className="group cursor-pointer border-b border-line/50 transition-colors hover:bg-surface-2/50" />,
            }}
            fixedHeaderContent={() => (
              <tr className="border-b border-line bg-surface/50 text-[11px] uppercase text-faint shadow-sm backdrop-blur-xl">
                {cols.map((c) => (
                  <th
                    key={c.id}
                    title={c.title}
                    onClick={() => setSort((s) => ({ col: c.id, dir: s.col === c.id && s.dir === "desc" ? "asc" : "desc" }))}
                    className={cn(
                      "cursor-pointer select-none whitespace-nowrap px-2.5 py-2 font-semibold hover:text-fg",
                      c.align === "right" ? "text-right" : "text-left"
                    )}
                  >
                    {c.label}
                    <span className="ml-0.5 text-faint">{sort.col === c.id ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                  </th>
                ))}
              </tr>
            )}
            itemContent={(index, q) => (
              <>
                {cols.map((c) => {
                  const cellTip = c.cellTitle?.(q);
                  // Stamp the scan-level "Received …" only when the cell's own tooltip doesn't already
                  // carry a per-field "Received …" line (dataPointTitle/derivedTitle add one from q.asOf
                  // when it's a real ISO time) — avoids a duplicate received stamp on the same tooltip.
                  const tip = [cellTip, cellTip?.includes("Received ") ? undefined : dataReceived]
                    .filter(Boolean)
                    .join("\n") || undefined;
                  return (
                  <td
                    key={c.id}
                    title={tip}
                    className={cn(
                      "px-2.5 py-1.5",
                      c.align === "right" && "text-right",
                      c.cellClass?.(q)
                    )}
                  >
                    {c.id === "symbol" ? (
                      <SymbolButton symbol={q.symbol} quote={q} onDrilldown={onDrilldown} className="font-semibold text-fg" title={q.companyName ?? "Open symbol intelligence"} logoDisplay={tickerLogoDisplay} showLogo />
                    ) : (
                      c.render(q)
                    )}
                  </td>
                  );
                })}
              </>
            )}
          />
        </div>
      )}
    </Card>
  );
}

function SentimentChip({ value }: { value: number }) {
  const tone = value >= 60 ? "up" : value <= 40 ? "down" : "neutral";
  const label = value >= 60 ? "Positive" : value <= 40 ? "Negative" : "Neutral";
  return <Chip tone={tone}>{label} · {value}</Chip>;
}

function freshness(fetchedAt?: string): string {
  if (!fetchedAt) return "never";
  const mins = Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/** Maps raw trade-source keys to display labels for the Congressional / Insider subtitles. */
function formatTradeSource(key: string): string {
  switch (key) {
    case "congress.trade": return "Congress.Trade";
    case "senate-efd": return "Senate eFD";
    case "capitol-trades": return "Capitol Trades";
    case "apify-congress": return "Apify";
    case "sec-edgar":
    case "edgar": return "SEC EDGAR";
    default: return key;
  }
}

/** Returns a compact date range string from an array of ISO date strings.
 *  "" for empty, single date for one entry, "MMM D – MMM D YYYY" within a year,
 *  or "MMM YYYY – MMM YYYY" across years. */
function formatDateRange(isoDates: string[]): string {
  if (isoDates.length === 0) return "";
  const dates = isoDates
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return "";
  // Date-only ISO strings parse as UTC midnight, so format in UTC too — otherwise US time zones
  // (west of UTC) render the day before, e.g. "2026-06-26" -> "Jun 25".
  const fmt = (d: Date, includeYear: boolean) =>
    d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}) });
  const min = dates[0];
  const max = dates[dates.length - 1];
  if (min.getTime() === max.getTime()) {
    return fmt(min, true);
  }
  if (min.getUTCFullYear() === max.getUTCFullYear()) {
    return `${fmt(min, false)} – ${fmt(max, true)}`;
  }
  const fmtMonth = (d: Date) =>
    d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
  return `${fmtMonth(min)} – ${fmtMonth(max)}`;
}

/** Surfaces the full scraped congressional + insider datasets (the scan's Congress column
 *  only shows symbols that overlap the scan; this shows everything recently disclosed). */
function SmartMoneyView({ snapshot, scan, onDrilldown, tickerLogoDisplay }: { snapshot: DashboardSnapshot; scan: MarketScan | null; onDrilldown: (q: MarketQuote) => void; tickerLogoDisplay: TickerLogoDisplay }) {
  const sm = snapshot.smartMoney;
  const ws = snapshot.webSources;
  const congress = sm?.congress ?? [];
  const insider = sm?.insider ?? [];
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="overflow-hidden">
        <PanelHeader
          title="Congressional Trades"
          subtitle={ws?.congress ? `${ws.congress.recordCount} on file${congress.length > 0 ? ` · ${formatDateRange(congress.map((t) => t.tradedAt))}` : ""} · ${ws.congress.sources.map(formatTradeSource).join(" + ") || "—"} · ${freshness(ws.congress.fetchedAt)}` : "Congressional trade feeds"}
          icon={<Landmark size={16} />}
        />
        {congress.length === 0 ? (
          <EmptyState icon={<Landmark size={20} />} title="No Disclosures Cached Yet" hint="The connector refreshes daily in the background; check back after the next refresh." />
        ) : (
          <div className="max-h-72 overflow-auto p-2 pb-3">
            {congress.map((t, i) => (
              <div key={`${t.symbol}-${t.member}-${t.tradedAt}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                <Chip tone={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "BUY" : "SELL"}</Chip>
                <SymbolButton symbol={t.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(t.symbol, snapshot.symbolMetaBySymbol ?? {})} logoDisplay={tickerLogoDisplay} showLogo />
                <span className="truncate text-muted" title={`${t.member} (${t.chamber})`}>{t.member}</span>
                <span className="ml-auto whitespace-nowrap text-faint">{t.tradedAt}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <PanelHeader
          title="Insider (Form 4) Activity"
          subtitle={ws?.insider ? `${ws.insider.recordCount} on file${insider.length > 0 ? ` · ${formatDateRange(insider.map((f) => f.filedAt))}` : ""} · SEC EDGAR · ${freshness(ws.insider.fetchedAt)}` : "SEC EDGAR — open-market buys/sells only"}
          icon={<Shield size={16} />}
        />
        {insider.length === 0 ? (
          <EmptyState icon={<Shield size={20} />} title="No Insider Filings Cached Yet" hint="Open-market Form 4 buys/sells accumulate here as they're filed." />
        ) : (
          <div className="max-h-72 overflow-auto p-2 pb-3">
            {insider.map((f, i) => {
              const net = f.buyTx - f.sellTx;
              return (
                <div key={`${f.symbol}-${f.owner}-${f.filedAt}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                  <Chip tone={net > 0 ? "up" : net < 0 ? "down" : "neutral"}>{net > 0 ? "BUY" : net < 0 ? "SELL" : "MIXED"}</Chip>
                  <SymbolButton symbol={f.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(f.symbol, snapshot.symbolMetaBySymbol ?? {})} logoDisplay={tickerLogoDisplay} showLogo />
                  <span className="truncate text-muted" title={f.owner}>{f.owner}</span>
                  <span className="ml-auto whitespace-nowrap text-faint">{f.filedAt}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function RatingChip({ score, label }: { score?: number; label: string }) {
  // Mirror the Sentiment chip: green for Buy-ish, red for Sell-ish, neutral for Hold.
  const tone = score === undefined ? "neutral" : score >= 65 ? "up" : score <= 40 ? "down" : "neutral";
  return <Chip tone={tone}>{typeof score === "number" ? `${label} · ${score}` : label}</Chip>;
}

/** Map the raw market session to a status label + dot tone (green open, grey closed). */
function marketStatusFor(session?: string): { tone: "up" | "warn" | "neutral"; label: string } {
  switch (session) {
    case "regular":
      return { tone: "up", label: "Market Open" };
    case "pre":
      return { tone: "warn", label: "Pre-market" };
    case "post":
      return { tone: "warn", label: "After-hours" };
    default:
      return { tone: "neutral", label: "Market Closed" };
  }
}

/* ───────────────────────── Performance view ───────────────────────── */

function PerformanceView({
  snapshot,
  mode,
  modeLabel,
  symbolMetaBySymbol
}: {
  snapshot: DashboardSnapshot;
  mode: "paper" | "live";
  modeLabel: string;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  const perf = snapshot.performance;
  const curve = mode === "paper" ? perf?.paperEquityCurve ?? [] : perf?.liveEquityCurve ?? [];
  const realizedGross = mode === "paper" ? perf?.paperRealizedPnl ?? 0 : perf?.liveRealizedPnl ?? 0;
  // Optionally net realized P&L of the estimated tax burden (toggle in Settings → Tax).
  const subtractTax = Boolean(snapshot.policy.taxSettings?.subtractFromResults && snapshot.tax);
  const taxBurden = subtractTax ? snapshot.tax!.estimatedTaxLiability : 0;
  const realized = realizedGross - taxBurden;
  const trackedUnrealized = mode === "paper" ? perf?.paperUnrealizedPnl ?? 0 : perf?.liveUnrealizedPnl ?? 0;
  const currentPositionUnrealized = snapshot.positions.reduce((sum, position) => {
    if (!(position.averageCost > 0) || !Number.isFinite(position.marketValue) || !Number.isFinite(position.quantity)) return sum;
    return sum + (position.marketValue - position.averageCost * position.quantity);
  }, 0);
  const unrealized = snapshot.positions.length > 0 ? currentPositionUnrealized : trackedUnrealized;
  const winRate = mode === "paper" ? perf?.paperWinRate ?? 0 : perf?.liveWinRate ?? 0;
  const avgReturn = mode === "paper" ? perf?.paperAverageReturnPct ?? 0 : perf?.liveAverageReturnPct ?? 0;
  const benchmark = perf?.benchmark;
  const thesis = (snapshot.thesisScorecard ?? []).map((t) => ({ label: t.thesisTag, pnl: t.totalPnl, winRate: t.winRate, trades: t.trades, avgDaysHeld: t.avgDaysHeld, shortTermPct: t.shortTermPct }));
  const regime = (snapshot.regimeScorecard ?? []).map((r) => ({ label: r.regime, pnl: r.totalPnl, winRate: r.winRate, trades: r.trades, avgDaysHeld: r.avgDaysHeld, shortTermPct: r.shortTermPct }));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader title="Equity" subtitle={`${modeLabel} account`} icon={<TrendingUp size={16} />} />
        <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-4">
          <StatTile label={subtractTax ? "Realized (after est. tax)" : "Realized"} value={signedMoney(realized)} tone={pnlTone(realized)} sub={subtractTax ? `−${money(taxBurden)} est. tax` : undefined} title="Profit/loss locked in by closing positions (FIFO matched). Toggle after-tax in Settings → Tax." />
          <StatTile label="Unrealized" value={signedMoney(unrealized)} tone={pnlTone(unrealized)} title={`${modeLabel} gain/loss on current open positions, marked to current prices. Realized learning stats below still use closed app-recorded lots.`} />
          <StatTile label="Win rate" value={`${winRate.toFixed(0)}%`} title="Share of closed lots that were profitable." />
          <StatTile label="Avg return" value={`${avgReturn.toFixed(2)}%`} tone={pnlTone(avgReturn)} title="Average percentage return per closed lot." />
        </div>
        <div className="h-64 p-4">
          <EquityCurve data={curve} />
        </div>
        {benchmark ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 pb-4 text-xs">
            <span className={`font-medium ${benchmark.excessReturnPct >= 0 ? "text-up" : "text-down"}`}>
              {benchmark.excessReturnPct >= 0 ? "+" : ""}{benchmark.excessReturnPct.toFixed(1)}% vs {benchmark.benchmarkSymbol}
            </span>
            <span className="text-faint">
              (you {benchmark.accountReturnPct >= 0 ? "+" : ""}{benchmark.accountReturnPct.toFixed(1)}% · {benchmark.benchmarkSymbol} {benchmark.benchmarkReturnPct >= 0 ? "+" : ""}{benchmark.benchmarkReturnPct.toFixed(1)}%, {benchmark.startDate}→{benchmark.endDate})
            </span>
            <span className="text-faint/85" title="Compares equity growth from the first snapshot date. Not adjusted for deposits/withdrawals.">ⓘ</span>
          </div>
        ) : null}
      </Card>

      <Card>
        <PanelHeader title="What's Working — By Thesis" subtitle="Realized P&L grouped by trade thesis (the learning loop)" icon={<BrainCircuit size={16} />} />
        <div className="p-4 pt-3">
          <ScorecardBars data={thesis} />
        </div>
      </Card>

      <Card>
        <PanelHeader title="By Market Regime" subtitle="Realized P&L grouped by entry regime" icon={<Gauge size={16} />} />
        <div className="p-4 pt-3">
          <ScorecardBars data={regime} />
        </div>
      </Card>
    </div>
  );
}

/* ───────────────────────── Tax view (tab) ───────────────────────── */

function TaxView({
  snapshot,
  symbolMetaBySymbol,
  scan,
  onDrilldown,
  tickerLogoDisplay
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
  tickerLogoDisplay: TickerLogoDisplay;
}) {
  const tax = snapshot.tax;
  if (!tax) {
    return (
      <Card>
        <PanelHeader title="Tax" icon={<Landmark size={16} />} />
        <EmptyState icon={<Landmark size={20} />} title="No Tax Data Yet" hint="Select an account and run the strategy; realized gains and lots appear here." />
      </Card>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader
          title={`Tax overview · ${tax.taxYear}`}
          subtitle="Rough estimates only — not tax advice. Consult a CPA."
          icon={<Landmark size={16} />}
          actions={<Chip tone={tax.settings.washSaleGuard ? "up" : "warn"}>Wash-sale guard {tax.settings.washSaleGuard ? "on" : "off"}</Chip>}
        />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 sm:grid-cols-4">
          <StatTile label="Short-term realized" value={signedMoney(tax.shortTermRealized)} tone={pnlTone(tax.shortTermRealized)} sub={`taxed ~${tax.settings.shortTermRatePct}% (ordinary)`} />
          <StatTile label="Long-term realized" value={signedMoney(tax.longTermRealized)} tone={pnlTone(tax.longTermRealized)} sub={`taxed ~${tax.settings.longTermRatePct}%`} />
          <StatTile label="Est. tax liability" value={money(tax.estimatedTaxLiability)} tone={tax.estimatedTaxLiability > 0 ? "down" : "neutral"} sub="this year, on realized gains" />
          <StatTile label="Disallowed (wash sale)" value={money(tax.disallowedWashSaleLoss)} tone={tax.disallowedWashSaleLoss > 0 ? "warn" : "neutral"} sub="losses you can't deduct" />
        </div>
      </Card>

      <Card>
        <PanelHeader title="Wash-Sale Lockout" subtitle="Rebuying these is blocked 30 days after a loss sale" icon={<Shield size={16} />} />
        <div className="space-y-3 p-4 pt-3">
          {tax.lockedSymbols.length === 0 ? (
            <EmptyState icon={<Shield size={ICON.lg} />} title="No Symbols Locked Out" hint="Symbols become blocked for 30 days after a loss sale to avoid a wash sale." />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tax.lockedSymbols.map((s) => (
                <Chip key={s} tone="down">
                  <SymbolButton symbol={s} scan={scan} onDrilldown={onDrilldown} variant="chip" title={companyTitle(s, symbolMetaBySymbol)} />
                </Chip>
              ))}
            </div>
          )}
          {tax.washSales.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-3">
              <span className="text-xs font-medium text-muted">Wash sales detected this year</span>
              {tax.washSales.slice(0, 6).map((w, i) => (
                <div key={`${w.symbol}-${i}`} className="flex items-center justify-between text-[13px]">
                  <SymbolButton symbol={w.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(w.symbol, symbolMetaBySymbol)} logoDisplay={tickerLogoDisplay} showLogo />
                  <span className="tnum text-faint">{new Date(w.soldAt).toLocaleDateString()} · {money(w.disallowedLoss)} disallowed</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <PanelHeader title="Tax-Loss Harvest Candidates" subtitle="Unrealized losers that could offset realized gains" icon={<Percent size={16} />} />
        <div className="p-4 pt-3">
          {tax.harvestCandidates.length === 0 ? (
            <EmptyState icon={<Percent size={ICON.lg} />} title="No Harvestable Losses" hint="Unrealized losers that could offset realized gains will appear here." />
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {tax.harvestCandidates.map((h) => (
                  <tr key={h.symbol} className="border-b border-line/50">
                    <td className="py-1.5 font-semibold text-fg"><SymbolButton symbol={h.symbol} scan={scan} onDrilldown={onDrilldown} title={companyTitle(h.symbol, symbolMetaBySymbol)} logoDisplay={tickerLogoDisplay} showLogo /></td>
                    <td className="py-1.5 text-right tnum text-muted">{formatShareQuantity(h.quantity, h.symbol)} sh</td>
                    <td className="py-1.5 text-right tnum text-down">{signedMoney(h.unrealizedLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <PanelHeader title="Holding Period — Days To Long-Term" subtitle="Crossing 1 year flips gains from ordinary to long-term rates" icon={<Hourglass size={16} />} />
        <div className="min-h-0 overflow-auto p-2">
          {tax.openLots.length === 0 ? (
            <EmptyState icon={<Hourglass size={20} />} title="No Open Lots" />
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase text-faint">
                  <th className="px-2 py-1.5 text-left font-semibold">Symbol</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Days held</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Progress to long-term</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {tax.openLots.map((lot, i) => (
                  <tr key={`${lot.symbol}-${i}`} className="border-b border-line/50">
                    <td className="px-2 py-1.5 font-semibold text-fg"><SymbolButton symbol={lot.symbol} scan={scan} onDrilldown={onDrilldown} title={companyTitle(lot.symbol, symbolMetaBySymbol)} logoDisplay={tickerLogoDisplay} showLogo /></td>
                    <td className="px-2 py-1.5 text-right tnum text-muted">{formatShareQuantity(lot.quantity, lot.symbol)}</td>
                    <td className="px-2 py-1.5 text-right tnum text-muted">{lot.daysHeld}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3/50 backdrop-blur-md">
                          <span className={cn("block h-full rounded-full", lot.isLongTerm ? "bg-up" : "bg-info")} style={{ width: `${Math.min(100, (lot.daysHeld / 365) * 100)}%` }} />
                        </span>
                        <span className="tnum text-[11px] text-faint">{lot.isLongTerm ? "—" : `${lot.daysToLongTerm}d left`}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Chip tone={lot.isLongTerm ? "up" : "warn"}>{lot.isLongTerm ? "Long-term" : "Short-term"}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ───────────────────────── Strategy view (tab) ───────────────────────── */

function StrategyView({
  snapshot,
  policy,
  updatePolicy,
  onEdit,
  onOpenFlow,
  activateProfile,
  copyProfileToAccount,
  newProfileName,
  setNewProfileName,
  createProfile,
  requestStrategyTuning,
  tuningBusy,
  tuningError,
  strategyTuning,
  applyStrategyTuning,
  discardStrategyTuning
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  updatePolicy: (patch: PolicyPatch) => void;
  onEdit: () => void;
  onOpenFlow: () => void;
  activateProfile: (id: string) => void;
  copyProfileToAccount: (profileId: string, connectedAccountId: string) => void;
  newProfileName: string;
  setNewProfileName: (v: string) => void;
  createProfile: () => void;
  requestStrategyTuning: (tuningModel?: string) => void;
  tuningBusy: boolean;
  tuningError: string;
  strategyTuning: StrategyTuningProposal | null;
  applyStrategyTuning: () => void;
  discardStrategyTuning: () => void;
}) {
  // Copy-to-account: pick a target account to apply the selected saved strategy to (PR 2).
  const [copyTarget, setCopyTarget] = useState("");
  const [tuningModel, setTuningModel] = useState<string>(policy.llmModel ?? DEFAULT_LLM_MODEL);
  useEffect(() => {
    if (policy.llmModel) {
      setTuningModel(policy.llmModel);
    }
  }, [policy.llmModel]);
  const activeAccountId = snapshot.policy.connectedAccountId;
  const copyTargets = (snapshot.connectedAccounts ?? []).filter((a) => a.id !== activeAccountId);
  const selectedProfileId = snapshot.activeProfile?.id ?? "";
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader
          title="Active Strategy"
          subtitle={policy.strategyAuthority === "decide" ? "Autonomous Mode — auto-executes while running" : "Propose Mode — you approve each order"}
          icon={<BrainCircuit size={16} />}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={onOpenFlow} title="Open the strategy pipeline visualizer.">
                <Network size={14} /> Flow
              </Button>
              <Button size="sm" variant="ghost" onClick={onEdit} title="Open Strategy Studio to edit the prompt, scoring weights, and Green/Red Team models.">
                <SettingsIcon size={14} /> Edit in Studio
              </Button>
            </div>
          }
        />
        <div className="grid gap-3 p-4 pt-3 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Saved strategy</span>
            <select className={inputClass} value={snapshot.activeProfile?.id ?? ""} onChange={(e) => activateProfile(e.target.value)}>
              {snapshot.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {copyTargets.length > 0 && selectedProfileId && (
              <div className="mt-2">
                <span className="mb-1.5 block text-xs font-medium text-muted">Copy this strategy to another account</span>
                <div className="flex items-center gap-2">
                  <select className={inputClass} value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
                    <option value="">Select account…</option>
                    {copyTargets.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    disabled={!copyTarget}
                    onClick={() => copyProfileToAccount(selectedProfileId, copyTarget)}
                    title="Apply this saved strategy to the selected account's live state (does not change its run-state)."
                  >
                    Apply
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Save current as a named strategy</span>
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Name this strategy"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createProfile();
                  }
                }}
              />
              <Button onClick={createProfile} disabled={!newProfileName.trim()}>Save</Button>
              <span className="text-xs text-faint">Optional</span>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4">
          <span className="mb-1.5 block text-xs font-medium text-muted">Prompt</span>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg/60 p-3 text-[13px] leading-relaxed text-muted">
            {snapshot.strategyPrompt}
          </pre>
        </div>
      </Card>

      <Card>
        <PanelHeader title="Key Parameters" subtitle="Edit inline — applies immediately" icon={<Shield size={16} />} />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 text-sm">
          <EditableParam label="Max order" absValue={policy.maxOrderNotional} relValue={policy.maxOrderPctOfNav} onCommitAbs={(v) => updatePolicy({ maxOrderNotional: v, maxOrderPctOfNav: undefined })} onCommitRel={(v) => updatePolicy({ maxOrderNotional: undefined, maxOrderPctOfNav: v })} defaultMode="rel" />
          <EditableParam label="Daily cap" absValue={policy.maxDailyNotional} relValue={policy.maxDailyPctOfNav} onCommitAbs={(v) => updatePolicy({ maxDailyNotional: v, maxDailyPctOfNav: undefined })} onCommitRel={(v) => updatePolicy({ maxDailyNotional: undefined, maxDailyPctOfNav: v })} defaultMode="abs" />
          <EditableParam label="Symbol cap" relValue={policy.maxSymbolExposurePct} onCommitAbs={() => {}} onCommitRel={(v) => updatePolicy({ maxSymbolExposurePct: v })} defaultMode="rel" />
          <EditableParam label="Stop loss" absValue={policy.riskRules.stopLossNotional} relValue={policy.riskRules.stopLossPct} onCommitAbs={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossNotional: v, stopLossPct: undefined } })} onCommitRel={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossNotional: undefined, stopLossPct: v } })} defaultMode="rel" />
          <EditableParam label="Take profit" absValue={policy.riskRules.takeProfitNotional} relValue={policy.riskRules.takeProfitPct} onCommitAbs={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitNotional: v, takeProfitPct: undefined } })} onCommitRel={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitNotional: undefined, takeProfitPct: v } })} defaultMode="rel" />
          <p className="col-span-2 -mt-0.5 text-xs text-faint">Tap <span className="tnum">$⇄%</span> to switch a cap between a dollar amount and a % of NAV — each control holds <strong>one or the other</strong> (setting one clears the other). More guards (drawdown &amp; daily-loss breakers, volatility brake, exposure caps, trailing/ATR stops, short limits, order types, universe floor) live under <strong>Risk &amp; Safety</strong>.</p>

          <div className="col-span-2 mt-2 space-y-3">
             <div className="grid grid-cols-2 gap-2">
               <NumberField label="Max proposals/run" value={policy.maxProposalsPerRun} onCommit={(v) => updatePolicy({ maxProposalsPerRun: Math.round(v) })} />
               <NumberField label="Cadence (min)" value={policy.runCadenceMinutes} onCommit={(v) => updatePolicy({ runCadenceMinutes: Math.max(1, Math.round(v)) })} />
               <NumberField label="Max daily orders" value={policy.maxDailyOrders} onCommit={(v) => updatePolicy({ maxDailyOrders: Math.round(v) })} />
               <NumberField label="Max hourly notional ($)" value={policy.maxHourlyNotional} onCommit={(v) => updatePolicy({ maxHourlyNotional: v })} />
               <OptionalNumberField label="Max portfolio beta" value={policy.maxPortfolioBeta} placeholder="blank disables" step={0.1} onCommit={(v) => updatePolicy({ maxPortfolioBeta: v })} />
               <OptionalNumberField label="Max avg correlation" value={policy.maxAvgCorrelation} placeholder="blank disables" step={0.05} onCommit={(v) => updatePolicy({ maxAvgCorrelation: v })} />
               <OptionalNumberField label="Max entry drift %" value={policy.maxEntryDriftPct} placeholder="blank disables (default 10)" step={0.5} onCommit={(v) => updatePolicy({ maxEntryDriftPct: v })} />
               <OptionalNumberField label="Max quote age (sec)" value={policy.maxQuoteAgeSec} placeholder="blank disables" step={15} onCommit={(v) => updatePolicy({ maxQuoteAgeSec: v })} />
               <OptionalNumberField label="Max fundamentals age (sec)" value={policy.maxFundamentalsAgeSec} placeholder="blank disables" step={60} onCommit={(v) => updatePolicy({ maxFundamentalsAgeSec: v })} />
             </div>
             <div title="When a run's intended buys exceed buying power, optionally raise cash by trimming holdings (largest losers first, never the buy targets).">
               <span className="mb-1.5 block text-xs font-medium text-muted">Sell to Fund Buys</span>
               <select
                 className={inputClass}
                 value={policy.sellToFundBuy ?? "off"}
                 onChange={(e) => updatePolicy({ sellToFundBuy: e.target.value as TradingPolicy["sellToFundBuy"] })}
               >
                 <option value="off">Off — Never Sell to Fund</option>
                 <option value="suggest">Suggest Only (No Orders)</option>
                 <option value="propose">Propose Sells for Approval</option>
                 <option value="automated">Automated — Sell to Fund</option>
               </select>
             </div>
             <Field label="Sector Caps" hint="e.g. Technology:25, Financials:20" className="sm:col-span-2">
               <input className="w-full rounded-md border border-line bg-surface-3/50 px-3 py-2 text-[13px] text-fg outline-none focus:border-accent" defaultValue={formatSectorCaps(policy.sectorCaps)} onBlur={(e) => updatePolicy({ sectorCaps: parseSectorCaps(e.target.value) })} />
             </Field>
             <div className="space-y-1 sm:col-span-2">
               <label className="flex items-center gap-2 text-sm text-muted">
                 <input type="checkbox" checked={policy.runDuringExtendedHours} onChange={(e) => updatePolicy({ runDuringExtendedHours: e.target.checked })} />
                 Run during extended hours
               </label>
               <p className="text-xs leading-relaxed text-faint">
                 Allows scheduled or event-triggered strategy runs during 4:00-9:30 AM ET and 4:00-8:00 PM ET. Placing extended-hours ORDERS is a separate switch (Risk &amp; Safety → Order execution → &quot;Allow extended-hours orders&quot;), and dollar/fractional orders stay regular-hours only.
               </p>
             </div>
             <div className="space-y-2 sm:col-span-2">
               <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
                 <span>
                   <span className="block text-sm font-medium text-fg">Enable short selling</span>
                   <span className="block text-xs text-faint">Requires a connected broker account that supports shorting (e.g. Alpaca); has no effect on accounts without short capability. This lets the agent open short/cover positions. A short stop-loss % is <strong>required</strong> (Risk &amp; Safety → Short-selling limits) or every short is rejected.</span>
                 </span>
                 <Switch checked={Boolean(policy.shortSellingEnabled)} onChange={(v) => updatePolicy({ shortSellingEnabled: v })} />
               </label>
               <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
                 <span>
                   <span className="block text-sm font-medium text-fg">Broker-held brackets</span>
                   <span className="block text-xs text-faint">Attaches native stop-loss/take-profit (OCO) orders at the broker (Alpaca only) so protective exits survive local downtime, and only when a stop-loss % is set. No effect on Robinhood/Test (see Risk &amp; Safety → Stops &amp; exits for what protects those).</span>
                 </span>
                 <Switch checked={policy.brokerBracketsEnabled !== false} onChange={(v) => updatePolicy({ brokerBracketsEnabled: v })} />
               </label>
               <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
                 <span>
                   <span className="block text-sm font-medium text-fg">Beta-scaled stops</span>
                   <span className="block text-xs text-faint">Scales stop-loss distance by each name&apos;s beta (wider for volatile names, tighter for stable ones) instead of one flat %. When on, the Stop loss % above is the BASE — the actual per-name stop is base × beta (clamped 0.5–2.0×), so the displayed % is not the literal stop. ATR stops (Risk &amp; Safety) take precedence when both are on.</span>
                 </span>
                 <Switch checked={Boolean(policy.betaScaledStops)} onChange={(v) => updatePolicy({ betaScaledStops: v })} />
               </label>
             </div>
          </div>
        </div>
      </Card>

      <Card>
        <PanelHeader
          title="LLM Strategy Review"
          subtitle="Advisory — review past performance & suggest tuning"
          icon={<Sparkles size={16} />}

        />
        <div className="space-y-3 p-4 pt-3">
          <div className="rounded-lg border border-line bg-bg/55 px-3 py-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                <Zap size={16} />
              </span>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <div className="text-sm font-semibold text-fg">Generate a tuning proposal</div>
                  <p className="mt-0.5 text-xs text-faint">Creates an advisory review below. Nothing changes until you apply reviewed changes.</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <StrategyTuningModelSelect
                    value={tuningModel}
                    onChange={setTuningModel}
                    className="w-full sm:w-60"
                  />
                  <Button
                    size="sm"
                    variant="accentSoft"
                    className="w-full sm:w-auto"
                    onClick={() => requestStrategyTuning(tuningModel)}
                    disabled={tuningBusy}
                  >
                    <Zap size={14} /> {tuningBusy ? "Reviewing…" : "Review strategy"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
          {tuningError && <p className="mb-2 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[13px] text-down">{tuningError}</p>}
          {strategyTuning ? <TuningCard proposal={strategyTuning} currentPolicy={policy} currentPrompt={snapshot.strategyPrompt} onApply={applyStrategyTuning} onDiscard={discardStrategyTuning} /> : <p className="text-[13px] text-faint">No review yet. Run a review to get suggested prompt, scoring, and risk changes (you apply them manually).</p>}
        </div>
      </Card>
    </div>
  );
}

function KeyVal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2">
      <div className="text-[11px] uppercase text-faint">{label}</div>
      <div className="tnum text-sm text-fg">{value}</div>
    </div>
  );
}

function EditableParam({
  label,
  absValue,
  relValue,
  onCommitAbs,
  onCommitRel,
  defaultMode
}: {
  label: string;
  absValue?: number;
  relValue?: number;
  onCommitAbs: (v: number | undefined) => void;
  onCommitRel: (v: number | undefined) => void;
  defaultMode: "abs" | "rel";
}) {
  const preferredMode = defaultMode === "rel"
    ? (relValue !== undefined ? "rel" : absValue !== undefined ? "abs" : defaultMode)
    : (absValue !== undefined ? "abs" : relValue !== undefined ? "rel" : defaultMode);
  const [mode, setMode] = useState<"abs" | "rel">(
    preferredMode
  );
  
  const currentVal = mode === "abs" ? absValue : relValue;
  const [draft, setDraft] = useState(currentVal !== undefined ? String(currentVal) : "");
  
  useEffect(() => {
    const val = mode === "abs" ? absValue : relValue;
    setDraft(val !== undefined ? String(val) : "");
  }, [mode, absValue, relValue]);

  function commit() {
    if (draft.trim() === "") {
      if (mode === "abs") onCommitAbs(undefined);
      else onCommitRel(undefined);
      return;
    }
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) {
      if (mode === "abs") {
        onCommitAbs(n);
      } else {
        onCommitRel(n);
      }
    } else {
      const val = mode === "abs" ? absValue : relValue;
      setDraft(val !== undefined ? String(val) : "");
    }
  }

  function toggleMode(e: React.MouseEvent) {
    e.preventDefault();
    setMode((prev) => (prev === "abs" ? "rel" : "abs"));
  }

  return (
    <label className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 focus-within:border-accent">
      <div className="flex items-center justify-between text-[11px] uppercase text-faint">
        {label}
        <button type="button" onClick={toggleMode} className="hover:text-fg flex cursor-pointer items-center gap-1 font-semibold transition-colors">
           {mode === "abs" ? "$" : "%"} <span className="text-[9px] opacity-50">⇄</span>
        </button>
      </div>
      <div className="flex items-baseline gap-1">
        {mode === "abs" && <span className="text-sm text-faint shrink-0">$</span>}
        <input
          type="number"
          min={0}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full min-w-0 flex-1 bg-transparent tnum text-sm text-fg outline-none"
          placeholder={mode === "abs" ? "Not set" : "Not set"}
        />
        {mode === "rel" && <span className="text-sm text-faint shrink-0">%</span>}
      </div>
    </label>
  );
}

function TuningCard({
  proposal,
  currentPolicy,
  currentPrompt,
  onApply,
  onDiscard
}: {
  proposal: StrategyTuningProposal;
  currentPolicy: TradingPolicy;
  currentPrompt: string;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const reviewDisplay = buildStrategyReviewDisplay(proposal, { policy: currentPolicy, strategyPrompt: currentPrompt });
  const hasReturnedChanges = Boolean(reviewDisplay.promptChange) || reviewDisplay.allChanges.length > 0;
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Chip tone={proposal.generatedBy === "llm" ? "accent" : "warn"}>{proposal.generatedBy === "llm" ? "LLM review" : "Local rules"}</Chip>
        <span className="text-xs text-faint">Confidence {proposal.confidenceScore.toFixed(0)}%</span>
      </div>
      <p className="text-sm font-medium text-fg">{proposal.summary}</p>
      <p className="text-[13px] text-muted">{proposal.rationale}</p>
      {hasReturnedChanges ? (
        <div className="space-y-2">
          {reviewDisplay.promptChange && (
            <details open className="group rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-fg">
                <span className="flex min-w-0 items-center gap-2">
                  <ChevronRight size={14} className="shrink-0 text-accent transition-transform group-open:rotate-90" />
                  <span>Prompt replacement</span>
                </span>
                {!reviewDisplay.promptChange.changed && <span className="shrink-0 text-xs font-medium text-faint">No value change</span>}
              </summary>
              <div className="grid gap-2 border-t border-line p-3 lg:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-1 text-[11px] font-medium uppercase text-faint">Current prompt</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg/70 p-3 font-mono text-[12px] leading-relaxed text-muted">
                    {reviewDisplay.promptChange.current}
                  </pre>
                </div>
                <div className="min-w-0">
                  <div className="mb-1 text-[11px] font-medium uppercase text-faint">Will replace with</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-accent/30 bg-accent/5 p-3 font-mono text-[12px] leading-relaxed text-fg">
                    {reviewDisplay.promptChange.proposed}
                  </pre>
                </div>
              </div>
            </details>
          )}
          <TuningChangeGroup title="Strategy Studio values" changes={reviewDisplay.studioChanges} />
          <TuningChangeGroup title="Risk and automation settings" changes={reviewDisplay.riskChanges} />
        </div>
      ) : (
        <p className="text-[13px] text-faint">No prompt or setting changes returned.</p>
      )}
      {proposal.cautions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {proposal.cautions.map((c) => <Chip key={c} tone="warn">{c}</Chip>)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!reviewDisplay.hasEffectiveChanges} onClick={onApply}><CheckCircle size={16} /> Apply reviewed changes</Button>
        <Button variant="ghost" onClick={onDiscard}><X size={16} /> Discard review</Button>
      </div>
    </div>
  );
}

function TuningChangeGroup({ title, changes }: { title: string; changes: StrategyReviewChange[] }) {
  if (changes.length === 0) return null;
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase text-faint">{title}</div>
      <ul className="space-y-2">
        {changes.map((change) => (
          <li key={change.id} className="grid gap-2 rounded-md border border-line/80 bg-bg/40 p-2.5 text-[13px] sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 font-medium text-fg">
                <span>{change.label}</span>
                {!change.changed && <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] uppercase text-faint">No change</span>}
              </div>
              <div className="mt-0.5 text-[11px] text-faint">{change.location}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase text-faint">Current</div>
              <div className="break-words tnum text-muted">{change.current}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase text-faint">Proposed</div>
              <div className="break-words tnum font-medium text-fg">{change.proposed}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────────────────── Feeds (slide-over) ───────────────────────── */

function readableJsonDetail(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed.startsWith("{")) return detail;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.id === "string") {
      const source = labelize(parsed.id);
      const count = typeof parsed.recordCount === "number" ? `${parsed.recordCount.toLocaleString()} records` : undefined;
      const fresh = typeof parsed.fresh === "number" ? `${parsed.fresh.toLocaleString()} fresh` : undefined;
      const asOf = typeof parsed.asOf === "string" ? `as of ${parsed.asOf}` : undefined;
      const warnings = Array.isArray(parsed.warnings) && parsed.warnings.length > 0 ? `${parsed.warnings.length} warning${parsed.warnings.length === 1 ? "" : "s"}` : undefined;
      return [source, count, fresh, asOf, warnings].filter(Boolean).join(" · ");
    }
  } catch {
    return detail;
  }
  return detail;
}

function readableActivityTag(tag: string): string {
  if (tag === "notification failed" || tag === "notification disabled") return "webhook off";
  return tag;
}

function DetailLine({ text, className }: { text: string; className?: string }) {
  const detail = readableJsonDetail(text);
  return (
    <div className={cn("min-w-0 truncate whitespace-nowrap", className)} title={detail}>
      {detail}
    </div>
  );
}

function ActivityFeed({ snapshot, onReplaceMarket }: { snapshot: DashboardSnapshot; onReplaceMarket?: (candidate: MarketReplaceCandidate) => void }) {
  const feed = snapshot.unifiedFeed ?? [];
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (feed.length === 0) return <EmptyState icon={<ActivityIcon size={20} />} title="No Activity Yet" />;
  return (
    <div className="space-y-2">
      {feed.slice(0, 50).map((group) => {
        const accent = group.tags.includes("policy change")
          ? "border-l-info"
          : group.status === "filled"
            ? "border-l-up"
            : group.status === "blocked" || group.status === "rejected"
              ? "border-l-down"
              : group.status === "pending_approval" || group.status === "pending"
                ? "border-l-warn"
                : "border-l-line";
        const hasSub = group.events && group.events.length > 1;
        const open = !!expanded[group.id];
        const replaceCandidate = onReplaceMarket ? staleLimitReplaceCandidate(group, snapshot.policy) : null;
        return (
          <div key={group.id} className={cn("rounded-r-lg border-l-[3px] border-b border-line bg-surface-2/40 pl-3", accent)}>
            <div className="flex items-start justify-between gap-2 py-2 pr-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                  <span>{new Date(group.updatedAt).toLocaleString()}</span>
                  {group.accountLabel && <span>{group.accountLabel}</span>}
                  {group.companyName && <span>({group.companyName})</span>}
                </div>
                <div className="mt-0.5 text-sm">{renderActionTitle(group.title)}</div>
                <DetailLine text={group.fullText ?? group.detail} className="mt-0.5 text-[13px] text-muted" />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Array.from(new Set(group.tags.map(readableActivityTag))).map((t) => (
                    <span key={t} className="rounded bg-surface-3/50 backdrop-blur-md px-1.5 py-0.5 text-[10px] font-semibold uppercase text-faint">{t}</span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Chip tone={statusTone(group.status)}>{displayStatus(group.status)}</Chip>
                {replaceCandidate && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title="Cancel this stale limit order and submit the remaining quantity as a market order."
                    onClick={() => onReplaceMarket?.(replaceCandidate)}
                  >
                    <RefreshCw size={14} />
                    Market replace
                  </Button>
                )}
                {hasSub && (
                  <button onClick={() => setExpanded((e) => ({ ...e, [group.id]: !e[group.id] }))} className="text-[11px] text-muted hover:text-fg">
                    {open ? "Hide" : `+${group.events.length}`}
                  </button>
                )}
              </div>
            </div>
            {open && hasSub && (
              <div className="space-y-1 border-t border-dashed border-line py-2 pr-2">
                {group.events.map((ev) => (
                  <div key={ev.id} className="flex gap-2 text-[12px]">
                    <span className="w-24 shrink-0 text-faint">{new Date(ev.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <div className="min-w-0 flex-1">
                      <div>{renderActionTitle(ev.title)}</div>
                      <DetailLine text={ev.fullText ?? ev.detail} className="text-[11px] text-faint" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MarketReplaceModal({
  candidate,
  live,
  accountNumber,
  typedText,
  onTypedText,
  busy,
  onClose,
  onConfirm
}: {
  candidate: MarketReplaceCandidate | null;
  live: boolean;
  accountNumber?: string;
  typedText: string;
  onTypedText: (value: string) => void;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!candidate) return null;
  const order = candidate.order;
  const expectedText = marketReplaceText(order.symbol);
  const remaining = formatShareQuantity(candidate.remainingQuantity);
  const typedMatches = typedText.trim().toUpperCase() === expectedText;
  const confirmDisabled = busy || (live && !typedMatches);
  const orderKind = String(order.type).replace(/_/g, "-");

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Replace stale limit order"
      subtitle={`${order.side.toUpperCase()} ${order.symbol} (${remaining} remaining)`}
      icon={<RefreshCw size={20} />}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant={live ? "danger" : "primary"} onClick={onConfirm} disabled={confirmDisabled}>
            Submit market order
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-lg border border-line bg-surface-2/50 p-3">
          <div className="grid gap-2 text-[13px] sm:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold uppercase text-faint">Order</div>
              <div className="mt-0.5 text-fg">{order.side.toUpperCase()} {order.symbol} {orderKind}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase text-faint">State</div>
              <div className="mt-0.5 text-fg">{readableOrderState(order.state)}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase text-faint">Remaining</div>
              <div className="mt-0.5 text-fg">{remaining}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase text-faint">Age</div>
              <div className="mt-0.5 text-fg">{candidate.ageMinutes} min (limit {candidate.thresholdMinutes} min)</div>
            </div>
          </div>
        </div>

        <p className="text-muted">
          This cancels the working {orderKind} order, re-checks the broker, then submits only the remaining quantity as a market order.
        </p>

        {live ? (
          <div className="space-y-2">
            <label className="text-[12px] font-semibold uppercase text-faint" htmlFor="market-replace-confirmation">
              Live Brokerage confirmation
            </label>
            <input
              id="market-replace-confirmation"
              className={inputClass}
              value={typedText}
              onChange={(event) => onTypedText(event.target.value)}
              placeholder={expectedText}
              autoComplete="off"
            />
            <p className="text-xs text-faint">
              Type <span className="font-mono text-fg">{expectedText}</span> for {accountNumber ?? "the selected live account"}.
            </p>
          </div>
        ) : (
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-muted">
            Paper replacement uses broker paper execution and will stay Working until the broker reports a fill.
          </p>
        )}
      </div>
    </Modal>
  );
}

function marketReplaceText(symbol: string): string {
  return `REPLACE LIVE ${symbol.trim().toUpperCase()}`;
}

function staleLimitReplaceCandidate(group: UnifiedActivityGroup, policy: TradingPolicy): MarketReplaceCandidate | null {
  const thresholdMinutes = staleLimitOrderThresholdMinutes(policy);
  if (thresholdMinutes <= 0) return null;
  const nowMs = Date.now();

  const candidates = group.events
    .filter((event) => event.type === "order")
    .map((event) => equityOrderFromRaw(event.raw))
    .filter((order): order is EquityOrder => !!order)
    .flatMap((order) => {
      if (!MARKET_REPLACE_ORDER_TYPES.has(String(order.type ?? "").toLowerCase())) return [];
      if (!MARKET_REPLACE_ACTIVE_ORDER_STATES.has(String(order.state ?? "").trim().toLowerCase())) return [];
      const createdMs = Date.parse(order.createdAt);
      if (!Number.isFinite(createdMs) || createdMs > nowMs) return [];
      const remainingQuantity = remainingOrderQuantity(order);
      if (remainingQuantity <= 0) return [];
      const ageMinutes = Math.floor((nowMs - createdMs) / 60_000);
      if (ageMinutes < thresholdMinutes) return [];
      return [{ order, ageMinutes, thresholdMinutes, remainingQuantity }];
    });

  candidates.sort((a, b) => b.ageMinutes - a.ageMinutes);
  return candidates[0] ?? null;
}

function staleLimitOrderThresholdMinutes(policy: Pick<TradingPolicy, "staleLimitOrderMinutes">): number {
  const value = policy.staleLimitOrderMinutes ?? DEFAULT_STALE_LIMIT_ORDER_MINUTES;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function equityOrderFromRaw(raw: unknown): EquityOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const order = raw as Partial<EquityOrder>;
  if (typeof order.id !== "string" || typeof order.symbol !== "string" || typeof order.state !== "string") return null;
  if (typeof order.createdAt !== "string") return null;
  return order as EquityOrder;
}

function remainingOrderQuantity(order: EquityOrder): number {
  const quantity = order.quantity ?? 0;
  const filled = order.filledQuantity ?? 0;
  return Math.max(quantity - filled, 0);
}

function RunHistory({ snapshot }: { snapshot: DashboardSnapshot }) {
  const runs = snapshot.strategyRuns ?? [];
  const sched = snapshot.scheduler;
  return (
    <div className="space-y-3">
      {sched && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-[12px] text-muted">
          <span className="font-semibold uppercase tracking-wide text-faint text-[10px]">Scheduler</span>
          {sched.lastRunAt && (
            <span title={sched.lastRunAt}>
              Last: <span className="text-fg">{new Date(sched.lastRunAt).toLocaleString()}</span>
            </span>
          )}
          {sched.nextRunAt && (
            <span title={sched.nextRunAt}>
              Next: <span className="text-fg">{new Date(sched.nextRunAt).toLocaleString()}</span>
            </span>
          )}
          {typeof sched.runsToday === "number" && (
            <span>
              Today: <span className="text-fg">{sched.runsToday}</span>
            </span>
          )}
          {!sched.lastRunAt && !sched.nextRunAt && <span className="text-faint">No runs scheduled yet</span>}
        </div>
      )}
      {runs.length === 0 ? (
        <EmptyState icon={<Zap size={20} />} title="No Strategy Runs Yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase text-faint">
                <th className="px-2 py-1.5 text-left font-semibold">Time</th>
                <th className="px-2 py-1.5 text-left font-semibold">Status</th>
                <th className="px-2 py-1.5 text-right font-semibold">Placed</th>
                <th className="px-2 py-1.5 text-right font-semibold">Test</th>
                <th className="px-2 py-1.5 text-right font-semibold">Blocked</th>
                <th className="px-2 py-1.5 text-left font-semibold">Summary</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-line/50">
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted">{new Date(run.startedAt).toLocaleString()}</td>
                  <td className="px-2 py-1.5"><Chip tone={run.status === "completed" ? "up" : run.status === "failed" ? "down" : "warn"}>{run.status}</Chip></td>
                  <td className="px-2 py-1.5 text-right tnum">{run.placedCount}</td>
                  <td className="px-2 py-1.5 text-right tnum">{run.paperCount}</td>
                  <td className="px-2 py-1.5 text-right tnum">{run.blockedCount}</td>
                  <td className="max-w-[220px] truncate px-2 py-1.5 text-faint" title={run.summary}>{run.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NotificationsList({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = snapshot.notifications ?? [];
  const configured = snapshot.notificationStatus.configured;
  const meta = snapshot.symbolMetaBySymbol ?? {};
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Chip tone={configured ? "up" : "warn"}>{configured ? "Webhook configured" : "Webhook not configured"}</Chip>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No Notification Attempts Recorded" />
      ) : (
        items.slice(0, 20).map((n) => {
          const display = formatNotificationDisplay(n, meta);
          return (
            <div key={n.id} className="border-b border-line/60 py-2">
              <div className="text-[11px] uppercase text-faint">{display.timestamp}</div>
              <div className="text-sm text-fg">{display.title}</div>
              <div className="text-[13px] text-muted">{display.detail}</div>
            </div>
          );
        })
      )}
    </div>
  );
}

function AuditLog({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = snapshot.auditFeed ?? [];
  if (items.length === 0) return <EmptyState icon={<ActivityIcon size={20} />} title="No Audit Events Yet" hint="Policy changes, order decisions, and system events appear here." />;
  return (
    <div className="space-y-1.5">
      {items.slice(0, 100).map((item) => (
        <div key={item.id} className="rounded-lg border border-line/60 bg-surface-2/40 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[11px] text-faint">{new Date(item.createdAt).toLocaleString()}{item.accountLabel && ` · ${item.accountLabel}`}{item.symbol && ` · ${item.symbol}`}{item.companyName && ` (${item.companyName})`}</div>
              <div className="mt-0.5 text-sm text-fg">{item.title}</div>
              {item.detail && <DetailLine text={item.fullText ?? item.detail} className="mt-0.5 text-[12px] text-muted" />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Strategy Studio (modal) ───────────────────────── */

function StrategyStudio({
  snapshot,
  policy,
  editStrategyPrompt,
  resetPrompt,
  updatePolicy,
  requestStrategyTuning,
  tuningBusy,
  tuningError,
  strategyTuning,
  applyStrategyTuning,
  discardStrategyTuning
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  editStrategyPrompt: (v: string) => void;
  resetPrompt: () => void;
  updatePolicy: (patch: PolicyPatch) => void;
  requestStrategyTuning: (tuningModel?: string) => void;
  tuningBusy: boolean;
  tuningError: string;
  strategyTuning: StrategyTuningProposal | null;
  applyStrategyTuning: () => void;
  discardStrategyTuning: () => void;
}) {
  const [tuningModel, setTuningModel] = useState<string>(policy.llmModel ?? DEFAULT_LLM_MODEL);
  // NAV_V2 PR #6: when STRATEGY_CONSOLIDATION is on, this Studio-modal TuningCard
  // (the duplicate) is suppressed so a single instance renders on the Strategy
  // tab. Off by default — flag-off keeps both render sites (byte-identical).
  const [strategyConsolidation] = useState(() =>
    isStrategyConsolidationEnabled(typeof window !== "undefined" ? window.localStorage : null)
  );
  useEffect(() => {
    if (policy.llmModel) {
      setTuningModel(policy.llmModel);
    }
  }, [policy.llmModel]);

  function isReasoningModel(model: string | undefined): boolean {
    return /^(gpt-5|o\d)/i.test((model ?? "").trim());
  }

  const showReasoningEffort = isReasoningModel(policy.llmModel) || isReasoningModel(policy.redTeamLlmModel) || isReasoningModel(tuningModel);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-fg">Strategy Prompt</h4>
          <Button size="sm" variant="ghost" onClick={resetPrompt}><RotateCcw size={14} /> Reset</Button>
        </div>
        <textarea
          value={snapshot.strategyPrompt}
          onChange={(e) => editStrategyPrompt(e.target.value)}
          className={cn(inputClass, "h-72 lg:h-[480px] resize-none text-sm leading-relaxed")}
        />
        <p className="text-xs text-faint">Autosaves ~1s after you stop typing.</p>
      </div>

      <div className="space-y-4">
        <div>
          <h4 className="mb-2 text-sm font-semibold text-fg" title="Choose which LLM proposes trades and which LLM critiques them before approval. API keys still live in Settings -> Connections.">Green/Red Team Models</h4>
          <div className="grid gap-3">
            <Field label="Green Team Model" hint="Primary proposal generator — choose any provider's model. Manage provider keys in Settings -> Connections.">
              <div className="space-y-2">
                <select className={inputClass} value={STRATEGY_MODEL_IDS.includes(policy.llmModel ?? DEFAULT_LLM_MODEL) ? (policy.llmModel ?? DEFAULT_LLM_MODEL) : "custom"} onChange={(e) => {
                  if (e.target.value === "custom") {
                    updatePolicy({ llmModel: CUSTOM_STRATEGY_MODEL_SEED });
                  } else {
                    updatePolicy({ llmModel: e.target.value });
                  }
                }}>
                  {renderCuratedModelOptions()}
                  <option value="custom">Custom Model ID...</option>
                </select>
                {!STRATEGY_MODEL_IDS.includes(policy.llmModel ?? DEFAULT_LLM_MODEL) && (
                  <input
                    type="text"
                    className={inputClass}
                    value={policy.llmModel ?? ""}
                    placeholder="Enter custom model ID (e.g. gpt-5.5)"
                    onChange={(e) => updatePolicy({ llmModel: e.target.value })}
                  />
                )}
              </div>
            </Field>
            <Field label="Red Team Model" hint="Independent Bear reviewer. Leave as same as Green Team for lower friction, or choose a stronger/different model for adversarial critique.">
              <div className="space-y-2">
                <select className={inputClass} value={!policy.redTeamLlmModel ? "" : STRATEGY_MODEL_IDS.includes(policy.redTeamLlmModel) ? policy.redTeamLlmModel : "custom"} onChange={(e) => {
                  if (e.target.value === "custom") {
                    updatePolicy({ redTeamLlmModel: CUSTOM_STRATEGY_MODEL_SEED });
                  } else {
                    updatePolicy({ redTeamLlmModel: e.target.value || undefined });
                  }
                }}>
                  <option value="">Same as Green Team model</option>
                  {renderCuratedModelOptions()}
                  <option value="custom">Custom Model ID...</option>
                </select>
                {policy.redTeamLlmModel !== undefined && !STRATEGY_MODEL_IDS.includes(policy.redTeamLlmModel) && (
                  <input
                    type="text"
                    className={inputClass}
                    value={policy.redTeamLlmModel ?? ""}
                    placeholder="Enter custom model ID (e.g. claude-mythos-5)"
                    onChange={(e) => updatePolicy({ redTeamLlmModel: e.target.value })}
                  />
                )}
              </div>
            </Field>
            {showReasoningEffort && (
              <Field label="Reasoning Effort" hint="For gpt-5 / o-series reasoning models: higher effort = deeper analysis, more tokens, higher cost & latency. Other model families use their provider defaults.">
                <select className={inputClass} value={policy.llmReasoningEffort ?? "medium"} onChange={(e) => updatePolicy({ llmReasoningEffort: e.target.value as TradingPolicy["llmReasoningEffort"] })}>
                  <option value="low">Low — fastest & cheapest</option>
                  <option value="medium">Medium — balanced (recommended)</option>
                  <option value="high">High — deepest analysis, priciest</option>
                </select>
              </Field>
            )}
          </div>
        </div>
        <div>
          <h4 className="mb-2 text-sm font-semibold text-fg">Scoring Weights</h4>
          <ScoringWeights weights={policy.scoringWeights} onCommit={(w) => updatePolicy({ scoringWeights: w })} />
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="rounded-lg border border-line bg-surface-2/45 p-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
              <Sparkles size={16} />
            </span>
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-fg">LLM Strategy Review</h4>
                <p className="mt-0.5 text-xs text-faint">Reviews performance, scan context, macro, and current prompt. Advisory only.</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <StrategyTuningModelSelect
                  value={tuningModel}
                  onChange={setTuningModel}
                  className="w-full sm:w-60"
                />
                <Button
                  size="sm"
                  variant="accentSoft"
                  className="w-full sm:w-auto"
                  onClick={() => requestStrategyTuning(tuningModel)}
                  disabled={tuningBusy}
                >
                  <Zap size={14} /> {tuningBusy ? "Reviewing…" : "Review strategy"}
                </Button>
              </div>
            </div>
          </div>
          {tuningError && <p className="mt-3 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[13px] text-down">{tuningError}</p>}
          <div className="mt-3">
            {strategyConsolidation ? (
              <p className="text-[13px] text-faint">Strategy review now lives in one place — the Strategy tab.</p>
            ) : strategyTuning ? (
              <TuningCard proposal={strategyTuning} currentPolicy={policy} currentPrompt={snapshot.strategyPrompt} onApply={applyStrategyTuning} onDiscard={discardStrategyTuning} />
            ) : (
              <p className="text-[13px] text-faint">Run a review to get suggested prompt, scoring, and risk changes.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StrategyTuningModelSelect({
  value,
  onChange,
  className
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <select
      aria-label="Strategy review model"
      className={cn(inputClass, "h-8 border-line bg-surface-3 py-1 text-[12px]", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {value && !STRATEGY_MODEL_IDS.includes(value) && (
        <option value={value}>{value} (current custom)</option>
      )}
      {renderCuratedModelOptions(false)}
    </select>
  );
}

function ScoringWeights({ weights, onCommit }: { weights: ScoringWeights; onCommit: (w: ScoringWeights) => void }) {
  const keys = Object.keys(weights) as Array<keyof ScoringWeights>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {keys.map((k) => (
        <NumberField key={k} label={labelize(k)} value={weights[k]} onCommit={(v) => onCommit({ ...weights, [k]: v })} />
      ))}
    </div>
  );
}

/* ───────────────────────── Settings (modal) ───────────────────────── */

function SettingsContent({
  snapshot,
  policy,
  initialSection,
  allowedCount,
  enableBlockedReason,
  remainingNotional,
  remainingOrders,
  updatePolicy,
  tickerLogoDisplay,
  setTickerLogoDisplay,
  executionBannerMode,
  setExecutionBannerMode,
  openAccounts,
  openStrategyStudio,
  load,
  onChangeAccount,
  onRequestDecideConfirm,
  onRequestSystemToggle
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  initialSection: SettingsSection;
  allowedCount: number;
  enableBlockedReason?: string;
  remainingNotional: number;
  remainingOrders: number;
  updatePolicy: (patch: PolicyPatch) => void;
  tickerLogoDisplay: TickerLogoDisplay;
  setTickerLogoDisplay: (next: TickerLogoDisplay) => void;
  executionBannerMode: ExecutionBannerMode;
  setExecutionBannerMode: (next: ExecutionBannerMode) => void;
  openAccounts: () => void;
  openStrategyStudio: () => void;
  load: (options?: { quiet?: boolean }) => Promise<void>;
  onChangeAccount: (id: string) => Promise<void>;
  onRequestDecideConfirm: () => void;
  onRequestSystemToggle: () => void;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState("");
  const [blockDraft, setBlockDraft] = useState("");
  const [accountDeletionOpen, setAccountDeletionOpen] = useState(false);
  const [settingsTier, setSettingsTier] = useState<SettingsTier>(() => settingsTierForSection(initialSection));
  // NAV_V2 PR #3: scope-first framing. Off by default (dark launch); the flag-off
  // modal is byte-identical.
  const [navV2] = useState(() => isNavV2Enabled(typeof window !== "undefined" ? window.localStorage : null));
  useEffect(() => {
    setSection(initialSection);
    setSettingsTier(settingsTierForSection(initialSection));
  }, [initialSection]);
  // ── Shared data pool consent state ──────────────────────────────────────
  const [poolConsent, setPoolConsent] = useState<boolean | null>(null);
  const [poolConsentLoading, setPoolConsentLoading] = useState(false);
  useEffect(() => {
    if (section !== "data") return;
    let cancelled = false;
    void fetch("/api/consent")
      .then((r) => {
        if (!r.ok) throw new Error("Consent state unavailable.");
        return r.json();
      })
      .then((d) => { if (!cancelled) setPoolConsent(Boolean(d?.accepted)); })
      .catch(() => {
        if (!cancelled) {
          setPoolConsent(null);
          toast.error("Consent state could not be loaded. Sharing controls are locked until this is resolved.");
        }
      });
    return () => { cancelled = true; };
  }, [section]);

  async function setPoolConsentValue(accepted: boolean) {
    if (poolConsentLoading) return;
    setPoolConsentLoading(true);
    try {
      const response = await fetch("/api/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accepted })
      });
      if (!response.ok) throw new Error("Consent could not be saved.");
      setPoolConsent(accepted);
    } catch {
      toast.error("Consent could not be saved. Sharing state was not changed.");
    } finally {
      setPoolConsentLoading(false);
    }
  }

  // ── Learned-context sharing state ────────────────────────────────────────
  // includeShared defaults TRUE (user benefits from the pool); contributeShared defaults FALSE
  // (nothing is shared without explicit opt-in). Loaded on first visit to the "data" section.
  const [lcSharing, setLcSharing] = useState<{ includeShared: boolean; contributeShared: boolean } | null>(null);
  const [lcSharingLoading, setLcSharingLoading] = useState(false);
  useEffect(() => {
    if (section !== "data") return;
    let cancelled = false;
    void fetch("/api/learned-context/sharing")
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setLcSharing(d as { includeShared: boolean; contributeShared: boolean }); })
      .catch(() => { /* leave null — toggles render as disabled until loaded */ });
    return () => { cancelled = true; };
  }, [section]);

  async function updateLcSharing(patch: { includeShared?: boolean; contributeShared?: boolean }) {
    if (lcSharingLoading) return;
    setLcSharingLoading(true);
    try {
      const res = await fetch("/api/learned-context/sharing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const updated = await res.json() as { includeShared: boolean; contributeShared: boolean };
      setLcSharing(updated);
    } catch {
      /* best-effort */
    } finally {
      setLcSharingLoading(false);
    }
  }

  const taxSettings = snapshot.tax?.settings ?? policy.taxSettings ?? { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15 };
  const tuning = policy.tuning ?? {};
  const activeAccount = activeConnectedAccountFor(snapshot);
  const executionState = deriveExecutionState(policy, activeAccount);
  const settingsAllowedUniverse = policyUniverseSymbolCount(policy);
  const scanCandidateLimit = normalizeMarketScanCandidateLimit(policy.marketScanCandidateLimit);
  const scanOutlierReserve = normalizeMarketScanOutlierReserve(policy.marketScanOutlierReserve, scanCandidateLimit);
  const scanOutlierMax = Math.min(MAX_MARKET_SCAN_OUTLIER_RESERVE, scanCandidateLimit);
  const settingsScopeTitle = settingsTier === "user" ? "User Settings" : "Account Settings";
  const settingsScopeDetail = settingsTier === "user"
    ? "Provider keys, appearance, alert delivery, and shared data."
    : activeAccount
      ? `${activeAccount.label} · ${activeAccount.broker} strategy, operation, safety, tax, and tuning.`
      : "Strategy, operation, safety, tax, and tuning for the selected account.";

  function addAllowlist() {
    if (draft.trim() === "") return;
    const inputs = draft.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    const invalid = inputs.filter(s => !isValidAppSymbol(s));
    if (invalid.length > 0) {
      toast.error(`Invalid ticker format${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`, {
        description: "Use 1-10 letters, numbers, or dots, starting with a letter."
      });
      return;
    }
    const next = normalizeSymbols([...policy.additionalSymbols, ...inputs]);
    setDraft("");
    updatePolicy({ additionalSymbols: next });
  }

  function addBlocklist() {
    if (blockDraft.trim() === "") return;
    const inputs = blockDraft.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    const invalid = inputs.filter(s => !isValidAppSymbol(s));
    if (invalid.length > 0) {
      toast.error(`Invalid ticker format${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`, {
        description: "Use 1-10 letters, numbers, or dots, starting with a letter."
      });
      return;
    }
    const next = normalizeSymbols([...(policy.blocklist || []), ...inputs]);
    setBlockDraft("");
    updatePolicy({ blocklist: next });
  }

  function toggleIndex(index: IndexUniverse, checked: boolean) {
    updatePolicy({ includedIndices: toggleIncludedIndex(policy.includedIndices, index, checked) });
  }

  async function setAutoResumeOnBoot(enabled: boolean) {
    try {
      const res = await fetch("/api/settings/auto-resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) throw new Error("Failed to save setting");
      await load({ quiet: true });
    } catch {
      toast.error("Could not save auto-resume setting.");
    }
  }

  return (
    <>
      <div className="min-h-[60vh] space-y-4">
        <div className="space-y-3 rounded-lg border border-line bg-surface/60 p-3 shadow-[var(--shadow)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                {settingsTier === "user" ? <SettingsIcon size={16} /> : <Wallet size={16} />}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-fg">{settingsScopeTitle}</span>
                  <Chip
                    tone={settingsTierForSection(section) === "account" ? "accent" : "neutral"}
                    className="tracking-wide"
                  >
                    {scopeTagForSection(section)}
                  </Chip>
                </div>
                <div className="truncate text-xs text-faint" title={settingsScopeDetail}>{settingsScopeDetail}</div>
              </div>
            </div>
            <div className="overflow-x-auto overscroll-x-contain sm:shrink-0">
              <Segmented<"user" | "account">
                value={settingsTier}
                onChange={(v) => {
                  setSettingsTier(v);
                  setSection(v === "user" ? "connections" : "strategy");
                }}
                className="w-max min-w-full bg-bg/60 p-1 sm:min-w-0"
                buttonClassName="h-8 flex-1 px-3 text-[13px] sm:min-w-36"
                options={[
                  { value: "user", label: "User" },
                  { value: "account", label: "Account" }
                ]}
              />
            </div>
          </div>

          {settingsTier === "account" && (() => {
            const accounts = (snapshot.connectedAccounts ?? []).filter((a) => a.broker !== "test" || a.id === snapshot.policy.connectedAccountId);
            return (
              <div className="flex flex-col gap-2 rounded-lg border border-line/70 bg-bg/35 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                    <Wallet size={14} />
                  </span>
                  <span className="text-sm font-medium text-fg">Account</span>
                </div>
                {accounts.length > 0 ? (
                  <select
                    className="h-9 w-full min-w-0 rounded-lg border border-line bg-surface/70 px-2 text-sm text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent sm:max-w-xs"
                    value={activeAccount?.id ?? ""}
                    onChange={async (e) => {
                      const id = e.target.value;
                      if (id) {
                        try {
                          await onChangeAccount(id);
                        } catch {
                          toast.error("Account switch failed.");
                        }
                      }
                    }}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs text-muted">No accounts connected</span>
                )}
              </div>
            );
          })()}

          {navV2 && settingsTier === "user" && (
            <div className="rounded-lg border border-line/70 bg-bg/35 p-3">
              <div className="text-sm font-semibold text-fg">Looking for strategy or risk settings?</div>
              <p className="mt-1 text-[13px] text-muted">
                Those live with the account. If a setting changes how a trade is decided or placed, it
                belongs to the account.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setSettingsTier("account"); setSection("strategy"); }}
                >
                  Open Strategy ›
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setSettingsTier("account"); setSection("risk"); }}
                >
                  Open Guardrails ›
                </Button>
              </div>
              <p className="mt-2 border-t border-line/60 pt-2 text-[11px] text-faint">
                Rule of thumb: if it changes how a trade is decided or placed → account. Everything else is
                here in Settings.
              </p>
            </div>
          )}

          {settingsTier === "user" && (
            <button
              type="button"
              role="switch"
              aria-checked={snapshot.autoResumeOnBoot}
              onClick={() => void setAutoResumeOnBoot(!snapshot.autoResumeOnBoot)}
              className={cn(
                "group flex w-full cursor-pointer select-none items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:flex-col max-sm:items-start",
                snapshot.autoResumeOnBoot
                  ? "border-accent/45 bg-accent/10 hover:bg-accent/15 active:bg-accent/20"
                  : "border-line/70 bg-bg/35 hover:border-accent/45 hover:bg-accent/8 active:bg-accent/12"
              )}
            >
              <span className="min-w-0 leading-snug">
                <span className={cn("block text-sm font-medium transition-colors", snapshot.autoResumeOnBoot ? "text-accent" : "text-fg group-hover:text-accent")}>Resume strategy on server restart</span>
                <span className="block text-xs text-faint transition-colors group-hover:text-muted">
                  When enabled, accounts left in &ldquo;active&rdquo; state will auto-resume on server boot. When off (default), every restart requires manually re-arming autonomy.
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                  snapshot.autoResumeOnBoot ? "bg-accent" : "bg-surface-3 group-hover:bg-surface-2"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                    snapshot.autoResumeOnBoot ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </span>
            </button>
          )}

          <div className="overflow-x-auto overscroll-x-contain">
            <Tabs
              value={section}
              onChange={(v) => setSection(v as SettingsSection)}
              className="w-max min-w-full border-line/70 bg-bg/45 p-0.5 sm:min-w-0"
              tabClassName="max-sm:flex-1 max-sm:px-2"
              tabs={
                settingsTier === "user"
                  ? [
                      { id: "connections", label: "Connections" },
                      { id: "display", label: "Appearance" },
                      { id: "notifications", label: "Alert delivery" },
                      { id: "data", label: "Data & Privacy" }
                    ]
                  : [
                      { id: "strategy", label: "Strategy" },
                      { id: "operate", label: "Operate" },
                      { id: "risk", label: "Safety" },
                      { id: "tax", label: "Tax" },
                      { id: "tuning", label: "Tuning" }
                    ]
              }
            />
          </div>
        </div>

        {settingsTier === "account" && <>

        {section === "strategy" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-surface-2/45 p-3">
              <div className="flex flex-wrap items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                  <BrainCircuit size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-fg">Strategy Studio</div>
                  <p className="mt-1 text-[13px] text-muted">
                    Prompt, Green/Red Team models, reasoning effort, scoring weights, and LLM strategy reviews are saved for the selected account&apos;s live strategy.
                  </p>
                  <p className="mt-1 text-xs text-faint">Provider API keys remain under User → Connections because credentials belong to you, not to a single account strategy.</p>
                </div>
                <Button size="sm" variant="ghost" className="sm:ml-auto" onClick={openStrategyStudio}>
                  <BrainCircuit size={14} /> Open Strategy Studio
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <KeyVal label="Green Team" value={policy.llmModel ?? DEFAULT_LLM_MODEL} />
              <KeyVal label="Red Team" value={policy.redTeamLlmModel || "Same as Green Team"} />
              <KeyVal label="Reasoning" value={(policy.llmReasoningEffort ?? "medium").replace(/^./, (c) => c.toUpperCase())} />
            </div>
          </div>
        )}

        {section === "operate" && (
          <div className="grid gap-3 sm:grid-cols-2">
          <div className={cn(
            "rounded-lg border px-3 py-2.5 text-[13px] sm:col-span-2",
            executionState.mode === "broker/paper"
              ? "border-up/30 bg-up/8 text-up"
              : executionState.mode === "broker/live"
                ? "border-down/40 bg-down/8 text-down"
                : "border-info/30 bg-info/8 text-info"
          )}>
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <Shield size={14} className="shrink-0" />
              {executionState.label} mode is active
            </div>
            <p className="opacity-80">
              {executionState.clarification}
            </p>
          </div>
          <Field label="Base Indexes" hint={`${settingsAllowedUniverse.approximate ? "About " : ""}${allowedCount} symbol${allowedCount === 1 ? "" : "s"} allowed after ignores`} className="sm:col-span-2">
            <div className="grid gap-2 sm:grid-cols-3">
              {SUPPORTED_INDEX_UNIVERSES.map((index) => {
                const selected = policy.includedIndices.includes(index);
                return (
                  <button
                    key={index}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleIndex(index, !selected)}
                    className={cn(
                      "flex min-h-16 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-info",
                      selected
                        ? "border-info/60 bg-info/15 text-fg shadow-[inset_0_0_0_1px_rgba(96,165,250,0.22)]"
                        : "border-line bg-bg/60 text-muted hover:border-accent/50 hover:bg-surface-2/70 hover:text-fg"
                    )}
                  >
                    <span>
                      <span className="block font-semibold">{INDEX_UNIVERSES[index].label}</span>
                      <span className={cn("block text-xs", selected ? "text-muted" : "text-faint")}>
                        {INDEX_UNIVERSES[index].dynamicSource ? "about " : ""}{indexUniverseSymbolCount(index)} symbols
                      </span>
                    </span>
                    <span className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition",
                      selected ? "border-info bg-info text-bg" : "border-line bg-surface-3/50 text-faint"
                    )}>
                      {selected ? <Check size={16} /> : <Plus size={16} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid gap-3 sm:col-span-2 lg:grid-cols-2">
            <Field label="Additional Watchlist" hint="Adds individual tickers on top of the selected base indexes">
              <div className="rounded-lg border border-line bg-bg/60 p-2 focus-within:border-accent">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {policy.additionalSymbols.map((s) => (
                    <button type="button" key={s} onClick={() => updatePolicy({ additionalSymbols: policy.additionalSymbols.filter((x) => x !== s) })} className="inline-flex items-center gap-1 rounded-md bg-surface-3/50 backdrop-blur-md px-2 py-0.5 text-xs text-fg">
                      {s} <X size={14} />
                    </button>
                  ))}
                </div>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value.toUpperCase())}
                  onBlur={addAllowlist}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addAllowlist();
                    }
                  }}
                  placeholder="Add ticker, press Enter"
                  className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint disabled:opacity-50"
                />
              </div>
            </Field>
            <Field label="Ignore List" hint="Subtracts symbols from the selected indexes and watchlist">
              <div className="rounded-lg border border-line bg-bg/60 p-2 focus-within:border-accent">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(policy.blocklist || []).map((s) => (
                    <button type="button" key={s} onClick={() => updatePolicy({ blocklist: (policy.blocklist || []).filter((x) => x !== s) })} className="inline-flex items-center gap-1 rounded-md bg-down/20 px-2 py-0.5 text-xs font-medium text-down">
                      {s} <X size={14} />
                    </button>
                  ))}
                </div>
                <input
                  value={blockDraft}
                  onChange={(e) => setBlockDraft(e.target.value.toUpperCase())}
                  onBlur={addBlocklist}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addBlocklist();
                    }
                  }}
                  placeholder="Add ticker to ignore"
                  className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint disabled:opacity-50"
                />
              </div>
            </Field>
          </div>
          <Field label="Approval Mode" hint="Propose Mode stages orders for approval. Autonomous Mode can execute while the system is running." className="sm:col-span-2">
            <select
              className={inputClass}
              value={policy.strategyAuthority}
              onChange={(e) => {
                const next = e.target.value as TradingPolicy["strategyAuthority"];
                if (next === "decide" && policy.strategyAuthority !== "decide") {
                  onRequestDecideConfirm();
                } else {
                  void updatePolicy({ strategyAuthority: next });
                }
              }}
            >
              <option value="propose">Propose Mode — you approve each order</option>
              <option value="decide">Autonomous Mode — auto-executes while running</option>
            </select>
          </Field>
          <Field label="Holding Horizon" hint="Prompt guidance for the LLM: shapes setup, exit, and tax framing; hard risk limits still come from Risk settings" className="sm:col-span-2">
            <select className={inputClass} value={policy.holdingHorizon ?? "swing"} onChange={(e) => updatePolicy({ holdingHorizon: e.target.value as TradingPolicy["holdingHorizon"] })}>
              <option value="intraday">Intraday — day trades</option>
              <option value="swing">Days to weeks — swing trades</option>
              <option value="position">Weeks to months — position trades</option>
              <option value="longterm">Months to years — long-term (favors long-term tax treatment)</option>
            </select>
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              variant={policy.systemState === "active" ? "ghost" : "primary"}
              disabled={policy.systemState !== "active" && Boolean(enableBlockedReason)}
              title={policy.systemState !== "active" ? enableBlockedReason : undefined}
              onClick={onRequestSystemToggle}
            >
              {policy.systemState === "active" ? <Pause size={16} /> : <Play size={16} />} {policy.systemState === "active" ? "Stop System" : "Start System"}
            </Button>
            {/* Mode follows the account selected in the top-bar dropdown (Paper / Brokerage); no separate mode toggle. */}
          </div>
          {enableBlockedReason && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn sm:col-span-2"><AlertTriangle size={14} className="mr-1 inline" />Setup required: {enableBlockedReason}</p>
          )}
          </div>
        )}

        {section === "risk" && (
          <div className="space-y-4">
            <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[13px] text-muted">
              These guards are <strong>enforced by the engine</strong> on every run. Leaving a value blank means
              that guard is <strong>off</strong> (except where a default is noted). All caps apply to OPENING trades
              only — a risk-reducing exit is never blocked.
            </p>

            {/* Account circuit breakers */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold text-fg">Account circuit breakers</div>
                <p className="mt-0.5 text-xs text-faint">Hard-halt autonomous trading when breached, until you re-arm (default). Blank = off.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <OptionalNumberField label="Max drawdown %" value={policy.riskRules.maxDrawdownPct} placeholder="off" step={0.5} hint="If the account falls this far from its equity high-water mark, the engine logs a receipt and surfaces the drawdown to the agent, which decides how to react (default: advisory, no auto-halt). Blank disables this breaker." onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, maxDrawdownPct: v } })} />
                <OptionalNumberField label="Max daily loss ($)" value={policy.riskRules.maxDailyLossNotional} placeholder="off" step={50} hint="If realized plus open daily loss reaches this dollar amount, the engine logs a receipt and tells the agent, which decides (default: advisory, no auto-halt). Blank disables this breaker." onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, maxDailyLossNotional: v } })} />
              </div>
            </div>

            {/* Volatility panic brake */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <label className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-sm font-semibold text-fg">Volatility panic brake</span>
                  <span className="block text-xs text-faint">Auto-switch to close-only on a volatility tail extreme. On by default. Blank threshold = built-in default.</span>
                </span>
                <Switch checked={policy.volPanicBrakeEnabled !== false} onChange={(v) => updatePolicy({ volPanicBrakeEnabled: v })} />
              </label>
              {policy.volPanicBrakeEnabled !== false && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <OptionalNumberField label="VIX ≥" value={policy.volPanicVixThreshold} placeholder="40" step={1} hint="VIX tail-risk threshold for the volatility panic brake. Blank uses the built-in default of 40." onCommit={(v) => updatePolicy({ volPanicVixThreshold: v })} />
                  <OptionalNumberField label="VVIX ≥" value={policy.volPanicVvixThreshold} placeholder="150" step={1} hint="Volatility-of-volatility threshold for the panic brake. Blank uses the built-in default of 150." onCommit={(v) => updatePolicy({ volPanicVvixThreshold: v })} />
                  <OptionalNumberField label="SKEW ≥" value={policy.volPanicSkewThreshold} placeholder="160" step={1} hint="Cboe SKEW tail-risk threshold for the panic brake. Blank uses the built-in default of 160." onCommit={(v) => updatePolicy({ volPanicSkewThreshold: v })} />
                </div>
              )}
            </div>

            {/* Whole-portfolio exposure */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold text-fg">Whole-portfolio exposure caps</div>
                <p className="mt-0.5 text-xs text-faint"><strong>Default 80%</strong> keeps ~20% cash — raise to 100 for full deployment.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <OptionalNumberField label="Max gross exposure %" value={policy.maxGrossExposurePct} placeholder="80" step={1} hint="Caps total absolute exposure: sum of long value plus absolute short value. Default 80% keeps cash available; shorting makes this especially important." onCommit={(v) => updatePolicy({ maxGrossExposurePct: v })} />
                <OptionalNumberField label="Max net exposure %" value={policy.maxNetExposurePct} placeholder="80" step={1} hint="Caps directional exposure: long value minus short value. Net can be lower than gross when shorts offset longs." onCommit={(v) => updatePolicy({ maxNetExposurePct: v })} />
              </div>
            </div>

            {/* Stops & exits */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold text-fg">Stops &amp; exits</div>
                <p className="mt-0.5 text-xs text-faint">Stop-loss / take-profit % live under Strategy → Key Parameters. These tune the additional exit types.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <OptionalNumberField label="Trailing stop %" value={policy.riskRules.trailingStopPct || undefined} placeholder="off" step={0.5} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, trailingStopPct: v ?? 0 } })} />
                <NumberField label="Take-profit trim %" value={policy.riskRules.takeProfitTrimPct ?? 50} min={1} max={100} step={5} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitTrimPct: v } })} />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                <span>
                  <span className="block text-sm font-medium text-fg">ATR (volatility) stops</span>
                  <span className="block text-xs text-faint">Set the stop distance from the name&apos;s own realized daily range (ATR) instead of a flat %. Falls back to the fixed/beta stop when bars are unavailable.</span>
                </span>
                <Switch checked={Boolean(policy.atrStops)} onChange={(v) => updatePolicy({ atrStops: v })} />
              </label>
              {policy.atrStops && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <OptionalNumberField label="ATR period (days)" value={policy.riskRules.atrStopPeriod} placeholder="14" step={1} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, atrStopPeriod: v } })} />
                  <OptionalNumberField label="ATR multiple" value={policy.riskRules.atrStopMultiple} placeholder="2.0" step={0.1} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, atrStopMultiple: v } })} />
                </div>
              )}
              {(activeAccount?.broker === "robinhood") && (
                <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                  <span>
                    <span className="block text-sm font-medium text-fg">Robinhood broker-held stop</span>
                    <span className="block text-xs text-faint">Place a resting stop-market at the broker (long positions, live only) so the stop survives app downtime — Robinhood can&apos;t hold OCO brackets.</span>
                  </span>
                  <Switch checked={Boolean(policy.robinhoodBrokerStops)} onChange={(v) => updatePolicy({ robinhoodBrokerStops: v })} />
                </label>
              )}
              {/* Per-broker stop-support — what actually protects a position on the active account */}
              <div className="rounded-lg border border-line bg-surface-1/60 px-3 py-2 text-xs text-muted">
                <span className="block font-medium text-fg">Stop support on {activeAccount ? (activeAccount.broker === "alpaca" || activeAccount.broker === "alpaca-mcp" ? "Alpaca" : activeAccount.broker === "robinhood" ? "Robinhood" : "Test/paper") : "this account"}:</span>
                {activeAccount?.broker === "alpaca" || activeAccount?.broker === "alpaca-mcp" ? (
                  <span className="block">Native <strong>OCO brackets</strong> (broker-held stop-loss + take-profit, survive downtime) when &quot;Broker-held brackets&quot; is on and a stop-loss % is set. Trailing stops are app-managed.</span>
                ) : activeAccount?.broker === "robinhood" ? (
                  <span className="block">No OCO brackets. Optional broker-held <strong>protective stop-market</strong> (toggle above, long-only, live). Everything else (trailing, take-profit, beta/ATR) is app-managed. No short selling.</span>
                ) : (
                  <span className="block"><strong>All stops are simulated by the app</strong> in Test/paper — nothing rests at a broker. Connect a live Alpaca/Robinhood account for broker-held protection.</span>
                )}
                <span className="mt-1 block text-faint">Anything <em>not</em> resting at the broker (trailing, beta/ATR, take-profit trims — and fixed % on brokers without a resting stop) is app-managed and only fires while this app is running.</span>
              </div>
            </div>

            {/* Short-selling sub-limits */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold text-fg">Short-selling limits</div>
                <p className="mt-0.5 text-xs text-faint">Apply only when &quot;Enable short selling&quot; (Strategy → Key Parameters) is on. A short stop-loss % is <strong>required</strong> — without it every short is rejected.</p>
              </div>
              {policy.shortSellingEnabled && !(policy.riskRules.shortStopLossPct && policy.riskRules.shortStopLossPct > 0) && (
                <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn"><AlertTriangle size={14} className="mr-1 inline" />Short selling is on but no short stop-loss % is set — every short proposal will be rejected until you set one below.</p>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <OptionalNumberField label="Short stop-loss %" value={policy.riskRules.shortStopLossPct} placeholder="required" step={0.5} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, shortStopLossPct: v } })} />
                <OptionalNumberField label="Max short order ($)" value={policy.maxShortOrderNotional} placeholder="off" step={50} onCommit={(v) => updatePolicy({ maxShortOrderNotional: v })} />
                <OptionalNumberField label="Max short exposure %" value={policy.maxShortExposurePct} placeholder="off" step={1} onCommit={(v) => updatePolicy({ maxShortExposurePct: v })} />
              </div>
            </div>

            {/* Order execution */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold text-fg">Order execution</div>
                <p className="mt-0.5 text-xs text-faint">What order types are allowed and how entries are routed.</p>
              </div>
              {/* Not a <Field> — Field is a <label>, and nesting the per-type checkbox <label>s inside it would make
                  a stray click on the heading/padding toggle the first checkbox. Use a plain container. */}
              <div className="block space-y-1.5">
                <span className="block text-xs font-medium text-muted">Permitted order types</span>
                <div className="flex flex-wrap gap-3">
                  {(["market", "limit", "stop_market", "stop_limit"] as const).map((t) => {
                    const types = policy.permittedOrderTypes ?? ["market", "limit"];
                    const on = types.includes(t);
                    return (
                      <label key={t} className="flex items-center gap-1.5 text-sm text-muted">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const next = e.target.checked ? Array.from(new Set([...types, t])) : types.filter((x) => x !== t);
                            updatePolicy({ permittedOrderTypes: next });
                          }}
                        />
                        {t.replace("_", "-")}
                      </label>
                    );
                  })}
                </div>
                <span className="block text-xs text-faint">A proposal whose type is not permitted is blocked. Most accounts only need market + limit.</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <OptionalNumberField label="Max order % of ADV" value={policy.maxOrderPctOfAdv} placeholder="off" step={0.5} onCommit={(v) => updatePolicy({ maxOrderPctOfAdv: v })} />
                <OptionalNumberField label="Stale limit alert (min)" value={policy.staleLimitOrderMinutes} placeholder="15" step={1} onCommit={(v) => updatePolicy({ staleLimitOrderMinutes: v })} />
              </div>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                <span>
                  <span className="block text-sm font-medium text-fg">Allow extended-hours ORDERS</span>
                  <span className="block text-xs text-faint">Permit non-regular-hours order placement. Separate from &quot;Run during extended hours&quot; (which only lets a run start). Dollar/fractional orders stay regular-hours only regardless.</span>
                </span>
                <Switch checked={Boolean(policy.permitExtendedHours)} onChange={(v) => updatePolicy({ permitExtendedHours: v })} />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                <span>
                  <span className="block text-sm font-medium text-fg">Marketable limit entries</span>
                  <span className="block text-xs text-faint">Rewrite opening market orders as a marketable limit (caps slippage). Requires &quot;limit&quot; in permitted order types.</span>
                </span>
                <Switch checked={Boolean(policy.marketableLimitEntries)} onChange={(v) => updatePolicy({ marketableLimitEntries: v })} />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
                <span>
                  <span className="block text-sm font-medium text-fg">Fire synthetic stops in extended hours</span>
                  <span className="block text-xs text-faint">Let the app-managed stop monitor place protective exits during pre/post-market. Off = regular hours only.</span>
                </span>
                <Switch checked={Boolean(policy.allowExtendedHoursSyntheticStops)} onChange={(v) => updatePolicy({ allowExtendedHoursSyntheticStops: v })} />
              </label>
            </div>

            {/* Universe floor (penny / illiquid exclusion) */}
            <div className="rounded-lg border border-line bg-surface-2/45 p-3 space-y-3">
              <div>
                <div className="text-sm font-semibold text-fg">Universe floor (exclude penny / illiquid names)</div>
                <p className="mt-0.5 text-xs text-faint">Filters the SCANNED candidates only. Watchlist symbols and holdings are always exempt.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <OptionalNumberField label="Min share price $" value={policy.universeFloor?.minPrice} placeholder="off" step={0.5} hint="Primary penny-stock gate for scanned candidates. Explicit watchlist symbols and current holdings are exempt so exits are never trapped." onCommit={(v) => updatePolicy({ universeFloor: { ...policy.universeFloor, minPrice: v } })} />
                <OptionalNumberField label="Min market cap $" value={policy.universeFloor?.minMarketCapUsd} placeholder="off" step={1_000_000} hint="Filters scanned candidates below this market cap only when market-cap data is known. Missing data does not false-exclude a symbol." onCommit={(v) => updatePolicy({ universeFloor: { ...policy.universeFloor, minMarketCapUsd: v } })} />
                <OptionalNumberField label="Min daily $-volume" value={policy.universeFloor?.minDollarVolume} placeholder="off" step={100_000} hint="Filters scanned candidates below this recent daily dollar-volume only when volume data is known. Explicit watchlist names and holdings are exempt." onCommit={(v) => updatePolicy({ universeFloor: { ...policy.universeFloor, minDollarVolume: v } })} />
              </div>
            </div>
          </div>
        )}
        </>}

        {settingsTier === "user" && <>

        {section === "connections" && (
          <div className="space-y-4">
            <ApiKeysSection policy={policy} />
          </div>
        )}

        {section === "display" && (
          <div className="space-y-3">
            <Field label="Account-mode banner" hint="The Test / Paper / Brokerage banner at the very top. Full is the standard size, Compact uses less vertical space, and Hidden removes it entirely.">
              <Segmented<ExecutionBannerMode>
                value={executionBannerMode}
                onChange={setExecutionBannerMode}
                options={[
                  { value: "full", label: "Full" },
                  { value: "compact", label: "Compact" },
                  { value: "hidden", label: "Hidden" }
                ]}
              />
            </Field>
            <Field label="Ticker Logos" hint="Shown wherever tickers appear: portfolio, market scan, decisions, congressional and insider trades, and more. Option 1 uses a tile; Option 2 uses the transparent logo style.">
              <Segmented<TickerLogoDisplay>
                value={tickerLogoDisplay}
                onChange={setTickerLogoDisplay}
                options={[
                  { value: "tile", label: "Option 1" },
                  { value: "transparent", label: "Option 2" },
                  { value: "off", label: "Off" }
                ]}
              />
            </Field>
            {tickerLogoDisplay !== "off" && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-bg/60 px-3 py-3">
                {(["AAPL", "MSFT", "NVDA", "BRK.B"] as const).map((symbol) => (
                  <div key={symbol} className="inline-flex items-center gap-2 text-sm font-semibold text-fg">
                    <TickerLogo symbol={symbol} display={tickerLogoDisplay} size="md" />
                    <span>{symbol}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </>}

        {settingsTier === "account" && <>

      {section === "tax" && (
        <div className="space-y-3">
          <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[13px] text-muted">
            Estimates only — not tax advice. These settings tune the after-tax signals the agent sees and the wash-sale guardrail.
          </p>
          <Field label="Account tax treatment" hint="Account-level classification used for estimated tax and wash-sale behavior. IRAs are tax-sheltered in this app: 0% estimated tax and no in-account wash-sale lockout; taxable losses can still lock rebuys across accounts.">
            <select
              className={inputClass}
              value={taxSettings.taxationType ?? "taxable"}
              onChange={(e) => updatePolicy({ taxSettings: { ...taxSettings, taxationType: e.target.value as "taxable" | "roth_ira" | "traditional_ira" } })}
            >
              <option value="taxable">Taxable (brokerage)</option>
              <option value="roth_ira">Roth IRA — tax-free</option>
              <option value="traditional_ira">Traditional IRA — tax-deferred</option>
            </select>
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Wash-sale guard</span>
              <span className="block text-xs text-faint">Block rebuying a symbol sold at a loss within 30 days.</span>
            </span>
            <Switch checked={taxSettings.washSaleGuard} onChange={(v) => updatePolicy({ taxSettings: { ...taxSettings, washSaleGuard: v } })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Short-term rate (%)" value={taxSettings.shortTermRatePct} hint="Rough ordinary-income tax rate used for short-term realized gain estimates in taxable accounts. Default 24%." onCommit={(v) => updatePolicy({ taxSettings: { ...taxSettings, shortTermRatePct: v } })} />
            <NumberField label="Long-term rate (%)" value={taxSettings.longTermRatePct} hint="Rough capital-gains rate used for lots held at least one year in taxable accounts. Default 15%." onCommit={(v) => updatePolicy({ taxSettings: { ...taxSettings, longTermRatePct: v } })} />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Subtract estimated tax from results</span>
              <span className="block text-xs text-faint">Show realized P&amp;L net of the estimated tax burden.</span>
            </span>
            <Switch checked={Boolean(taxSettings.subtractFromResults)} onChange={(v) => updatePolicy({ taxSettings: { ...taxSettings, subtractFromResults: v } })} />
          </label>
        </div>
      )}

      {section === "tuning" && (
        <div className="space-y-3">
          <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[13px] text-muted">
            Advanced learning-loop knobs that are otherwise fixed code defaults. Leave these alone unless you understand the trade-off.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Shrinkage prior (trades)"
              value={tuning.shrinkPrior ?? 5}
              hint="Bayesian pseudo-trades that pull thin-sample win rate and average return toward neutral. Higher values make the learner more skeptical of a small number of wins or losses. Default 5."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, shrinkPrior: v } })}
            />
            <NumberField
              label="Min lots for weight shift"
              value={tuning.minClosedLotsForWeightShift ?? 20}
              hint="Closed lots are completed trade outcomes for this selected account. The auto-tuner may not change factor/scoring weights until at least this many lots exist, default 20, to avoid overfitting a thin sample. Below the gate it can still suggest prompt or risk-sizing changes."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, minClosedLotsForWeightShift: v } })}
            />
            <NumberField
              label="Sizing floor (% of max)"
              value={tuning.sizingFloorPct ?? 10}
              hint="Lowest exploratory position size the deterministic sizer will use for an unproven or weakly supported thesis, expressed as a percent of the configured max order size. Default 10%."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, sizingFloorPct: v } })}
            />
            <NumberField
              label="Sizing ceiling (% of max)"
              value={tuning.sizingCeilingPct ?? 100}
              hint="Highest size the deterministic sizer may allocate before normal risk caps apply, expressed as a percent of max order size. Default 100%."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, sizingCeilingPct: v } })}
            />
            <NumberField
              label="Red-team threshold"
              value={tuning.redTeamConvictionThreshold ?? 80}
              hint="Proposal confidence at or above this value triggers the adversarial Bear/Red Team review. Default 80."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, redTeamConvictionThreshold: v } })}
            />
            <NumberField
              label="Crisis open cap (% NAV)"
              value={tuning.crisisMaxOpeningExposurePct ?? 0}
              hint="When the deterministic regime is crisis or inverted curve, block new buy/short openings above this percent of portfolio NAV. 0 leaves this crisis-specific cap off."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, crisisMaxOpeningExposurePct: v } })}
            />
            <NumberField
              label="Min proposal score threshold"
              value={tuning.minProposalScoreThreshold ?? 0}
              min={0}
              max={100}
              hint="Drops scan candidates below this 0-100 score before they reach the LLM. If every candidate is below the threshold, the LLM call is skipped and only existing protective exits can fire. Default 0 means no filtering."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, minProposalScoreThreshold: v } })}
            />
            <OptionalNumberField
              label="Daily LLM token budget"
              value={tuning.llmDailyTokenBudget}
              placeholder="blank = inherit default"
              step={1000}
              hint="Hard per-day ceiling on this account's total LLM + RAG token usage. Once today's usage reaches it, the run skips all model + RAG spend for the rest of the day — risk breakers, reconciliation, and protective exits still run. Blank inherits the operator default (TRIGGER_LLM_DAILY_TOKEN_BUDGET env); 0 = no limit (opt out of the default)."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, llmDailyTokenBudget: v } })}
            />
            <OptionalNumberField
              label="Daily LLM cost budget ($)"
              value={tuning.llmDailyCostBudgetUsd}
              placeholder="blank = inherit default"
              step={1}
              hint="Hard per-day ceiling on this account's estimated LLM + RAG cost (USD). Same behavior as the token budget. Blank inherits the operator default (TRIGGER_LLM_DAILY_COST_BUDGET_USD env); 0 = no limit."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, llmDailyCostBudgetUsd: v } })}
            />
            <OptionalNumberField
              label="FCF-yield veto floor %"
              value={tuning.bearVetoFcfYieldFloorPct}
              placeholder="blank disables"
              step={0.5}
              hint="Deterministically vetoes buys whose free-cash-flow yield is below this floor. Example: 0 vetoes negative-FCF buys. Blank disables the veto; missing FCF data never false-vetoes."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, bearVetoFcfYieldFloorPct: v } })}
            />
            <OptionalNumberField
              label="Debt/equity veto ceiling"
              value={tuning.bearVetoDebtToEquityCeiling}
              placeholder="blank disables"
              step={0.5}
              hint="Deterministically vetoes buys whose debt/equity ratio exceeds this ceiling. Example: 3 vetoes names levered above 300%. Blank disables the veto; missing debt/equity data never false-vetoes."
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, bearVetoDebtToEquityCeiling: v } })}
            />
            {tuning.skipNegativeExpectancy && (
              <NumberField
                label="Negative-EV skip threshold %"
                value={tuning.skipNegativeExpectancyEdgePct ?? 0}
                hint="When the negative-EV gate is on, skip opening a proven thesis whose shrunk realized post-cost edge is at or below this percentage. Default 0 skips proven non-positive edge."
                onCommit={(v) => updatePolicy({ tuning: { ...tuning, skipNegativeExpectancyEdgePct: v } })}
              />
            )}
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Skip proven money-losers (negative-EV gate)</span>
              <span className="block text-xs text-faint">Off by default. When on, skip opening a trade whose thesis is already proven to lose money.</span>
            </span>
            <Switch checked={Boolean(tuning.skipNegativeExpectancy)} onChange={(v) => updatePolicy({ tuning: { ...tuning, skipNegativeExpectancy: v } })} />
          </label>
          <p className="text-xs text-faint">
            <span className="font-medium text-muted">Skip proven money-losers</span> — when on, an opening trade is skipped entirely if its thesis is <em>proven</em> (≥ min lots) and its realized post-cost edge is at or below the threshold. Normally the sizer instead downsizes such theses to the exploratory floor to keep gathering data; this is the more conservative &ldquo;don&apos;t open a proven money-loser&rdquo; stance. Unproven theses are never skipped.
          </p>
          <p className="text-xs text-faint">
            Other tunables (scan refresh cadence, congressional/insider lookback windows, scoring sub-score thresholds) are set via environment variables.
          </p>
        </div>
      )}
      </>}

      {settingsTier === "user" && <>

      {section === "data" && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
              <Gauge size={16} />
            </span>
            <div>
              <span className="block text-sm font-medium text-fg">Market Scan candidate set</span>
              <p className="mt-0.5 text-xs text-muted leading-relaxed">
                Controls how many ranked scan rows receive expensive enrichment and are sent to the LLM as the allowed opportunity set.
                Default is {DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT}; expert guardrails allow {MIN_MARKET_SCAN_CANDIDATE_LIMIT}-{MAX_MARKET_SCAN_CANDIDATE_LIMIT}.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              label="Candidate cap"
              value={scanCandidateLimit}
              min={MIN_MARKET_SCAN_CANDIDATE_LIMIT}
              max={MAX_MARKET_SCAN_CANDIDATE_LIMIT}
              step={1}
              hint={`Top-ranked scan rows that receive expensive enrichment and are sent to the LLM as the primary opportunity set. Default ${DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT}; ${MIN_MARKET_SCAN_CANDIDATE_LIMIT}-12 is cost-sensitive, 25-40 is balanced, 60-80 is broad research.`}
              onCommit={(v) => {
                const nextLimit = normalizeMarketScanCandidateLimit(v);
                updatePolicy({
                  marketScanCandidateLimit: nextLimit,
                  marketScanOutlierReserve: normalizeMarketScanOutlierReserve(scanOutlierReserve, nextLimit)
                });
              }}
            />
            <NumberField
              label="Outlier reserve"
              value={scanOutlierReserve}
              min={MIN_MARKET_SCAN_OUTLIER_RESERVE}
              max={scanOutlierMax}
              step={1}
              hint="Added on top of the candidate cap, not swapped inside it. Pulls below-cutoff names with congressional, insider, short-pressure, technical, or statistically extreme price/volume signals. Current holdings are scanned regardless."
              onCommit={(v) => updatePolicy({ marketScanOutlierReserve: normalizeMarketScanOutlierReserve(v, scanCandidateLimit) })}
            />
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Network size={16} />
            </span>
            <div>
              <span className="block text-sm font-medium text-fg">Shared data pool</span>
              <p className="mt-0.5 text-xs text-muted leading-relaxed">
                Opting in shares the general market data you pull with your own provider keys / broker MCP —
                quotes, fundamentals, price history, and news — with other opted-in users, and gives you
                access to the data they&apos;ve pulled (the shared pool). Your personal account data —
                positions, orders, balances, P&amp;L, and credentials — is never shared with other users.
                Credentials remain encrypted and server-only.
              </p>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Sharing</span>
              <span className="block text-xs text-faint">
                {poolConsent === null ? "Loading…" : poolConsent ? "Sharing on — you contribute to and read from the shared pool." : "Sharing off — you use only your own data."}
              </span>
            </span>
            <Switch
              checked={Boolean(poolConsent)}
              onChange={(v) => { if (!poolConsentLoading && poolConsent !== null) void setPoolConsentValue(v); }}
            />
          </label>
          <p className="text-[11px] text-faint">
            Your choice applies immediately. You can toggle sharing at any time.
          </p>

          {/* ── Learned-context (AI learnings) sharing ── */}
          <div className="mt-4 flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Network size={16} />
            </span>
            <div>
              <span className="block text-sm font-medium text-fg">AI-learned facts sharing</span>
              <p className="mt-0.5 text-xs text-muted leading-relaxed">
                Control whether you benefit from other users&apos; shared learnings and whether your own
                learned facts are contributed to the shared pool. Only structural market facts are ever
                shared — risk and strategy directives are never shared. PII is always excluded.
              </p>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Include shared learnings</span>
              <span className="block text-xs text-faint">
                {lcSharing === null ? "Loading…" : lcSharing.includeShared ? "On — your AI decisions include facts shared by other users." : "Off — only your own learned facts are used."}
              </span>
            </span>
            <Switch
              checked={lcSharing?.includeShared ?? true}
              onChange={(v) => { if (!lcSharingLoading && lcSharing !== null) void updateLcSharing({ includeShared: v }); }}
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Contribute my learnings to the shared pool</span>
              <span className="block text-xs text-faint">
                {lcSharing === null ? "Loading…" : lcSharing.contributeShared ? "On — new facts you learn are shared with opted-in users." : "Off — your learned facts stay private."}
              </span>
            </span>
            <Switch
              checked={lcSharing?.contributeShared ?? true}
              onChange={(v) => { if (!lcSharingLoading && lcSharing !== null) void updateLcSharing({ contributeShared: v }); }}
            />
          </label>
          <p className="text-[11px] text-faint">
            Changes apply immediately. Only fact-tier learnings are ever shared — risk and strategy
            directives go through a human approval queue and are never shared automatically.
          </p>
          <AccountDeletionPanel
            signedInEmail={snapshot.currentUser?.email}
            onOpen={() => setAccountDeletionOpen(true)}
          />
        </div>
      )}
      </>}

      {settingsTier === "user" && <>

      {section === "notifications" && (
        <div className="space-y-3">
            <Field label="Alerts webhook">
            <input className={inputClass} value={policy.notificationSettings.webhookUrl ?? ""} onChange={(e) => updatePolicy({ notificationSettings: { ...policy.notificationSettings, webhookUrl: e.target.value } })} placeholder="https://…" />
          </Field>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Send alerts for</span>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(["fill", "block", "run_failed", "pending_approval", "kill_switch", "limit_order_stale", "provider_degraded", "budget_alert"] as const).map((eventType) => {
                const enabled = policy.notificationSettings.enabledEvents.includes(eventType);
                return (
                  <label key={eventType} className="flex min-h-10 items-center gap-2 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 text-sm capitalize text-fg">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={enabled}
                      onChange={(e) => {
                        const events = e.target.checked
                          ? Array.from(new Set([...policy.notificationSettings.enabledEvents, eventType]))
                          : policy.notificationSettings.enabledEvents.filter((x) => x !== eventType);
                        updatePolicy({ notificationSettings: { ...policy.notificationSettings, enabledEvents: events } as NotificationSettings });
                      }}
                    />
                    {eventType.replace("_", " ")}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="border-t border-line pt-3">
            <span className="mb-1.5 block text-xs font-medium text-muted">Direct delivery (email · SMS · push)</span>
            <p className="mb-2 text-[11px] text-faint">
              Send price-alert and event notifications straight to you. Email and SMS require the operator to have configured the
              provider keys. Toggle a channel, enter your target, then Send test to verify delivery.
            </p>
            <DeliveryChannelsPanel />
          </div>
        </div>
      )}
      </>}

      </div>
      <AccountDeletionModal
        open={accountDeletionOpen}
        onClose={() => setAccountDeletionOpen(false)}
        signedInEmail={snapshot.currentUser?.email}
      />
    </>
  );
}

function AccountDeletionPanel({ signedInEmail, onOpen }: { signedInEmail?: string; onOpen: () => void }) {
  return (
    <div className="mt-5 rounded-lg border border-down/35 bg-down/10 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-down/15 text-down">
            <Trash2 size={16} />
          </span>
          <div>
            <div className="text-sm font-semibold text-fg">Delete this app account</div>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
              Deletes app data and stored broker/API connections for {signedInEmail ?? "the signed-in user"}.
              Broker positions, open broker orders, and external login accounts are not deleted.
            </p>
          </div>
        </div>
        <Button variant="danger" size="sm" onClick={onOpen} className="sm:shrink-0">
          <Trash2 size={14} /> Start deletion
        </Button>
      </div>
    </div>
  );
}

function accountDeletionRecordTotal(preview: AccountDeletionPreview | null): number {
  if (!preview) return 0;
  return Object.values(preview.counts ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function accountDeletionBlockerTotal(preview: AccountDeletionPreview | null): number {
  if (!preview) return 0;
  return Object.values(preview.blockers ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function AccountDeletionModal({
  open,
  onClose,
  signedInEmail
}: {
  open: boolean;
  onClose: () => void;
  signedInEmail?: string;
}) {
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [typedEmail, setTypedEmail] = useState("");
  const [typedPhrase, setTypedPhrase] = useState("");
  const [localOperatorPhrase, setLocalOperatorPhrase] = useState("");
  const [ack, setAck] = useState({
    deleteAppData: false,
    deleteBrokerConnections: false,
    understandBrokerPositionsRemain: false,
    understandProviderRevocation: false,
    understandCanSignInAgain: false,
    confirmLocalOperator: false
  });

  const email = preview?.email ?? signedInEmail ?? "";
  const blockers = accountDeletionBlockerTotal(preview);
  const canSubmit =
    Boolean(preview?.prepared) &&
    blockers === 0 &&
    typedEmail.trim().toLowerCase() === email.trim().toLowerCase() &&
    typedPhrase.trim() === ACCOUNT_DELETE_PHRASE &&
    ack.deleteAppData &&
    ack.deleteBrokerConnections &&
    ack.understandBrokerPositionsRemain &&
    ack.understandProviderRevocation &&
    ack.understandCanSignInAgain &&
    (!preview?.isLocalOperatorAccount || (ack.confirmLocalOperator && localOperatorPhrase.trim() === LOCAL_OPERATOR_DELETE_PHRASE));

  const loadPreview = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/account/deletion", { cache: "no-store" });
      if (!response.ok) throw await responseError(response, "Deletion preview failed");
      const next = (await response.json()) as AccountDeletionPreview;
      setPreview(next);
      setStep(next.prepared ? 1 : 0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Deletion preview failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTypedEmail("");
    setTypedPhrase("");
    setLocalOperatorPhrase("");
    setAck({
      deleteAppData: false,
      deleteBrokerConnections: false,
      understandBrokerPositionsRemain: false,
      understandProviderRevocation: false,
      understandCanSignInAgain: false,
      confirmLocalOperator: false
    });
    void loadPreview();
  }, [open, loadPreview]);

  async function prepareDeletion() {
    setSubmitting(true);
    try {
      const response = await fetch("/api/account/deletion", { method: "POST" });
      if (!response.ok) throw await responseError(response, "Deletion preparation failed");
      setPreview((await response.json()) as AccountDeletionPreview);
      setStep(1);
      toast.success("Account deletion prepared.", { description: "The system was halted for this user. Review the final confirmations before deleting." });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Deletion preparation failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteAccount() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/account/deletion", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typedEmail, typedPhrase, localOperatorPhrase, ...ack })
      });
      const body = await response.json().catch(() => ({})) as { logoutUrl?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "Account deletion failed.");
      toast.success("Account deleted.", { description: "Signing out now." });
      window.location.href = body.logoutUrl || "/logout";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Account deletion failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function check(key: keyof typeof ack, label: React.ReactNode) {
    return (
      <label className="flex items-start gap-2 rounded-lg border border-line bg-bg/55 px-3 py-2 text-sm text-muted">
        <input
          type="checkbox"
          className="mt-1 accent-down"
          checked={ack[key]}
          onChange={(e) => setAck((current) => ({ ...current, [key]: e.target.checked }))}
        />
        <span>{label}</span>
      </label>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete app account"
      subtitle={email ? `Signed in as ${email}` : "Verified sign-in required"}
      icon={<Trash2 size={20} />}
      size="lg"
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          {step < 2 ? (
            <Button
              variant={step === 0 ? "primary" : "danger"}
              onClick={() => {
                if (step === 0) void prepareDeletion();
                else setStep(2);
              }}
              disabled={loading || submitting || (step === 1 && blockers > 0)}
            >
              {step === 0 ? <Shield size={16} /> : <Trash2 size={16} />}
              {step === 0 ? "Prepare deletion" : "Continue to final confirmation"}
            </Button>
          ) : (
            <Button variant="danger" onClick={deleteAccount} disabled={!canSubmit || submitting}>
              <Trash2 size={16} /> Permanently delete account
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4 p-5 text-sm text-muted">
        <div className="grid gap-2 sm:grid-cols-3">
          {[
            { label: "1. Review", active: step === 0, done: step > 0 },
            { label: "2. Prepare", active: step === 1, done: step > 1 },
            { label: "3. Confirm", active: step === 2, done: false }
          ].map((item) => (
            <div
              key={item.label}
              className={cn(
                "rounded-lg border px-3 py-2 text-xs font-semibold",
                item.active ? "border-down/40 bg-down/10 text-down" : item.done ? "border-up/30 bg-up/10 text-up" : "border-line bg-surface-2/55 text-muted"
              )}
            >
              {item.done ? <CheckCircle size={14} className="mr-1 inline" /> : null}{item.label}
            </div>
          ))}
        </div>

        {loading && (
          <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]" aria-hidden="true">
            {[0, 1].map((col) => (
              <div key={col} className="rounded-lg border border-line bg-surface-2/45 p-3">
                <div className="skeleton mb-2 h-4 w-2/3 rounded" />
                <div className="space-y-1.5">
                  <div className="skeleton h-3 w-full rounded" />
                  <div className="skeleton h-3 w-11/12 rounded" />
                  <div className="skeleton h-3 w-4/5 rounded" />
                </div>
              </div>
            ))}
          </div>
        )}
        {loading && <span className="sr-only" role="status">Loading deletion preview…</span>}

        {preview && (
          <div className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-lg border border-line bg-surface-2/45 p-3">
              <div className="mb-2 text-sm font-semibold text-fg">What will be deleted from this app</div>
              <ul className="space-y-1.5 text-xs leading-relaxed">
                <li><CheckCircle size={14} className="mr-1 inline text-up" />Stored API keys, broker links, and Robinhood MCP OAuth tokens for this user.</li>
                <li><CheckCircle size={14} className="mr-1 inline text-up" />Settings, strategy profiles, watchlists, alerts, chat history, memories, proposals, fills, snapshots, notifications, and private learned context.</li>
                <li><XCircle size={14} className="mr-1 inline text-warn" />Broker positions, open broker orders, and Google, GitHub, or Apple login accounts are not deleted by this app.</li>
              </ul>
              <div className="mt-3 rounded-lg border border-line bg-bg/55 px-3 py-2 text-xs text-faint">
                {preview.connectedAccounts.length} connection{preview.connectedAccounts.length === 1 ? "" : "s"} and about {accountDeletionRecordTotal(preview)} private app row{accountDeletionRecordTotal(preview) === 1 ? "" : "s"} are in scope.
              </div>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/45 p-3">
              <div className="mb-2 text-sm font-semibold text-fg">Sign-in and provider access</div>
              <p className="text-xs leading-relaxed">
                Signing in later with Google, GitHub, or Apple can create a fresh empty app account after this deletion. To remove the OAuth grant too, revoke this app in your Google Account third-party access page, GitHub Authorized OAuth Apps, or Apple ID Sign in with Apple settings.
              </p>
              {preview.isLocalOperatorAccount && (
                <p className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                  This is the local operator dataset shared by the primary email aliases. It includes legacy app data and requires one extra typed phrase.
                </p>
              )}
            </div>
          </div>
        )}

        {preview && blockers > 0 && (
          <div className="rounded-lg border border-warn/35 bg-warn/10 px-3 py-2 text-xs text-warn">
            <AlertTriangle size={14} className="mr-1 inline" />
            Deletion is blocked until trading activity settles:
            {" "}
            {preview.blockers.runningStrategyRuns} running strategy run(s), {preview.blockers.placingProposals} placing proposal(s), {preview.blockers.pendingReconciliationFills} fill(s) pending broker reconciliation, and {preview.blockers.activeMobileCommands} in-flight mobile command(s).
          </div>
        )}

        {step === 0 && (
          <div className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-xs leading-relaxed text-muted">
            Preparing deletion halts this user's system and clears its run lock. It does not delete anything yet.
          </div>
        )}

        {step >= 1 && (
          <div className="space-y-2 rounded-lg border border-line bg-surface-2/45 p-3">
            <div className="text-sm font-semibold text-fg">Required acknowledgements</div>
            {check("deleteAppData", "Delete my app data for this signed-in user.")}
            {check("deleteBrokerConnections", "Delete stored broker/API connections from this app.")}
            {check("understandBrokerPositionsRemain", "I understand broker positions and open broker orders are not closed or cancelled.")}
            {check("understandProviderRevocation", "I understand I may need to revoke Google, GitHub, Apple, or broker access in those provider settings too.")}
            {check("understandCanSignInAgain", "I understand signing in again later can create a fresh empty app account.")}
            {preview?.isLocalOperatorAccount && check("confirmLocalOperator", "I understand this deletes the local operator dataset shared by primary aliases.")}
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type signed-in email">
              <input className={inputClass} value={typedEmail} onChange={(e) => setTypedEmail(e.target.value)} placeholder={email || "email@example.com"} />
            </Field>
            <Field label={`Type ${ACCOUNT_DELETE_PHRASE}`}>
              <input className={inputClass} value={typedPhrase} onChange={(e) => setTypedPhrase(e.target.value)} placeholder={ACCOUNT_DELETE_PHRASE} />
            </Field>
            {preview?.isLocalOperatorAccount && (
              <Field label={`Type ${LOCAL_OPERATOR_DELETE_PHRASE}`} className="sm:col-span-2">
                <input className={inputClass} value={localOperatorPhrase} onChange={(e) => setLocalOperatorPhrase(e.target.value)} placeholder={LOCAL_OPERATOR_DELETE_PHRASE} />
              </Field>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── Form controls ───────────────────────── */

function NumberField({ label, value, min = 0, max, step = 1, hint, onCommit }: { label: string; value?: number; min?: number; max?: number; step?: number; hint?: React.ReactNode; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => setDraft(String(value ?? 0)), [value]);
  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value ?? 0));
      return;
    }
    const clamped = Math.max(min, Math.min(max ?? parsed, parsed));
    onCommit(clamped);
  }
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={inputClass}
      />
    </Field>
  );
}

function OptionalNumberField({ label, value, placeholder, step, hint, onCommit }: { label: string; value?: number; placeholder?: string; step?: number; hint?: React.ReactNode; onCommit: (v: number | undefined) => void }) {
  const [draft, setDraft] = useState(value !== undefined ? String(value) : "");
  useEffect(() => setDraft(value !== undefined ? String(value) : ""), [value]);
  function commit() {
    if (draft.trim() === "") { onCommit(undefined); return; }
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) onCommit(n);
    else setDraft(value !== undefined ? String(value) : "");
  }
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min="0"
        step={step ?? 1}
        value={draft}
        placeholder={placeholder ?? "blank disables"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className={inputClass}
      />
    </Field>
  );
}

function RangeField({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const safe = Math.max(min, Math.min(max, draft));
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase text-faint">{label}</span>
        <span className="tnum text-[13px] text-fg">{Number.isInteger(safe) ? safe : safe.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safe}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={() => onCommit(safe)}
        onTouchEnd={() => onCommit(safe)}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow")) onCommit(safe);
        }}
        className="mt-1.5 w-full accent-accent"
      />
    </div>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */

function getProposalAccountLabel(accountNumber: string | undefined, connectedAccounts: ConnectedAccount[] | undefined): string {
  if (!accountNumber) return "";
  const acc = connectedAccounts?.find(
    (a) => a.accountNumber === accountNumber || (a.accountNumber && accountNumber && (a.accountNumber.endsWith(accountNumber) || accountNumber.endsWith(a.accountNumber)))
  );
  
  const last4 = accountNumber.slice(-4);
  const suffix = `x${last4}`;
  
  if (acc) {
    if (acc.broker === "robinhood") {
      return `Agentic ${suffix}`;
    }
    if (acc.broker === "alpaca" || acc.broker === "alpaca-mcp") {
      return acc.environment === "paper" ? `Paper ${suffix}` : `Brokerage ${suffix}`;
    }
    if (acc.broker === "test") {
      return `Test ${suffix}`;
    }
  }
  
  if (accountNumber === "test" || accountNumber.toLowerCase().includes("test")) {
    return `Test ${suffix}`;
  }
  if (accountNumber.startsWith("PA")) {
    return `Paper ${suffix}`;
  }
  return `Brokerage ${suffix}`;
}

function executionModeLabel(mode: ExecutionMode | undefined): string {
  if (mode === "broker/paper") return "Paper";
  if (mode === "broker/live") return "Brokerage";
  return "No Account";
}

function getPortfolioAccountSubtitle(snapshot: DashboardSnapshot): string {
  const activeAcc = activeConnectedAccountFor(snapshot);
  if (!activeAcc) {
    return "No Account Connected";
  }
  if (activeAcc.broker === "robinhood") {
    return "Robinhood Agentic Account";
  }
  if (activeAcc.broker === "alpaca" || activeAcc.broker === "alpaca-mcp") {
    return activeAcc.environment === "paper" ? "Alpaca Paper Account" : "Alpaca Brokerage Account";
  }
  return `${activeAcc.label} Account`;
}

function statusTone(status: string): "up" | "down" | "warn" | "accent" | "neutral" {
  if (status === "filled" || status === "paper" || status === "approved" || status === "completed") return "up";
  if (status === "blocked" || status === "rejected" || status === "failed" || status === "canceled" || status === "cancelled" || status === "expired" || status === "withdrawn") return "down";
  if (status === "pending_approval" || status === "pending" || status === "proposed" || status === "pending_order" || status === "pending_reconciliation" || status === "partially_filled" || status === "placing" || status === "placing_failed" || status === "placed") return "warn";
  return "neutral";
}

function displayStatus(status: string): string {
  if (status === "paper") return "TEST";
  const labels: Record<string, string> = {
    pending_approval: "Pending approval",
    pending_order: "Working",
    pending_reconciliation: "Working",
    partially_filled: "Partially filled",
    placing_failed: "Placement uncertain",
    placed: "Submitted",
    proposed: "Proposed",
    rejected: "Rejected",
    blocked: "Blocked",
    expired: "Expired",
    withdrawn: "Withdrawn",
    filled: "Filled",
    failed: "Failed",
    completed: "Completed",
    approved: "Approved",
    canceled: "Canceled",
    cancelled: "Canceled"
  };
  return labels[status] ?? labelize(status);
}

function readableOrderState(state: string): string {
  return state.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function proposalSize(proposal: TradeProposal, estimatedNotional?: number, price?: number): string {
  // Show the estimated total cost AND the share count. The "~" means it's an estimate
  // (fill price can differ). Shares use the app-wide formatter (up to 3 significant
  // figures, trailing zeros stripped — e.g. 0.5, 0.25, 1.5).
  const px = price && price > 0 ? price : proposal.limitPrice && proposal.limitPrice > 0 ? proposal.limitPrice : undefined;
  // Ignore the "price unavailable" over-cap sentinel (Number.MAX_SAFE_INTEGER) and any non-finite
  // value — it is an internal "can't size this" flag, not a real estimate, and must never render as
  // a dollar figure (it once showed as "~$9,007,199,254,740,991.00").
  const safeNotional =
    typeof estimatedNotional === "number" && Number.isFinite(estimatedNotional) && estimatedNotional < Number.MAX_SAFE_INTEGER
      ? estimatedNotional
      : undefined;
  const cost = proposal.dollarAmount ?? safeNotional ?? (proposal.quantity && px ? proposal.quantity * px : undefined);
  const shares = proposal.quantity ?? (cost && px ? cost / px : undefined);
  if (typeof cost === "number" && cost > 0 && typeof shares === "number" && shares > 0) {
    return `~${money(cost)} for ${formatShareQuantity(shares, proposal.symbol)} shares`;
  }
  if (typeof cost === "number" && cost > 0) return `~${money(cost)}`;
  if (typeof shares === "number" && shares > 0) return `~${formatShareQuantity(shares, proposal.symbol)} shares`;
  return "—";
}

function relativeAge(iso?: string): string {
  if (!iso) return "";
  const ageMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ageMs)) return "";
  const mins = Math.max(0, Math.floor(ageMs / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min old`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr old`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} old`;
}

function proposalAgeTone(iso?: string): { label: string; tone: "neutral" | "warn" | "down" } | null {
  if (!iso) return null;
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (!Number.isFinite(hours)) return null;
  if (hours >= 24) return { label: "Stale", tone: "down" };
  if (hours >= 1) return { label: "Aging", tone: "warn" };
  return { label: "Fresh", tone: "neutral" };
}

function proposalTimeLabel(iso?: string): string {
  const parts = proposalTimeParts(iso);
  return parts ? `${parts.full} · ${parts.relative}` : "";
}

function proposalTimeParts(iso?: string): { display: string; full: string; relative: string } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const now = new Date();
  const ageMs = now.getTime() - date.getTime();
  const relative = relativeAge(iso);
  if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 86_400_000) {
    return {
      display: relative,
      full: date.toLocaleString(),
      relative
    };
  }
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const dateLabel = today
    ? "Today"
    : date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {})
      });
  const timeLabel = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return {
    display: `${dateLabel}, ${timeLabel}`,
    full: date.toLocaleString(),
    relative
  };
}

function compare(left: unknown, right: unknown, dir: SortDir): number {
  const order = dir === "asc" ? 1 : -1;
  if (typeof left === "string" || typeof right === "string") return String(left ?? "").localeCompare(String(right ?? "")) * order;
  return (Number(left ?? 0) - Number(right ?? 0)) * order;
}

function labelize(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatSectorCaps(caps: Record<string, number>): string {
  return Object.entries(caps).map(([sector, cap]) => `${sector}:${cap}`).join(", ");
}

function parseSectorCaps(value: string): Record<string, number> {
  return Object.fromEntries(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [sector, cap] = item.split(":");
        return [sector?.trim() ?? "", Number(cap)] as const;
      })
      .filter(([sector, cap]) => sector.length > 0 && Number.isFinite(cap))
  );
}

function normalizeSymbols(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim().toUpperCase()).filter((v) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(v))));
}

function renderActionTitle(title: string) {
  const match = title.match(/^((?:Mock\/Local|Paper)\s+)?(buy|sell|bought|sold|buy:|sell:)\b(.*)$/i);
  if (!match) return <span className="font-semibold text-fg">{title}</span>;
  const [, paperPrefix = "", action, rest] = match;
  const cls = /sell|sold/i.test(action) ? "text-down" : "text-up";
  return (
    <span className="font-semibold text-fg">
      {paperPrefix}
      <span className={cls}>{action.toUpperCase()}</span>
      {rest}
    </span>
  );
}



type ApiKeyStatus = {
  service: string;
  label: string;
  category: string;
  required: boolean;
  unlocks: string;
  docsUrl?: string;
  envVar?: string;
  configured: boolean;
  source: "user" | "env" | "none";
  updatedAt?: string;
};

type LlmApiService = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek";

const LLM_SERVICE_LABELS: Record<LlmApiService, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  xai: "xAI (Grok)",
  gemini: "Google (Gemini)",
  mistral: "Mistral",
  deepseek: "DeepSeek"
};

function strategyLlmServiceForModel(model?: string | null): LlmApiService {
  const value = (model || DEFAULT_LLM_MODEL).trim();
  if (/^claude/i.test(value)) return "anthropic";
  if (/^grok/i.test(value)) return "xai";
  if (/^gemini/i.test(value)) return "gemini";
  if (/^(mistral|ministral|magistral|codestral|devstral|pixtral|open-mistral|open-mixtral)/i.test(value)) return "mistral";
  if (/^deepseek/i.test(value)) return "deepseek";
  return "openai";
}

function ApiKeysSection({ policy }: { policy: TradingPolicy }) {
  const [keys, setKeys] = useState<ApiKeyStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyService, setBusyService] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (!res.ok) throw await responseError(res, "Failed to load API key status");
      const body = (await res.json()) as { keys?: ApiKeyStatus[] };
      setKeys(body.keys ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load API key status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function saveKey(row: ApiKeyStatus) {
    const value = drafts[row.service]?.trim();
    if (!value) return;
    setBusyService(row.service);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: row.service, apiKey: value, label: row.label })
      });
      if (!res.ok) throw await responseError(res, `Failed to save ${row.label} key`);
      setDrafts((current) => ({ ...current, [row.service]: "" }));
      toast.success(`${row.label} key saved.`);
      await loadKeys();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save API key.");
    } finally {
      setBusyService(null);
    }
  }

  async function clearKey(row: ApiKeyStatus) {
    setBusyService(row.service);
    try {
      const res = await fetch(`/api/keys?service=${encodeURIComponent(row.service)}`, { method: "DELETE" });
      if (!res.ok) throw await responseError(res, `Failed to clear ${row.label} key`);
      toast.success(`${row.label} saved key cleared.`);
      await loadKeys();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear API key.");
    } finally {
      setBusyService(null);
    }
  }

  const requiredUnsetLabels = keys.filter((row) => row.required && row.source === "none").map((row) => row.label);
  const strategyModel = policy.llmModel || DEFAULT_LLM_MODEL;
  const strategyService = strategyLlmServiceForModel(strategyModel);
  const strategyServiceLabel = LLM_SERVICE_LABELS[strategyService];
  const selectedStrategyRow = keys.find((row) => row.service === strategyService);
  const selectedStrategyModelMissing = selectedStrategyRow?.source === "none";

  if (loading) {
    return <EmptyState title="Loading API Key Status" icon={<RefreshCw size={20} className="animate-spin" />} />;
  }

  return (
    <div className="space-y-3">
      {requiredUnsetLabels.length > 0 && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
          Required connection missing: {requiredUnsetLabels.join(", ")}.
        </p>
      )}
      {selectedStrategyModelMissing && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
          Selected Green Team model <strong>{strategyModel}</strong> needs a {strategyServiceLabel} key before Run once can use it. Save a {strategyServiceLabel} key below or choose a different Green Team model in Strategy Studio.
        </p>
      )}
      <div className="grid gap-2">
        {keys.map((row) => {
          const busy = busyService === row.service;
          const sourceLabel = row.source === "user" ? "Your key" : row.source === "env" ? "Operator env" : "Not set";
          const sourceTone = row.source === "user" ? "up" : row.source === "env" ? "info" : row.required ? "warn" : "neutral";
          const inputType = row.service === "sec_edgar_user_agent" ? "text" : "password";
          return (
            <div key={row.service} className="rounded-lg border border-line bg-surface-2/45 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound size={14} className="text-muted" />
                    <span className="font-semibold text-fg">{row.label}</span>
                    <Chip tone={sourceTone}>{sourceLabel}</Chip>
                    {row.required && <Chip tone="warn">Required</Chip>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                    <span>{row.category}</span>
                    {row.envVar && <span className="font-mono">{row.envVar}</span>}
                    {row.updatedAt && <span>Saved {new Date(row.updatedAt).toLocaleDateString()}</span>}
                  </div>
                </div>
                {row.docsUrl && (
                  <a className="inline-flex items-center text-info hover:text-fg" href={row.docsUrl} target="_blank" rel="noreferrer" aria-label="Open provider site" title="Open provider site">
                    <ExternalLink size={16} />
                  </a>
                )}
              </div>
              <p className="mt-2 text-[13px] text-muted">{row.unlocks}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type={inputType}
                  value={drafts[row.service] ?? ""}
                  onChange={(e) => setDrafts((current) => ({ ...current, [row.service]: e.target.value }))}
                  placeholder={row.source === "none" ? "Paste key or value" : "Saved value is hidden"}
                  className={cn(inputClass, "min-w-0 flex-1")}
                  autoComplete="off"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => saveKey(row)} disabled={busy || !drafts[row.service]?.trim()}>
                    <Save size={14} /> Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => clearKey(row)} disabled={busy || row.source !== "user"}>
                    <Trash2 size={14} /> Clear
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-faint">
        Yahoo Finance, configured congressional-trade feeds, SEC EDGAR, and FINRA short-volume do not need API keys. Brokerage account credentials live in Accounts, not here.
      </p>
    </div>
  );
}

function IntegrationsSection({
  accounts,
  policy,
  onSaved,
  hideTestAccount,
  setHideTestAccount
}: {
  accounts: DashboardSnapshot["connectedAccounts"];
  policy: TradingPolicy;
  onSaved: () => Promise<void>;
  hideTestAccount: boolean;
  setHideTestAccount: (next: boolean) => void;
}) {
  type AccountDraft = Partial<NonNullable<DashboardSnapshot["connectedAccounts"]>[0]>;
  const [editing, setEditing] = useState<AccountDraft | null>(null);
  const [showCustomEndpoint, setShowCustomEndpoint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mcpHealth, setMcpHealth] = useState<RobinhoodMcpHealth | null>(null);

  const robinhoodAuthIssue = (acc: NonNullable<DashboardSnapshot["connectedAccounts"]>[0]) =>
    acc.broker === "robinhood" && Boolean(mcpHealth && (!mcpHealth.configured || !mcpHealth.authenticated || !mcpHealth.ok));

  const formatAccountInfo = (acc: NonNullable<DashboardSnapshot["connectedAccounts"]>[0]) => {
    if (acc.broker === "test") {
      return {
        title: "Test",
        subtitle: "Local · Temporary",
        showBadges: false
      };
    }
    if (acc.broker === "robinhood") {
      return {
        title: acc.label || "Agentic Robinhood",
        subtitle: `Robinhood · ${acc.accountNumber || "No account number"}${robinhoodAuthIssue(acc) ? " · OAuth not connected" : ""}`,
        showBadges: true
      };
    }
    // Alpaca & Alpaca MCP
    const isMCP = acc.broker === "alpaca-mcp";
    const brokerName = isMCP ? "Alpaca MCP" : "Alpaca";
    const isPaper = acc.environment === "paper";
    return {
      title: acc.label || (isPaper ? "Paper" : "Brokerage"),
      subtitle: `${brokerName} ${isPaper ? "Paper" : "Brokerage"} · ${acc.accountNumber || "No account number"}`,
      showBadges: true
    };
  };

  function openAccountEditor(account: AccountDraft) {
    setShowCustomEndpoint(hasCustomAlpacaEndpoint(account));
    setEditing(account);
  }

  const refreshMcpHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/broker/mcp/health", { cache: "no-store" });
      const health = (await res.json()) as RobinhoodMcpHealth;
      setMcpHealth(health);
      if (!res.ok) throw new Error(health.error ?? "Robinhood MCP health check failed.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Robinhood MCP health check failed.";
      setMcpHealth({
        ok: false,
        configured: false,
        authenticated: false,
        tools: [],
        checkedAt: new Date().toISOString(),
        error: message
      });
    }
  }, []);

  useEffect(() => {
    void refreshMcpHealth();
  }, [refreshMcpHealth]);

  // After Robinhood OAuth returns (/?robinhoodMcp=connected), pull the real agentic
  // (read+write) account into connected accounts — no manual entry, no mock.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("robinhoodMcp") !== "connected") return;
    params.delete("robinhoodMcp");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    void syncRobinhood();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function syncRobinhood() {
    setBusy(true);
    try {
      const res = await fetch("/api/connected-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ broker: "robinhood" })
      });
      if (!res.ok) throw await responseError(res, "Failed to sync Robinhood account");
      toast.success("Robinhood agentic account synced.");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to sync Robinhood account.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing?.broker) return;
    const draft = { ...editing };
    const isAlpaca = draft.broker === "alpaca" || draft.broker === "alpaca-mcp";
    if (isAlpaca) {
      if (!draft.accountNumber?.trim()) {
        toast.error("Account Number is required for Alpaca.");
        return;
      }
      // When editing an existing account and leaving the API key blank ("leave blank to keep"), the
      // secret is preserved server-side — so DON'T re-infer the environment from the now-blank key
      // (that could flip a PK-inferred paper account to live on a label-only edit). Keep the stored
      // environment; only re-infer when a key is actually (re)entered or for a brand-new account.
      const keepingHiddenSecret = Boolean(draft.id) && !draft.apiKey?.trim();
      draft.environment = keepingHiddenSecret
        ? draft.environment || inferAlpacaEnvironment(draft)
        : inferAlpacaEnvironment(draft);
    } else {
      draft.environment = draft.environment || "live";
    }
    if (draft.broker === "alpaca") {
      draft.baseUrl = showCustomEndpoint && draft.baseUrl?.trim()
        ? draft.baseUrl.trim()
        : alpacaDefaultEndpointFor(draft.environment);
    }
    setBusy(true);
    try {
      const res = await fetch("/api/connected-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft)
      });
      if (!res.ok) throw await responseError(res, "Failed to save account");
      toast.success("Account saved.");
      setEditing(null);
      setShowCustomEndpoint(false);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save account.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm("Remove this connected account?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/connected-accounts/${id}`, { method: "DELETE" });
      if (!res.ok) throw await responseError(res, "Failed to remove account");
      toast.success("Account removed.");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove account.");
    } finally {
      setBusy(false);
    }
  }

  async function activateAccount(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/connected-accounts/${id}/activate`, { method: "POST" });
      if (!res.ok) throw await responseError(res, "Failed to activate account");
      toast.success("Account selected.");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to activate account.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const isAlpaca = editing.broker === "alpaca" || editing.broker === "alpaca-mcp";
    const isAlpacaRest = editing.broker === "alpaca";
    const isAlpacaMcp = editing.broker === "alpaca-mcp";
    const inferredEnvironment = inferAlpacaEnvironment(editing);
    const defaultAlpacaEndpoint = alpacaDefaultEndpointFor(inferredEnvironment);
    return (
      <div className="space-y-4 rounded-lg border border-line bg-surface-2/30 p-4">
        <h4 className="text-sm font-semibold text-fg">
          {editing.broker === "robinhood"
            ? (editing.id ? "Edit Robinhood Account" : "Add Robinhood Account")
            : editing.broker === "alpaca-mcp"
              ? (editing.id ? "Edit Alpaca MCP Account" : "Add Alpaca MCP Account")
              : (editing.id ? "Edit Alpaca Account" : "Add Alpaca Account")}
        </h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isAlpacaMcp && (
            <div className="rounded-md border border-line bg-bg/35 px-3 py-2 text-[13px] text-muted sm:col-span-2">
              Alpaca MCP uses your MCP server URL, such as a local SSE endpoint. For direct Alpaca keys, use the regular Alpaca account option.
            </div>
          )}
          {editing.broker === "robinhood" && (
            <div className="rounded-md border border-line bg-bg/35 px-3 py-2 text-[13px] text-muted sm:col-span-2">
              Robinhood uses OAuth through MCP and syncs the agentic Brokerage account. No API key fields are required here.
            </div>
          )}
          <Field label="Label">
            <input
              className={cn(inputClass, "placeholder:italic")}
              value={editing.label || ""}
              onChange={e => setEditing({ ...editing, label: e.target.value })}
              placeholder={
                editing.broker === "robinhood"
                  ? "Robinhood Agentic"
                  : editing.broker === "alpaca-mcp"
                    ? "Alpaca MCP Paper"
                    : "Paper, Roth IRA, etc"
              }
            />
          </Field>
          <Field label="Account Number">
            <input
              className={inputClass}
              value={editing.accountNumber || ""}
              onChange={e => {
                const val = e.target.value;
                const environment = inferAlpacaEnvironment({ ...editing, accountNumber: val });
                setEditing({
                  ...editing,
                  accountNumber: val,
                  environment,
                  baseUrl: isAlpacaRest && !showCustomEndpoint ? alpacaDefaultEndpointFor(environment) : editing.baseUrl
                });
              }}
              placeholder="e.g. PA12345"
            />
          </Field>
          {isAlpaca && (
            <>
              <Field label={editing.id ? "Alpaca API Key (hidden)" : "Alpaca API Key"}>
                <input
                  className={cn(inputClass, "placeholder:italic")}
                  value={editing.apiKey || ""}
                  onChange={e => {
                    const apiKey = e.target.value;
                    const environment = inferAlpacaEnvironment({ ...editing, apiKey });
                    setEditing({
                      ...editing,
                      apiKey,
                      environment,
                      baseUrl: isAlpacaRest && !showCustomEndpoint ? alpacaDefaultEndpointFor(environment) : editing.baseUrl
                    });
                  }}
                  placeholder={editing.id ? "•••••••• — leave blank to keep" : "Required (API Key / OAuth Token)"}
                />
              </Field>
              <Field label={editing.id ? "Alpaca API Secret (hidden)" : "Alpaca API Secret"}>
                <input type="password" className={cn(inputClass, "placeholder:italic")} value={editing.apiSecret || ""} onChange={e => setEditing({ ...editing, apiSecret: e.target.value })} placeholder={editing.id ? "•••••••• — leave blank to keep" : "Required for key-pair; omit for OAuth"} />
              </Field>
              {isAlpacaRest ? (
                <>
                  <label className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 sm:col-span-2">
                    <input
                      type="checkbox"
                      className="mt-1 accent-accent"
                      checked={showCustomEndpoint}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setShowCustomEndpoint(checked);
                        // Start the custom field EMPTY on check, never copy in the current
                        // (possibly stale/default) baseUrl — that silently locked in the wrong
                        // endpoint for anyone who checked this before finishing the account
                        // number/API key fields, since a checked box also stops those fields'
                        // auto-derivation of baseUrl from the inferred paper/live environment.
                        // An empty custom value still saves safely: the save handler falls back
                        // to alpacaDefaultEndpointFor(environment) when baseUrl is blank.
                        setEditing({
                          ...editing,
                          baseUrl: checked ? "" : defaultAlpacaEndpoint
                        });
                      }}
                    />
                    <span>
                      <span className="block text-sm font-medium text-fg">Use a Custom Alpaca Endpoint</span>
                      <span className="block text-xs text-faint">
                        Leave off unless your endpoint is different from the Paper/Brokerage defaults. Current default: <span className="font-mono">{defaultAlpacaEndpoint}</span>.
                      </span>
                    </span>
                  </label>
                  {showCustomEndpoint && (
                    <Field label="Custom API Endpoint URL">
                      <input
                        className={inputClass}
                        value={editing.baseUrl || ""}
                        onChange={e => setEditing({ ...editing, baseUrl: e.target.value })}
                        placeholder={`Default: ${defaultAlpacaEndpoint}`}
                      />
                    </Field>
                  )}
                </>
              ) : (
                <Field label="MCP Endpoint URL">
                  <input
                    className={inputClass}
                    value={editing.baseUrl || ""}
                    onChange={e => setEditing({ ...editing, baseUrl: e.target.value })}
                    placeholder="e.g. http://localhost:8000/sse"
                  />
                </Field>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => { setEditing(null); setShowCustomEndpoint(false); }}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !editing.broker}>Save Account</Button>
        </div>
      </div>
    );
  }

  // The app's active account: prefer the explicitly-selected one, else the flagged-active row (mirrors
  // activeConnectedAccountFor). Used to mark which row is ACTIVE vs merely Connected.
  const activeId = policy.connectedAccountId ?? accounts?.find((a) => a.isActive)?.id;
  const visibleAccounts = visibleConnectedAccounts(accounts, hideTestAccount, activeId);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Connect one or more supported accounts when you want broker-backed execution. Paper accounts are optional and user-selected.
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
            if (mcpHealth?.authenticated) { void syncRobinhood(); }
            else { window.location.href = "/api/auth/robinhood/start"; }
          }}>
            <Plus size={14} className="mr-1" /> Connect Robinhood
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openAccountEditor({ broker: "alpaca", environment: "paper", baseUrl: ALPACA_PAPER_ENDPOINT })}>
            <Plus size={14} className="mr-1" /> Connect Alpaca
          </Button>
        </div>
      </div>

      {!visibleAccounts.length ? (
        <div className="rounded-lg border border-line border-dashed p-6 text-center text-sm text-faint">
          No connected accounts yet. Use the buttons above to connect any supported account when you want broker-backed execution; Paper accounts are optional.
        </div>
      ) : (
        <div className="space-y-2">
          {visibleAccounts.map(acc => {
            const info = formatAccountInfo(acc);
            const isActive = acc.id === activeId;
            const needsRobinhoodReconnect = robinhoodAuthIssue(acc);
            return (
              <div
                key={acc.id}
                className={cn(
                  "flex flex-col gap-3 rounded-lg border bg-surface/50 p-3 sm:flex-row sm:items-center sm:justify-between",
                  isActive ? "border-accent/45 bg-accent/5 shadow-[inset_3px_0_0_rgba(20,184,166,0.55)]" : "border-line"
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-fg">{info.title}</span>
                    {info.showBadges && needsRobinhoodReconnect && (
                      <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-400">
                        OAuth Needed
                      </span>
                    )}
                    {info.showBadges && !needsRobinhoodReconnect && (isActive ? (
                      <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-surface-3/60 border border-line px-2 py-0.5 text-[10px] font-semibold text-muted">
                        Connected
                      </span>
                    ))}
                    {info.showBadges && needsRobinhoodReconnect && isActive && (
                      <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                        Active
                      </span>
                    )}
                    {info.showBadges && isActive && policy?.strategyAuthority === "decide" && (
                      <span className="rounded-full bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-400">
                        Autonomous
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-faint">
                    {info.subtitle}
                    {needsRobinhoodReconnect && (
                      <span className="block pt-1 text-amber-300">
                        Robinhood needs to be reconnected.
                      </span>
                    )}
                    {acc.capabilities && (
                      <span className="ml-2">
                        {acc.capabilities.accountType !== "brokerage" && (
                          <span className="mr-1 rounded bg-blue-500/10 px-1 py-0.5 text-[10px] font-medium text-blue-400">
                            {acc.capabilities.accountType === "roth_ira" ? "Roth IRA" : "Trad IRA"}
                          </span>
                        )}
                        {acc.capabilities.marginEnabled && (
                          <span className="mr-1 rounded bg-yellow-500/10 px-1 py-0.5 text-[10px] font-medium text-yellow-400">Margin</span>
                        )}
                        {acc.capabilities.shortSelling && (
                          <span className="mr-1 rounded bg-orange-500/10 px-1 py-0.5 text-[10px] font-medium text-orange-400">Short</span>
                        )}
                        {acc.capabilities.optionsTrading && (
                          <span className="mr-1 rounded bg-purple-500/10 px-1 py-0.5 text-[10px] font-medium text-purple-400">
                            Options{acc.capabilities.optionsLevel !== undefined ? ` L${acc.capabilities.optionsLevel}` : ""}
                          </span>
                        )}
                        {acc.capabilities.cryptoTrading && (
                          <span className="mr-1 rounded bg-cyan-500/10 px-1 py-0.5 text-[10px] font-medium text-cyan-400">Crypto</span>
                        )}
                        {acc.capabilities.futuresTrading && (
                          <span className="mr-1 rounded bg-pink-500/10 px-1 py-0.5 text-[10px] font-medium text-pink-400">Futures</span>
                        )}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                  {needsRobinhoodReconnect ? (
                    <Button variant="primary" size="sm" onClick={() => { window.location.href = "/api/auth/robinhood/start"; }} disabled={busy}>Reconnect</Button>
                  ) : (
                    !isActive && <Button variant="primary" size="sm" onClick={() => activateAccount(acc.id)} disabled={busy}>Use</Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => openAccountEditor(acc)} disabled={busy}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => deleteAccount(acc.id)} disabled={busy} className="text-danger hover:bg-danger/10 hover:text-danger">Remove</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {accounts?.some((a) => a.broker === "test") && (
        <label className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-faint">
          <span>Hide the Test account from Accounts and the account selector</span>
          <Switch checked={hideTestAccount} onChange={setHideTestAccount} label="Hide Test account" />
        </label>
      )}
    </div>
  );
}

function HelpSourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="font-semibold text-info underline-offset-2 hover:text-fg hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

function joinHelpSourceLinks(items: React.ReactNode[]): React.ReactNode {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return items.map((item, index) => (
    <React.Fragment key={index}>
      {index > 0 && (index === items.length - 1 ? " and " : ", ")}
      {item}
    </React.Fragment>
  ));
}

function CongressionalTradesHelpLine({ sources }: { sources: string[] }) {
  const sourceSet = new Set(sources);
  const hasCongressTrade = sourceSet.has("congress.trade");
  const hasSenate = sourceSet.has("senate-efd");
  const hasCapitolTrades = sourceSet.has("capitol-trades");
  const hasApify = sourceSet.has("apify-congress");
  const sourceLinks: React.ReactNode[] = [];

  if (hasCongressTrade) sourceLinks.push(<HelpSourceLink href="https://congress.trade/">Congress.Trade</HelpSourceLink>);
  if (hasSenate) sourceLinks.push(<HelpSourceLink href="https://efdsearch.senate.gov/search/">U.S. Senate eFD</HelpSourceLink>);
  if (hasCapitolTrades) sourceLinks.push(<HelpSourceLink href="https://www.capitoltrades.com/">Capitol Trades</HelpSourceLink>);
  if (hasApify) sourceLinks.push(<HelpSourceLink href="https://apify.com/">Apify congressional feeds</HelpSourceLink>);

  if (hasCongressTrade && sourceLinks.length === 1) {
    return <>Politicians&apos; trades: aggregated House/Senate reporting via {sourceLinks[0]}.</>;
  }
  if (sourceLinks.length > 0) {
    return <>Politicians&apos; trades: configured public disclosure feeds via {joinHelpSourceLinks(sourceLinks)}.</>;
  }
  return <>Politicians&apos; trades: configured congressional-trade feeds; source attribution appears after the next refresh.</>;
}

function HelpContent({ policy, snapshot }: { policy: TradingPolicy; snapshot: DashboardSnapshot }) {
  type Section = "overview" | "guardrails" | "settings" | "tax" | "data" | "mcp";
  const [section, setSection] = useState<Section>("overview");
  // NAV_V2 PR #4: show the old→new Settings Glossary table for returning users.
  const [navV2] = useState(() => isNavV2Enabled(typeof window !== "undefined" ? window.localStorage : null));

  const taxSettings = snapshot.tax?.settings ?? policy.taxSettings ?? { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15 };
  const congressionalSources = snapshot.webSources?.congress?.sources ?? [];

  return (
    <div className="space-y-4">
      <Tabs
        value={section}
        onChange={(v) => setSection(v as Section)}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "guardrails", label: "Guardrails" },
          { id: "settings", label: "Settings Glossary" },
          { id: "tax", label: "Tax" },
          { id: "data", label: "Data Sources" },
          { id: "mcp", label: "MCP Connection" }
        ]}
      />

      {section === "overview" && (
        <div className="space-y-3 text-[13px] text-muted">
          <div className="rounded-lg border border-line bg-surface-2/30 p-3 space-y-2">
            <div className="font-semibold text-fg flex items-center gap-1.5">
              <Sparkles size={14} className="text-accent" /> How the System Works
            </div>
            <ol className="list-decimal pl-4 space-y-1">
              <li><strong>Market Scan:</strong> The system continuously scans index universes (e.g. S&amp;P 500) to find candidate symbols.</li>
              <li><strong>Enrichment:</strong> Fetches company profiles, market data, news/sentiment, and analyst/fundamental context.</li>
              <li><strong>AI Analysis:</strong> Executes prompts through the configured model to score symbols and formulate trade suggestions.</li>
              <li><strong>Execution:</strong> Approves or proposes orders based on your selected risk policies and guardrails.</li>
            </ol>
          </div>
        </div>
      )}

      {section === "guardrails" && (
        <div className="space-y-3 text-[13px] text-muted">
          <p>
            Guardrails prevent runaway trading and keep allocations within your risk tolerance. Customize these in <strong>Settings</strong>.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="font-semibold text-fg flex items-center gap-1.5 mb-1">
                <Gauge size={14} className="text-info" /> Daily Notional Ceiling
              </div>
              <p>
                Maximum combined dollar amount of order executions permitted per day. Currently set to: <strong className="text-fg">{policy.maxDailyNotional != null ? `$${policy.maxDailyNotional}` : "Unlimited"}</strong>.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="font-semibold text-fg flex items-center gap-1.5 mb-1">
                <Hourglass size={14} className="text-info" /> Hourly Ceiling
              </div>
              <p>
                Maximum notional executed in a rolling 60-minute window. Set to <strong className="text-fg">{policy.maxHourlyNotional != null ? `$${policy.maxHourlyNotional}` : "Unlimited"}</strong>. Breaches automatically drop authority to Propose mode.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3 sm:col-span-2">
              <div className="font-semibold text-fg flex items-center gap-1.5 mb-1">
                <Shield size={14} className="text-info" /> Trading Authority Mode
              </div>
              <p>
                Currently in <strong className="text-fg">{policy.strategyAuthority === "decide" ? "Autonomous" : "Semi-Autonomous (Propose)"}</strong> mode.
              </p>
              <ul className="list-disc pl-4 mt-1 space-y-0.5">
                <li><strong>Propose Mode:</strong> Order proposals are staged and require your explicit click to send to the brokerage.</li>
                <li><strong>Autonomous Mode:</strong> The agent places orders autonomously when matching signals are identified.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {section === "settings" && (
        <div className="space-y-3 text-[13px] text-muted">
          <p>
            Settings are split by scope. <strong>User Settings</strong> (tagged <strong>ALL ACCOUNTS</strong>) cover provider keys, appearance, alert delivery, and shared data preferences. <strong>Account Settings</strong> (tagged <strong>THIS ACCOUNT</strong>) cover the selected account&apos;s strategy, universe, safety, tax treatment, and tuning behavior.
          </p>
          {navV2 && (
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-2 font-semibold text-fg">Renamed &amp; relocated — old name → new home</div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-faint">
                    <tr>
                      <th className="py-1 pr-3 font-medium">You used to call it…</th>
                      <th className="py-1 pr-3 font-medium">It&apos;s now…</th>
                      <th className="py-1 font-medium">What changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SETTINGS_GLOSSARY.map((entry) => (
                      <tr key={entry.oldName} className="border-t border-line/60 align-top">
                        <td className="py-1.5 pr-3 text-muted">{entry.oldName}</td>
                        <td className="py-1.5 pr-3 font-medium text-fg">{entry.newHome}</td>
                        <td className="py-1.5 text-muted">{entry.whatChanged}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 border-t border-line/60 pt-2 text-[11px] text-faint">{GLOSSARY_RULE_OF_THUMB}</p>
            </div>
          )}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-1 font-semibold text-fg">Strategy Studio</div>
              <p>Prompt, Green/Red Team model choices, reasoning effort, scoring weights, and LLM strategy reviews belong to the active account strategy. Provider API keys stay user-level because credentials belong to you.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-1 font-semibold text-fg">Min lots for weight shift</div>
              <p>Closed lots are completed trade outcomes. The auto-tuner withholds factor-weight changes until the selected account has enough closed lots, default 20, so a few lucky or unlucky trades do not reshape scoring weights. Below the gate, prompt and risk-sizing suggestions can still be proposed.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-1 font-semibold text-fg">Candidate cap and outlier reserve</div>
              <p>Candidate cap is the top-ranked scan count sent to the LLM. Outlier reserve adds extra below-cutoff names with unusual congressional, insider, short-pressure, technical, or price/volume signals. Current holdings are always scanned.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-1 font-semibold text-fg">Stops and broker protection</div>
              <p>Broker-held brackets are native OCO stop/take-profit orders where supported, currently Alpaca. Synthetic stops, beta/ATR stops, and take-profit trims are app-managed unless the UI says the broker is holding the order.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-1 font-semibold text-fg">Universe floor</div>
              <p>Minimum price, market-cap, and dollar-volume filters apply only to scanned candidates. Explicit watchlist symbols and current holdings are exempt so deliberate research targets and exits are not blocked by the scanner floor.</p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="mb-1 font-semibold text-fg">Negative-EV gate</div>
              <p>When enabled, the engine skips opening a thesis whose realized record is proven enough and whose shrunk post-cost edge is at or below the configured threshold. With the gate off, weak proven theses are usually downsized to the exploratory floor instead of skipped.</p>
            </div>
          </div>
        </div>
      )}

      {section === "tax" && (
        <div className="space-y-3 text-[13px] text-muted">
          <p>
            Tax rules govern how estimated liability is calculated and protect against costly regulatory tax traps like wash sales.
          </p>
          <div className="grid gap-2.5">
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="font-semibold text-fg flex items-center gap-1.5 mb-1">
                <Percent size={14} className="text-warn" /> Wash-Sale Guardrail
              </div>
              <p>
                <strong>Status: {taxSettings.washSaleGuard ? "Enabled" : "Disabled"}</strong>
              </p>
              <p className="mt-1">
                Under IRC §1091, selling a security at a loss and rebuying it within 30 days disallows claiming the capital loss for tax purposes. The system's wash-sale guard prevents rebuying any security sold at a loss within a rolling 30-day window.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3">
              <div className="font-semibold text-fg flex items-center gap-1.5 mb-1">
                <Landmark size={14} className="text-warn" /> Account Sheltering
              </div>
              <p>
                Tax treatments differ by account type:
              </p>
              <ul className="list-disc pl-4 mt-1 space-y-0.5">
                <li><strong>Taxable:</strong> Estimated tax liability is deducted from display returns (if configured) and subject to the 30-day lockout.</li>
                <li><strong>IRA (Roth / Traditional):</strong> Tax-sheltered with 0% tax liability estimates and no in-account wash-sale blocks (losses in taxable accounts still apply).</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {section === "data" && (
        <div className="space-y-3 text-[13px] text-muted">
          <p>
            The app blends several data sources so every symbol gets real numbers. Keyless sources work out of the box; optional keyed providers add depth when you supply an API key. Where a value is unavailable, the cell shows <code className="text-fg font-mono">-</code> rather than a fabricated number.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface-2/30 p-3 space-y-2">
              <div className="font-semibold text-fg flex items-center gap-1.5">
                <Server size={14} className="text-accent" /> Keyless / Core
              </div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li><HelpSourceLink href="https://finance.yahoo.com/">Yahoo Finance</HelpSourceLink>: quotes and price history with no API key - the floor every symbol falls back to.</li>
                <li><CongressionalTradesHelpLine sources={congressionalSources} /></li>
                <li><HelpSourceLink href="https://www.sec.gov/os/accessing-edgar-data">SEC EDGAR</HelpSourceLink>: insider activity from Form 4 filings.</li>
                <li><HelpSourceLink href="https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data">FINRA</HelpSourceLink>: daily short-volume data.</li>
                <li>Connected broker: <HelpSourceLink href="https://alpaca.markets/">Alpaca</HelpSourceLink> or <HelpSourceLink href="https://robinhood.com/">Robinhood</HelpSourceLink> for account quotes, positions, and execution.</li>
              </ul>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3 space-y-2">
              <div className="font-semibold text-fg flex items-center gap-1.5">
                <Zap size={14} className="text-accent" /> Optional Keyed Providers
              </div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li><HelpSourceLink href="https://finnhub.io/dashboard">Finnhub</HelpSourceLink>: quotes, fundamentals, and sentiment/news enrichment.</li>
                <li><HelpSourceLink href="https://www.alphavantage.co/support/#api-key">Alpha Vantage</HelpSourceLink>: fundamentals, technical indicators, and sentiment/news enrichment.</li>
                <li><HelpSourceLink href="https://site.financialmodelingprep.com/developer/docs">FMP</HelpSourceLink>: fundamentals, ratios, and analyst context.</li>
                <li><HelpSourceLink href="https://marketstack.com/signup/free">Marketstack</HelpSourceLink>: market-data API coverage.</li>
                <li><HelpSourceLink href="https://developer.tradier.com/">Tradier</HelpSourceLink>: brokerage and market-data API coverage.</li>
                <li><HelpSourceLink href="https://fred.stlouisfed.org/docs/api/api_key.html">FRED</HelpSourceLink>: macroeconomic indicators.</li>
                <li><HelpSourceLink href="https://massive.com/">Massive</HelpSourceLink>: historical market-data files and provider feeds.</li>
              </ul>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3 space-y-2 sm:col-span-2">
              <p>
                None of the keyed providers are required. Add keys only when you want broader coverage, deeper fundamentals, or another provider to fill gaps left by the keyless/core sources.
              </p>
            </div>
          </div>
        </div>
      )}

      {section === "mcp" && (
        <div className="space-y-3 text-[13px] text-muted">
          <p>
            The <strong>Model Context Protocol (MCP)</strong> is an open standard that lets an AI agent connect to external tools and data providers through a uniform interface, so the agent can call provider actions and pull live data on demand rather than working from a static snapshot.
          </p>
          <p>
            An AI agent — like this app — can connect to providers over MCP. This app uses MCP for things like the <strong>Robinhood</strong> brokerage connection and optional premium news, calling those tools as part of its research and execution loop.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface-2/30 p-3 space-y-2">
              <div className="font-semibold text-fg flex items-center gap-1.5">
                <Network size={14} className="text-accent" /> Benefits
              </div>
              <ul className="list-disc pl-4 space-y-1">
                <li><strong>Dynamic tool use:</strong> the agent discovers and invokes provider actions on demand instead of hard-coding each call.</li>
                <li><strong>Uniform interface:</strong> one protocol spans many providers, so adding a new source is consistent.</li>
                <li><strong>Stateful sessions:</strong> auth and context persist across calls, enabling multi-turn research loops.</li>
              </ul>
            </div>
            <div className="rounded-lg border border-line bg-surface-2/30 p-3 space-y-2">
              <div className="font-semibold text-fg flex items-center gap-1.5">
                <Server size={14} className="text-accent" /> Trade-offs vs REST API
              </div>
              <ul className="list-disc pl-4 space-y-1">
                <li><strong>More moving parts:</strong> MCP needs a running, stateful server plus session and OAuth management; it can add latency and an extra hop, and the tooling is still newer and less universally supported.</li>
                <li><strong>REST is simpler but more manual:</strong> a plain REST API is stateless and ubiquitous, but typically requires bespoke per-provider integration and manual key handling.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
