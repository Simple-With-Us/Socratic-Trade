"use client";

/** Data sharing — the two independent sharing surfaces, each stated honestly:
 *  1. Shared market-data pool (GET/POST /api/consent): GENERAL market data
 *     pulled through your keys/broker is pooled with other consenting users.
 *     Personal account data is never pooled. This is the same consent the
 *     first-run gate asks for — this card is where you change your answer.
 *  2. Learned-context sharing (GET/PUT /api/learned-context/sharing): only
 *     FACT-tier learnings are ever shared; risk/strategy directives always
 *     stay in your private confirmation queue.
 *  Self-contained fetch helpers on purpose (no changes to lib.ts). */

import { useEffect, useState } from "react";
import { useToast } from "../ui/toast";
import { Card, Toggle } from "../ui/primitives";

interface PoolConsentState {
  accepted: boolean;
  needsConsent?: boolean;
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
      className="con-row flex items-center justify-between gap-4 rounded-md px-1.5 py-1.5"
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

  const setPoolConsent = async (accepted: boolean) => {
    if (busy || pool === null) return;
    setBusy(true);
    try {
      const record = await sendJson<PoolConsentState>("/api/consent", "POST", { accepted });
      setPool(record);
      toast.push(
        accepted ? "pos" : "info",
        accepted ? "Market-data pooling on" : "Market-data pooling off",
        accepted
          ? "You contribute general market data and read what others contribute. Personal account data is never pooled."
          : "You use only your own data. Nothing you pull is contributed."
      );
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <Card title="Data sharing">
      <p className="mb-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Two separate switches, two separate kinds of data. Neither ever shares your personal account data — positions,
        orders, balances, P&amp;L, and credentials stay private to you, always.
      </p>
      {loadFailed && (
        <p className="mb-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">
          Sharing state could not be loaded — the affected controls stay locked rather than showing a guess. Reload to
          retry.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <SharingRow
          title="Shared market-data pool"
          body={
            pool === null
              ? "Loading current state…"
              : pool.accepted
                ? "On — general market data (quotes, fundamentals, history, news) you pull through your own keys or broker is pooled with other consenting users, and you read theirs. This is the consent the first-run notice asked for."
                : "Off — you use only your own data; nothing you pull is contributed to the pool."
          }
          checked={pool?.accepted ?? false}
          loading={busy || pool === null}
          onChange={(v) => void setPoolConsent(v)}
          rowTitle="Pool GENERAL market data with other consenting users to cut API spend. Personal account data is never pooled. Same consent as the first-run notice."
        />
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
          rowTitle="Read the shared learned-fact pool. Only fact-tier items exist there — risk and strategy directives are never shared by anyone."
        />
        <SharingRow
          title="Contribute your learned facts"
          body={
            lc === null
              ? "Loading current state…"
              : lc.contributeShared
                ? "On — new fact-tier learnings from your runs are shared with opted-in users. Risk and strategy directives never leave your private queue."
                : "Off — everything you learn stays private to your account."
          }
          checked={lc?.contributeShared ?? false}
          loading={busy || lc === null}
          onChange={(v) => void setLcSharing({ contributeShared: v })}
          rowTitle="Share your fact-tier learnings back to the pool. Only facts qualify; anything risk-bearing goes to your private confirmation queue instead."
        />
      </div>
    </Card>
  );
}
