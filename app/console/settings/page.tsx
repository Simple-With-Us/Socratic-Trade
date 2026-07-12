"use client";

/** Settings — scope-split and visibly tagged: what belongs to THIS ACCOUNT
 *  (tax treatment, LLM models) vs ALL YOUR ACCOUNTS (broker connections, API
 *  keys, event notifications, delivery channels, scan shape, boot behavior),
 *  plus a REFERENCE glossary. The tag is the perception device — you never
 *  have to remember the storage tier. Sub-sections live in sibling modules
 *  (brokers/api-keys/models/delivery/help) with their fetch helpers in ./lib. */

import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import type { IraWashSaleHandling, NotificationEventType, TaxationType } from "@/lib/types";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/types";
import { savePolicy, setAutoResume, ConsoleApiError } from "../lib/api";
import { activeConnectedAccount, deriveReality } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { CONSOLE_TEXT_BOX_FONT_OPTIONS, useConsoleTextBoxFont } from "../lib/useConsoleTextBoxFont";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { useToast } from "../ui/toast";
import { Btn, Card, Chip, Field, RawNumInput, Select, TextInput, Toggle } from "../ui/primitives";
import { ApiKeysCard } from "./api-keys";
import { BrokerAccountsCard } from "./brokers";
import { AccountDeletionCard } from "./danger";
import { DeliveryChannelsCard } from "./delivery";
import { HelpGlossaryCard } from "./help";
import { ModelsCard } from "./models";
import { DataSharingCard } from "./sharing";

const EVENT_HINT: Partial<Record<NotificationEventType, string>> = {
  fill: "an order filled",
  block: "the policy gate blocked an order",
  run_failed: "a strategy run failed",
  pending_approval: "a trade is waiting for you",
  kill_switch: "a circuit breaker fired",
  price_alert: "a price alert triggered",
  proposal_withdrawn: "the strategist took an idea back",
  limit_order_stale: "a limit order has been working too long",
  provider_degraded: "a data provider is failing",
  budget_alert: "a usage budget threshold was crossed"
};

export default function SettingsPage() {
  const { snapshot } = useConsoleData();
  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  const ready = snapshot !== null && reality !== null;

  // Deep links (e.g. the Run-once blocked sheet routes to /console/settings#api-keys):
  // the page renders only after the snapshot arrives, so the native anchor jump
  // misses — scroll once the target section actually exists.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [ready]);

  if (!snapshot || !reality) return null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-[length:var(--con-fs-lg)] font-bold">Settings</h1>

      {/* ── THIS ACCOUNT ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip
            tone={reality.tone}
            title="Settings tagged THIS ACCOUNT are stored on the account itself — switch scope and you'll see that account's values instead."
          >
            THIS ACCOUNT — {reality.account?.label ?? "No connected account"} · {reality.word}
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            changes here follow the account, not you
          </span>
        </div>
        <TaxSettingsCard />
        {/* llmModel / redTeamLlmModel live on the account's policy — same
            save path (PUT /api/policy) as everything else account-scoped. */}
        <ModelsCard />
      </section>

      {/* ── ALL ACCOUNTS ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip
            tone="accent"
            title="Settings tagged ALL YOUR ACCOUNTS are stored per user — they overlay every account you connect, in every scope."
          >
            ALL YOUR ACCOUNTS
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            applies everywhere, for you
          </span>
        </div>
        {/* Anchor ids (#brokers/#api-keys) are deep-link targets used by the
            Run-once blocked-reason sheet; scroll-mt clears the sticky chrome. */}
        <div id="brokers" className="scroll-mt-28">
          <BrokerAccountsCard />
        </div>
        <div id="api-keys" className="scroll-mt-28">
          <ApiKeysCard />
        </div>
        {/* notificationSettings is a USER-level policy field (USER_LEVEL_POLICY_FIELDS
            in db-profiles): one event list + webhook overlaid on every account —
            so the card lives under ALL YOUR ACCOUNTS, not THIS ACCOUNT. */}
        <EventNotificationsCard />
        <DeliveryChannelsCard />
        <div id="sharing" className="scroll-mt-28">
          <DataSharingCard />
        </div>
        <ScanShapeCard />
        <BootBehaviorCard />
        <YouCard />
      </section>

      {/* ── THIS BROWSER ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="muted" title="Settings tagged THIS BROWSER are stored in this browser only. They change how the console looks here, not how the strategy trades.">
            THIS BROWSER
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            local display preferences
          </span>
        </div>
        <AppearanceCard />
      </section>

      {/* ── OPERATOR (admin only: links, no new admin UI) ── */}
      {snapshot.currentUser?.isAdmin && (
        <section id="admin" className="flex scroll-mt-28 flex-col gap-4">
          <div className="flex items-center gap-2">
            <Chip tone="accent" title="Visible because this login has operator/admin rights on the server.">
              OPERATOR
            </Chip>
            <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              server-wide diagnostics, outside the console
            </span>
          </div>
          <AdminLinksCard />
        </section>
      )}

      {/* ── REFERENCE ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="muted" title="Nothing here changes any setting — it's the app's vocabulary, searchable.">
            REFERENCE
          </Chip>
        </div>
        <HelpGlossaryCard />
      </section>

      {/* ── DANGER ── */}
      <section id="danger" className="flex scroll-mt-28 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="neg" title="Irreversible actions live here, behind typed confirmations — nothing in this section happens by accident.">
            DANGER
          </Chip>
        </div>
        <AccountDeletionCard />
      </section>
    </div>
  );
}

// ── This browser: local appearance preferences ──────────────────────────────

function AppearanceCard() {
  const { textBoxFont, setTextBoxFont } = useConsoleTextBoxFont();
  return (
    <Card title="Appearance">
      <Field label="Text Box Font" hint="Editable text boxes use this font in this browser.">
        <div className="grid gap-2 sm:grid-cols-2">
          {CONSOLE_TEXT_BOX_FONT_OPTIONS.map((option) => {
            const selected = textBoxFont === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                title={option.description}
                onClick={() => setTextBoxFont(option.value)}
                className={`min-h-[88px] rounded-lg border px-3 py-2 text-left transition-colors ${
                  selected
                    ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
                    : "border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] hover:border-[color:var(--con-accent-border)]"
                }`}
              >
                <span className="flex items-center justify-between gap-2 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]">
                  {option.label}
                  {selected && <Check size={14} className="text-[color:var(--con-accent)]" aria-hidden />}
                </span>
                <span
                  className="mt-1 block max-h-[44px] overflow-hidden text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]"
                  style={{ fontFamily: option.fontFamily }}
                >
                  Objective: compound returns by rotating capital toward the strongest risk-adjusted opportunities.
                </span>
              </button>
            );
          })}
        </div>
      </Field>
    </Card>
  );
}

// ── Operator/admin links (links only — the pages themselves live at /admin) ──

const ADMIN_LINKS: Array<{ href: string; label: string; desc: string }> = [
  { href: "/admin/connections", label: "API connections health", desc: "Live status of every upstream data/broker connection the server uses." },
  { href: "/admin/llm-usage", label: "LLM usage & cost", desc: "Token and dollar spend per model and per day, across all users." },
  { href: "/admin/rag-coverage", label: "RAG coverage", desc: "What the retrieval index covers and where it is thin." },
  { href: "/admin/transcript", label: "Chat transcript", desc: "Raw assistant transcript view for debugging conversations." }
];

function AdminLinksCard() {
  return (
    <Card title="Admin pages">
      <p className="mb-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Operator diagnostics from the legacy app — they open outside the console and keep their own styling.
      </p>
      <div className="flex flex-col gap-1">
        {ADMIN_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="con-row flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-[length:var(--con-fs-sm)]"
            title={`${link.desc} Opens outside the console.`}
          >
            <span>
              <span className="font-semibold">{link.label}</span>
              <span className="ml-2 hidden text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:inline">{link.desc}</span>
            </span>
            <ExternalLink size={13} className="shrink-0 text-[color:var(--con-faint)]" />
          </a>
        ))}
      </div>
    </Card>
  );
}

// ── All accounts: event notifications (user-level policy field) ─────────────

function EventNotificationsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draftEvents, setDraftEvents] = useState<NotificationEventType[] | null>(null);
  const [draftWebhook, setDraftWebhook] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty =
    draftEvents !== null ||
    (draftWebhook !== null && draftWebhook !== (snapshot?.policy.notificationSettings.webhookUrl ?? ""));
  useUnsavedChanges(dirty);
  if (!snapshot) return null;

  const current = snapshot.policy.notificationSettings;
  const events = draftEvents ?? current.enabledEvents;
  const webhook = draftWebhook ?? current.webhookUrl ?? "";

  const save = async () => {
    setBusy(true);
    try {
      // Minimal patch: only the fields the user actually touched. The server
      // deep-merges notificationSettings, so untouched fields stay as they are.
      await savePolicy({
        notificationSettings: {
          ...(draftEvents !== null ? { enabledEvents: events } : {}),
          ...(draftWebhook !== null && draftWebhook !== (current.webhookUrl ?? "") ? { webhookUrl: webhook } : {})
        }
      });
      await refresh();
      setDraftEvents(null);
      setDraftWebhook(null);
      toast.push("pos", "Event notifications saved");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Event notifications"
      action={
        dirty ? (
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" title="Throw away the unsaved event/webhook edits." onClick={() => { setDraftEvents(null); setDraftWebhook(null); }}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" disabled={busy} title="Save the event list and webhook for your whole login." onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Btn>
          </div>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Which events send notifications, and the webhook they go to. One list for your whole login — it applies across
        every account, not just the one you&apos;re viewing. Delivery channels (push/email/SMS) are configured once per
        user, below.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {NOTIFICATION_EVENT_TYPES.map((type) => {
          const on = events.includes(type);
          return (
            <label
              key={type}
              title={`When on, you get a notification whenever ${EVENT_HINT[type] ?? `a "${type}" event happens`}.`}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[length:var(--con-fs-sm)] transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]"
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => setDraftEvents(on ? events.filter((e) => e !== type) : [...events, type])}
              />
              <span className="font-semibold">{type}</span>
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{EVENT_HINT[type]}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-3 max-w-md">
        <Field label="Webhook URL (optional)" hint="Rich embeds for chat webhooks; generic JSON otherwise." htmlFor="webhook">
          <TextInput
            id="webhook"
            value={webhook}
            placeholder="https://…"
            title="Every enabled event is also POSTed to this URL. Chat webhooks (Discord/Slack) get rich embeds; anything else gets plain JSON."
            onChange={(e) => setDraftWebhook(e.target.value)}
          />
        </Field>
      </div>
    </Card>
  );
}

// ── This account: tax settings ───────────────────────────────────────────────

const TAXATION_LABEL: Record<TaxationType, string> = {
  taxable: "taxable brokerage",
  roth_ira: "Roth IRA",
  traditional_ira: "traditional IRA"
};

function TaxSettingsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<{
    taxationType: TaxationType;
    washSaleGuard: boolean;
    iraWashSaleHandling: IraWashSaleHandling;
    shortTermRatePct: number;
    longTermRatePct: number;
    subtractFromResults: boolean;
  }> | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(draft !== null);
  if (!snapshot) return null;

  const current = snapshot.policy.taxSettings;
  // The connected account's own taxationType (set when it was linked) WINS over
  // policy.taxSettings server-side (dashboard tax summary reads
  // activeAccount.taxationType ?? policy.taxSettings.taxationType), and no API
  // exists to edit it here — so when the account defines it, show it read-only
  // instead of a select whose "saved" value would be silently overridden.
  const accountTaxationType = activeConnectedAccount(snapshot)?.taxationType;
  const taxation: TaxationType = accountTaxationType ?? draft?.taxationType ?? current?.taxationType ?? "taxable";
  const isIra = taxation === "roth_ira" || taxation === "traditional_ira";
  const washSaleGuard: boolean = draft?.washSaleGuard ?? current?.washSaleGuard ?? true;
  const iraWashSaleHandling: IraWashSaleHandling = draft?.iraWashSaleHandling ?? current?.iraWashSaleHandling ?? "disregard";
  const subtractFromResults: boolean = draft?.subtractFromResults ?? current?.subtractFromResults ?? false;
  const shortTermRatePct: number = draft?.shortTermRatePct ?? current?.shortTermRatePct ?? 24;
  const longTermRatePct: number = draft?.longTermRatePct ?? current?.longTermRatePct ?? 15;

  const save = async () => {
    setBusy(true);
    try {
      await savePolicy({ taxSettings: draft ?? {} });
      await refresh();
      setDraft(null);
      toast.push("pos", "Tax settings saved");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Tax treatment"
      action={
        draft ? (
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" title="Throw away the unsaved tax edits." onClick={() => setDraft(null)}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" disabled={busy} title="Save tax treatment for this account." onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Btn>
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {accountTaxationType ? (
          <Field
            label="Account type"
            hint="Set on the connected account when it was linked — that value always wins over anything saved here, and this console can't change it yet."
          >
            <div className="con-input flex items-center bg-[color:var(--con-surface-2)] text-[color:var(--con-muted)]">
              {TAXATION_LABEL[accountTaxationType] ?? accountTaxationType}
            </div>
          </Field>
        ) : (
          <Field label="Account type" hint="IRAs zero the rates and skip the per-account wash-sale guard automatically." htmlFor="taxtype">
            <Select
              id="taxtype"
              value={taxation}
              title="How gains in this account are taxed. Drives the tax estimates and the wash-sale handling."
              onChange={(e) => setDraft((d) => ({ ...(d ?? {}), taxationType: e.target.value as TaxationType }))}
            >
              <option value="taxable">taxable brokerage</option>
              <option value="roth_ira">Roth IRA</option>
              <option value="traditional_ira">traditional IRA</option>
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short-term rate %" htmlFor="st-rate">
            <RawNumInput
              id="st-rate"
              value={String(shortTermRatePct)}
              emptyValue={0}
              title="Your estimated tax rate on gains from positions held one year or less. Used only for the tax estimates — not advice."
              onValueChange={(parsed) => setDraft((d) => ({ ...(d ?? {}), shortTermRatePct: parsed }))}
            />
          </Field>
          <Field label="Long-term rate %" htmlFor="lt-rate">
            <RawNumInput
              id="lt-rate"
              value={String(longTermRatePct)}
              emptyValue={0}
              title="Your estimated tax rate on gains from positions held more than one year. Used only for the tax estimates — not advice."
              onValueChange={(parsed) => setDraft((d) => ({ ...(d ?? {}), longTermRatePct: parsed }))}
            />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        {isIra ? (
          <div className="rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[length:var(--con-fs-sm)] font-semibold">Same-IRA wash sales</div>
                <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
                  Ignored automatically. This account has no taxable loss deduction inside the IRA, so Block / Ask /
                  Auto is not the relevant control.
                </p>
              </div>
              <Chip tone="pos">not applicable</Chip>
            </div>
            <div className="mt-3 max-w-md">
              <Field
                label="Taxable-loss rebuy inside this IRA"
                hint="Only applies when another taxable account sold the same symbol at a loss in the last 30 days. Ignore/disregard is the default for IRA accounts and lets the buy proceed with the audit note; Block is the stricter optional setting."
                htmlFor="ira-wash-sale"
              >
                <Select
                  id="ira-wash-sale"
                  value={iraWashSaleHandling}
                  title="Controls cross-account IRA replacement buys after a taxable loss. Same-IRA wash sales are already ignored. Default: ignore/disregard and annotate."
                  onChange={(e) =>
                    setDraft((d) => ({ ...(d ?? {}), iraWashSaleHandling: e.target.value as IraWashSaleHandling }))
                  }
                >
                  <option value="disregard">Ignore / disregard and annotate (default)</option>
                  <option value="block">Block cross-account IRA replacement buys</option>
                </Select>
              </Field>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
            title="On: buying back a symbol you sold at a loss in the last 30 days is blocked, so the loss stays deductible."
          >
            <div>
              <div className="text-[length:var(--con-fs-sm)] font-semibold">Taxable-account wash-sale guard</div>
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                Blocks rebuying a symbol this taxable account closed at a loss within 30 days. A taxable-account loss
                can also lock replacement buys across your other accounts, including IRAs.
              </p>
            </div>
            <Toggle
              checked={washSaleGuard}
              onChange={(next) => setDraft((d) => ({ ...(d ?? {}), washSaleGuard: next }))}
              label="Wash-sale guard"
            />
          </div>
        )}
        <div
          className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
          title="On: P&L on the Results screen is shown after subtracting estimated taxes at the rates above."
        >
          <div>
            <div className="text-[length:var(--con-fs-sm)] font-semibold">Show results net of estimated tax</div>
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Estimates only — not tax advice.</p>
          </div>
          <Toggle
            checked={subtractFromResults}
            onChange={(next) => setDraft((d) => ({ ...(d ?? {}), subtractFromResults: next }))}
            label="Subtract tax from results"
          />
        </div>
      </div>
    </Card>
  );
}

// ── All accounts: scan shape ─────────────────────────────────────────────────

function ScanShapeCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draft, setDraft] = useState<{ marketScanCandidateLimit?: number; marketScanOutlierReserve?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(draft !== null);
  if (!snapshot) return null;

  const policy = snapshot.policy;

  const save = async () => {
    setBusy(true);
    try {
      await savePolicy(draft ?? {});
      await refresh();
      setDraft(null);
      toast.push("pos", "Scan shape saved", "Applies to every account's runs.");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Market-scan shape"
      action={
        draft ? (
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" title="Throw away the unsaved scan-shape edits." onClick={() => setDraft(null)}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" disabled={busy} title="Save the scan shape — applies to every account's runs." onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Btn>
          </div>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        How wide every account&apos;s market scan looks. These two are user-level: they overlay all your accounts — the
        one deliberate exception to account scoping, labeled rather than hidden.
      </p>
      <div className="grid max-w-md grid-cols-2 gap-3">
        <Field label="Enriched candidates" hint="Ranked names that get full enrichment per run." htmlFor="scan-limit">
          <RawNumInput
            id="scan-limit"
            value={String(draft?.marketScanCandidateLimit ?? policy.marketScanCandidateLimit ?? "")}
            emptyValue={0}
            title="How many top-ranked symbols get full enrichment (fundamentals, news, technicals) each run. More = wider view, slower and costlier runs."
            onValueChange={(parsed) => setDraft((d) => ({ ...(d ?? {}), marketScanCandidateLimit: parsed }))}
          />
        </Field>
        <Field label="Outlier reserve" hint="Below-cutoff slots reserved for notable web signals." htmlFor="scan-reserve">
          <RawNumInput
            id="scan-reserve"
            value={String(draft?.marketScanOutlierReserve ?? policy.marketScanOutlierReserve ?? "")}
            emptyValue={0}
            title="Of the candidate slots, how many are held for symbols that rank below the cutoff but carry a notable web signal (news spike, unusual activity)."
            onValueChange={(parsed) => setDraft((d) => ({ ...(d ?? {}), marketScanOutlierReserve: parsed }))}
          />
        </Field>
      </div>
    </Card>
  );
}

// ── All accounts: boot behavior ──────────────────────────────────────────────

function BootBehaviorCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  return (
    <Card title="After a restart">
      <div
        className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
        title="Controls what happens to Running accounts when the server process restarts. Off keeps the safety net: a human must start trading again."
      >
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Auto-resume on boot</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            Off (recommended): whenever the server restarts, any Running account is stopped until a person starts it
            again — a restored backup or crash-loop can never silently resume trading. Turning this ON removes that
            safety net.
          </p>
        </div>
        <Toggle
          checked={snapshot.autoResumeOnBoot}
          onChange={async (next) => {
            setBusy(true);
            try {
              await setAutoResume(next);
              await refresh();
              toast.push(next ? "warn" : "pos", next ? "Auto-resume ON" : "Auto-resume off", next ? "Accounts left Running will resume by themselves after a restart." : "Restarts stop everything until you start it again.");
            } catch (error) {
              toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          label="Auto-resume on boot"
        />
      </div>
    </Card>
  );
}

// ── You ──────────────────────────────────────────────────────────────────────

function YouCard() {
  const { snapshot } = useConsoleData();
  if (!snapshot?.currentUser) return null;
  const user = snapshot.currentUser;
  return (
    <Card title="You">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--con-fs-sm)]">
        <span className="font-semibold" title="The signed-in user every ALL YOUR ACCOUNTS setting belongs to.">
          {user.name ?? user.email ?? user.userId}
        </span>
        {user.email && user.name && <span className="text-[color:var(--con-faint)]">{user.email}</span>}
        {user.isAdmin && (
          <Chip tone="accent" title="This login has operator/admin rights on the server.">
            admin
          </Chip>
        )}
        {user.loginProvider && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title="Which identity provider authenticated this session.">
            via {user.loginProvider}
          </span>
        )}
      </div>
    </Card>
  );
}
