"use client";

/** Data sharing — market-data pool is mandatory (accept-or-cannot-use).
 *  Learned-context sharing remains two independent opt-in/out switches.
 *  Personal account data is never pooled. */

import { useEffect, useState } from "react";
import { useToast } from "../ui/toast";
import { Card, Toggle } from "../ui/primitives";

interface PoolConsentState {
  accepted: boolean;
  acceptedAt?: string | null;
  version?: number;
  needsConsent?: boolean;
  mandatory?: boolean;
}

interface LcSharingState {
  includeShared: boolean;
  contributeShared: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as T;
}

async function sendJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Request failed (${res.status}).`);
  }
  return (await res.json()) as T;
}

function SharingRow({
  title,
  body,
  checked,
  loading,
  onChange,
  rowTitle
}: {
  title: string;
  body: string;
  checked: boolean;
  loading: boolean;
  onChange: (next: boolean) => void;
  rowTitle: string;
}) {
  return (
    <div
      className="con-row flex items-center justify-between gap-4 rounded-control px-1.5 py-1.5"
      title={rowTitle}
    >
      <div>
        <div className="text-[length:var(--con-fs-sm)] font-semibold">{title}</div>
        <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{body}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={loading} label={title} />
    </div>
  );
}

export function DataSharingCard() {
  const toast = useToast();
  const [pool, setPool] = useState<PoolConsentState | null>(null);
  const [lc, setLc] = useState<LcSharingState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([getJson<PoolConsentState>("/api/consent"), getJson<LcSharingState>("/api/learned-context/sharing")]).then(
      ([poolRes, lcRes]) => {
        if (cancelled) return;
        if (poolRes.status === "fulfilled") setPool(poolRes.value);
        if (lcRes.status === "fulfilled") setLc(lcRes.value);
        if (poolRes.status === "rejected" || lcRes.status === "rejected") setLoadFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setLcSharing = async (patch: Partial<LcSharingState>) => {
    if (busy || lc === null) return;
    setBusy(true);
    try {
      const updated = await sendJson<LcSharingState>("/api/learned-context/sharing", "PUT", patch);
      setLc(updated);
      toast.push("pos", "Learned-context sharing saved");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const poolAccepted = pool?.accepted === true && pool.needsConsent !== true;
  const poolBody =
    pool === null
      ? "Loading current state…"
      : poolAccepted
        ? "Required — general market data (quotes, fundamentals, history, news) you pull through your own keys or broker is pooled with other users who accepted the same terms.  Personal account data is never pooled."
        : "Required to use the app.  Accept the terms notice to contribute and read the shared market-data pool.";

  return (
    <Card title="Data sharing">
      <p className="mb-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Market-data pooling is required.  Learned-fact sharing is optional.  Neither ever shares your
        personal account data — positions, orders, balances, P&amp;L, and credentials stay private
        to you, always.
      </p>
      {loadFailed && (
        <p className="mb-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">
          Sharing state could not be loaded — the affected controls stay locked rather than showing a
          guess.  Reload to retry.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <div className="con-row rounded-control px-1.5 py-1.5">
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Shared market-data pool</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            {poolBody}
          </p>
        </div>
        <SharingRow
          title="Use facts shared by others"
          body={
            lc === null
              ? "Loading current state…"
              : lc.includeShared
                ? "On — your AI decisions may draw on fact-tier learnings contributed by other opted-in users."
                : "Off — only your own learned facts inform your AI decisions."
          }
          checked={lc?.includeShared ?? false}
          loading={busy || lc === null}
          onChange={(v) => void setLcSharing({ includeShared: v })}
          rowTitle="Read the shared learned-fact pool.  Only fact-tier items exist there — risk and strategy directives are never shared by anyone."
        />
        <SharingRow
          title="Contribute your learned facts"
          body={
            lc === null
              ? "Loading current state…"
              : lc.contributeShared
                ? "On — new fact-tier learnings from your runs are shared with opted-in users.  Risk and strategy directives never leave your private queue."
                : "Off — everything you learn stays private to your account."
          }
          checked={lc?.contributeShared ?? false}
          loading={busy || lc === null}
          onChange={(v) => void setLcSharing({ contributeShared: v })}
          rowTitle="Share your fact-tier learnings back to the pool.  Only facts qualify; anything risk-bearing goes to your private confirmation queue instead."
        />
      </div>
    </Card>
  );
}
