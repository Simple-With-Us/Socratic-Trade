"use client";

// Direct notification delivery editor (email/SMS/push/webhook) for the NEW multi-channel notify.ts
// system (notification_prefs table), distinct from the legacy policy.notificationSettings webhook.
// Reads GET /api/notifications (channels + prefs), writes POST /api/notifications, and exercises every
// enabled channel via POST /api/notifications/test. A channel toggles only when the operator has
// configured its provider key (descriptor.available) — e.g. Email needs RESEND_API_KEY, SMS needs Twilio.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, inputClass } from "./primitives";

interface ChannelDescriptor {
  id: "push" | "webhook" | "email" | "sms";
  label: string;
  available: boolean;
  provider?: string | null;
  targetField: string;
  targetLabel: string;
  placeholder: string;
  hint: string;
}
interface Prefs {
  channels: string[];
  pushTarget: string;
  webhookUrl: string;
  email: string;
  phone: string;
}
interface TestResult {
  channel: string;
  ok: boolean;
  skipped?: string;
}

const EMPTY: Prefs = { channels: [], pushTarget: "", webhookUrl: "", email: "", phone: "" };

export function DeliveryChannelsPanel() {
  const [channels, setChannels] = useState<ChannelDescriptor[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const body = (await res.json()) as { channels: ChannelDescriptor[]; prefs: Prefs };
        if (!cancelled) {
          setChannels(body.channels ?? []);
          setPrefs({ ...EMPTY, ...body.prefs, channels: body.prefs?.channels ?? [] });
        }
      } catch {
        /* best-effort */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const targetValue = (field: string) => (prefs as unknown as Record<string, string>)[field] ?? "";
  const setTarget = (field: string, value: string) => setPrefs((p) => ({ ...p, [field]: value }));
  const toggle = (id: string, on: boolean) =>
    setPrefs((p) => ({
      ...p,
      channels: on ? Array.from(new Set([...p.channels, id])) : p.channels.filter((c) => c !== id)
    }));

  const persist = useCallback(async () => {
    const res = await fetch("/api/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }, [prefs]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await persist();
      toast.success("Delivery channels saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [persist]);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setResults(null);
    try {
      await persist(); // test uses the latest saved prefs
      const res = await fetch("/api/notifications/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json()) as { results: TestResult[] };
      setResults(body.results ?? []);
      const sent = (body.results ?? []).filter((r) => r.ok).length;
      if (sent > 0) toast.success(`Test sent via ${sent} channel${sent > 1 ? "s" : ""}.`);
      else toast.warning("No channel delivered — check the toggles, targets, and provider keys.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  }, [persist]);

  if (loading) return <p className="text-xs text-muted">Loading delivery channels…</p>;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {channels.map((ch) => {
          const on = prefs.channels.includes(ch.id);
          return (
            <div key={ch.id} className="rounded-md border border-line p-2.5">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!ch.available}
                  onChange={(e) => toggle(ch.id, e.target.checked)}
                  className="rounded border-line"
                />
                <span className="font-medium text-fg">{ch.label}</span>
                {ch.id === "push" && ch.available && (
                  <span className="rounded bg-up/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-up">Recommended · free</span>
                )}
                {!ch.available && <span className="text-xs text-down">not configured</span>}
              </label>
              {on && ch.available && (
                <div className="mt-2">
                  <span className="mb-1 block text-xs text-muted">{ch.targetLabel}</span>
                  <input
                    className={inputClass}
                    value={targetValue(ch.targetField)}
                    placeholder={ch.placeholder}
                    onChange={(e) => setTarget(ch.targetField, e.target.value)}
                  />
                  {ch.hint && <span className="mt-1 block text-[11px] text-faint">{ch.hint}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save channels"}
        </Button>
        <Button size="sm" variant="subtle" onClick={() => void sendTest()} disabled={testing}>
          {testing ? "Sending…" : "Send test"}
        </Button>
      </div>
      {results && (
        <ul className="space-y-1 text-xs">
          {results.length === 0 && <li className="text-muted">No channels enabled — toggle one above first.</li>}
          {results.map((r, i) => (
            <li key={i} className={r.ok ? "text-up" : "text-muted"}>
              {r.ok ? "✓" : "—"} {r.channel}
              {r.skipped ? ` (${r.skipped.replace(/_/g, " ")})` : r.ok ? " — sent" : " — failed"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
