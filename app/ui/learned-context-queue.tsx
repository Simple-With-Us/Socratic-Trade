"use client";

import { AlertTriangle, Brain, Check, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  formatStrategyDirectiveBlock,
  relativeDate,
  tierLabel,
  tierTone,
  type PendingTier
} from "@/lib/learned-context-queue-helpers";
import { cn } from "./cn";
import { Modal, SlideOver } from "./overlays";
import { Button, Card, Chip } from "./primitives";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PendingLearnedItem {
  id: string;
  riskTier: PendingTier;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  origin: string;
  classifierReason: string | null;
  createdAt: string;
  status: string;
}

// ── Approve confirm modal ──────────────────────────────────────────────────

function ApproveConfirmModal({
  item,
  onClose,
  onConfirm,
  busy
}: {
  item: PendingLearnedItem;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const isDirective = item.riskTier === "strategy-directive";
  const block = isDirective
    ? formatStrategyDirectiveBlock(item.id, item.createdAt, item.value)
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Approve ${tierLabel(item.riskTier)}?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => { if (!busy) onConfirm(); }}
            disabled={busy}
          >
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {isDirective ? (
          <>
            <p className="text-sm leading-relaxed text-muted">
              This will append the block below to your strategy prompt. The existing prompt is
              preserved — this block is additive only.
            </p>
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11px] text-muted leading-relaxed">
              {block}
            </pre>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            This promotes the learned context to advisory context for the AI. It does{" "}
            <strong className="font-semibold text-fg">NOT</strong> change your numeric risk
            limits — adjust those yourself in Risk settings.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ── Single item card ───────────────────────────────────────────────────────

function PendingItemCard({
  item,
  onApprove,
  onReject
}: {
  item: PendingLearnedItem;
  onApprove: (item: PendingLearnedItem) => void;
  onReject: (item: PendingLearnedItem) => void;
}) {
  const tone = tierTone(item.riskTier);
  const isDirective = item.riskTier === "strategy-directive";
  const block = isDirective
    ? formatStrategyDirectiveBlock(item.id, item.createdAt, item.value)
    : null;

  return (
    <Card className="flex flex-col gap-3 p-4">
      {/* Header row: tier badge + subject + date */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Chip tone={tone}>
            {tone === "warn" ? (
              <AlertTriangle size={14} />
            ) : (
              <Brain size={14} />
            )}
            {tierLabel(item.riskTier)}
          </Chip>
          <span className="text-sm font-medium text-fg break-words">{item.subject}</span>
          {item.symbol && (
            <span className="text-xs font-mono text-muted bg-surface-2 rounded px-1 py-0.5">
              {item.symbol}
            </span>
          )}
        </div>
        <span className="text-xs text-faint shrink-0">{relativeDate(item.createdAt)}</span>
      </div>

      {/* Value */}
      <p className="text-sm text-fg leading-relaxed">{item.value}</p>

      {/* strategy-directive: prompt-block preview */}
      {isDirective && block && (
        <div className="rounded-lg border border-line bg-surface-2 p-3 space-y-1.5">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted leading-relaxed">
            {block}
          </pre>
          <p className="text-[11px] text-faint">
            Approving appends this block to your strategy prompt (existing prompt preserved).
          </p>
        </div>
      )}

      {/* risk: advisory caption */}
      {item.riskTier === "risk" && (
        <p className="text-[11px] text-faint">
          Approving promotes this to advisory context for the AI; it does{" "}
          <strong className="font-semibold text-muted">NOT</strong> change your risk limits —
          adjust those yourself in Risk settings.
        </p>
      )}

      {/* Secondary metadata: origin + classifierReason */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
        <span>Origin: <span className="text-muted">{item.origin}</span></span>
        {item.classifierReason && (
          <span>Reason: <span className="text-muted">{item.classifierReason}</span></span>
        )}
        <span>Kind: <span className="text-muted">{item.kind}</span></span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="accentSoft"
          size="sm"
          onClick={() => onApprove(item)}
          className="gap-1.5"
        >
          <Check size={14} /> Approve
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReject(item)}
          className="gap-1.5 text-muted"
        >
          <X size={14} /> Reject
        </Button>
      </div>
    </Card>
  );
}

// ── Main SlideOver component ───────────────────────────────────────────────

export function LearnedContextQueue({
  open,
  onClose,
  onCountChange
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the new pending count whenever it changes (so parent can update the badge). */
  onCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<PendingLearnedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedOnce, setFetchedOnce] = useState(false);
  const [approvingItem, setApprovingItem] = useState<PendingLearnedItem | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Fetch pending list when opened (re-fetch every open to stay fresh)
  function fetchItems() {
    setLoading(true);
    setError(null);
    fetch("/api/learned-context/pending", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PendingLearnedItem[]>;
      })
      .then((data) => {
        const pending = data.filter((i) => i.status === "pending");
        setItems(pending);
        setFetchedOnce(true);
        onCountChange?.(pending.length);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load pending changes.");
      })
      .finally(() => setLoading(false));
  }

  // Re-fetch on every open
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    fetchItems();
  }
  if (!open && lastOpen) {
    setLastOpen(false);
  }

  async function handleApproveConfirm() {
    if (!approvingItem || actionBusy) return;
    setActionBusy(true);
    try {
      const r = await fetch(`/api/learned-context/pending/${approvingItem.id}/approve`, {
        method: "POST"
      });
      if (!r.ok) throw new Error(await r.text());
      toast.success("Learned change approved.");
      setApprovingItem(null);
      const next = items.filter((i) => i.id !== approvingItem.id);
      setItems(next);
      onCountChange?.(next.length);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleReject(item: PendingLearnedItem) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const r = await fetch(`/api/learned-context/pending/${item.id}/reject`, {
        method: "POST"
      });
      if (!r.ok) throw new Error(await r.text());
      toast.success("Learned change rejected.");
      const next = items.filter((i) => i.id !== item.id);
      setItems(next);
      onCountChange?.(next.length);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rejection failed.");
    } finally {
      setActionBusy(false);
    }
  }

  const subtitle =
    loading ? "Loading…"
    : error ? "Error loading"
    : items.length === 0 && fetchedOnce ? "No pending changes"
    : `${items.length} pending`;

  return (
    <>
      <SlideOver
        open={open}
        onClose={onClose}
        title="Pending Learned Changes"
        subtitle={subtitle}
        icon={<Brain size={20} />}
        width="max-w-xl"
      >
        <div className="flex flex-col gap-3 p-4">
          {loading && (
            <div className="flex items-center justify-center py-12 text-sm text-muted">
              Loading…
            </div>
          )}

          {!loading && error && (
            <div className="rounded-lg border border-down/30 bg-down/10 px-4 py-3 text-sm text-down">
              {error}
            </div>
          )}

          {!loading && !error && fetchedOnce && items.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
              <Brain size={20} className="text-faint" />
              <p className="text-sm text-muted">No pending learned changes</p>
              <p className="text-xs text-faint max-w-xs">
                Autonomous runs may queue learned context here for your review before it
                influences the AI.
              </p>
            </div>
          )}

          {!loading && !error && items.map((item) => (
            <PendingItemCard
              key={item.id}
              item={item}
              onApprove={(i) => setApprovingItem(i)}
              onReject={handleReject}
            />
          ))}
        </div>
      </SlideOver>

      {approvingItem && (
        <ApproveConfirmModal
          item={approvingItem}
          onClose={() => setApprovingItem(null)}
          onConfirm={handleApproveConfirm}
          busy={actionBusy}
        />
      )}
    </>
  );
}

// ── Badge trigger button ───────────────────────────────────────────────────

export function LearnedContextQueueBadge({
  count,
  onClick
}: {
  count: number;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      onClick={onClick}
      aria-label={`Pending learned changes — ${count} item${count === 1 ? "" : "s"} awaiting review`}
      className={cn(
        "relative inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface/50 px-2 text-xs font-medium text-fg backdrop-blur-xl transition-colors hover:bg-surface-2/50 lg:h-9 lg:gap-1.5 lg:px-3 lg:text-sm"
      )}
    >
      <Brain size={16} />
      <span className="hidden sm:inline">Learned</span>
      <span
        aria-live="polite"
        className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-bold text-white"
      >
        {count}
      </span>
    </button>
  );
}
