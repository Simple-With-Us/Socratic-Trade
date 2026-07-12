"use client";

/** Delivery channels — where out-of-app alerts actually go (phone push,
 *  webhook, email, SMS). Reads GET /api/notifications (channel availability +
 *  saved prefs), writes POST /api/notifications, and exercises every enabled
 *  channel via the existing test endpoint. A channel can only be enabled when
 *  the server operator has configured its provider (e.g. email needs a Resend
 *  key) — unavailable ones say so instead of failing silently. Ports the
 *  legacy DeliveryChannelsPanel into the console's grammar with a dirty-guard
 *  draft and per-channel test results. */

import { useCallback, useEffect, useState } from "react";
import { sendTestNotification, ConsoleApiError } from "../lib/api";
import { useUnsavedChanges } from "../lib/useDirtyGuard";
import { useToast } from "../ui/toast";
import { Btn, Card, Field, TextInput, Toggle } from "../ui/primitives";
import {
  fetchDeliverySettings,
  saveDeliveryPrefs,
  EMPTY_DELIVERY_PREFS,
  type DeliveryChannelDescriptor,
  type DeliveryPrefs
} from "./lib";

const CHANNEL_TITLE: Record<DeliveryChannelDescriptor["id"], string> = {
  push: "A push notification on your phone via a notification app — usually the fastest and cheapest channel.",
  webhook: "An HTTPS POST with a JSON payload to any URL you control (chat webhooks get rich embeds).",
  email: "An email per alert. Needs the server operator to have configured an email provider.",
  sms: "A text message per alert. Needs the server operator's Twilio credentials; carrier rates may apply."
};

interface TestResult {
  channel: string;
  ok: boolean;
  skipped?: string;
  error?: string;
}

export function DeliveryChannelsCard() {
  const toast = useToast();
  const [channels, setChannels] = useState<DeliveryChannelDescriptor[] | null>(null);
  const [saved, setSaved] = useState<DeliveryPrefs>(EMPTY_DELIVERY_PREFS);
  const [draft, setDraft] = useState<DeliveryPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [results, setResults] = useState<TestResult[] | null>(null);

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedChanges(dirty);

  const load = useCallback(async () => {
    try {
      const body = await fetchDeliverySettings();
      setChannels(body.channels ?? []);
      const prefs = { ...EMPTY_DELIVERY_PREFS, ...body.prefs, channels: body.prefs?.channels ?? [] };
      setSaved(prefs);
      setDraft(null);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ConsoleApiError ? error.message : "Could not load delivery channels.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prefs = draft ?? saved;
  const setPrefs = (updater: (p: DeliveryPrefs) => DeliveryPrefs) => setDraft(updater(prefs));

  const targetValue = (field: string) => (prefs as unknown as Record<string, unknown>)[field];
  const setTarget = (field: string, value: string) => setPrefs((p) => ({ ...p, [field]: value }));
  const toggleChannel = (id: string, on: boolean) =>
    setPrefs((p) => ({
      ...p,
      channels: on ? Array.from(new Set([...p.channels, id])) : p.channels.filter((c) => c !== id)
    }));

  const save = async () => {
    setBusy("save");
    try {
      const { prefs: persisted } = await saveDeliveryPrefs(prefs);
      setSaved({ ...EMPTY_DELIVERY_PREFS, ...persisted, channels: persisted?.channels ?? [] });
      setDraft(null);
      toast.push("pos", "Delivery channels saved");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    setResults(null);
    try {
      // The test always uses SAVED prefs — persist the draft first so what you
      // test is what will actually fire.
      if (dirty || draft !== null) {
        const { prefs: persisted } = await saveDeliveryPrefs(prefs);
        setSaved({ ...EMPTY_DELIVERY_PREFS, ...persisted, channels: persisted?.channels ?? [] });
        setDraft(null);
      }
      const { results: r } = await sendTestNotification();
      setResults(r);
      const sent = r.filter((x) => x.ok).length;
      if (sent > 0) toast.push("pos", `Test sent via ${sent} channel${sent > 1 ? "s" : ""}`, "Check that it actually arrived before trusting real-money alerts.");
      else toast.push("warn", "No channel delivered", "Check the toggles, targets, and the server's provider keys.");
    } catch (error) {
      toast.push("neg", "Test failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Delivery channels"
      action={
        <div className="flex gap-2">
          {dirty && (
            <>
              <Btn variant="ghost" size="sm" onClick={() => setDraft(null)} title="Throw away unsaved channel edits.">
                Discard
              </Btn>
              <Btn variant="primary" size="sm" disabled={busy !== null} onClick={() => void save()} title="Persist these channel choices and targets.">
                {busy === "save" ? "Saving…" : "Save"}
              </Btn>
            </>
          )}
          <Btn
            size="sm"
            disabled={busy !== null || channels === null}
            onClick={() => void sendTest()}
            title="Saves any pending edits, then fires a test alert through every enabled channel so you can confirm it reaches you."
          >
            {busy === "test" ? "Sending…" : "Send test"}
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Where alerts leave the app — one setup for your whole login, across every account. Which events fire is chosen
        in Event notifications above; this is how they reach you. Without any channel, events are still recorded in
        Activity, just not pushed anywhere.
      </p>

      {loadError && (
        <p className="mb-3 rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()} title="Try loading the channels again.">
            Retry
          </button>
        </p>
      )}

      {channels === null && !loadError && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading channels…</p>
      )}

      {channels !== null && (
        <div className="flex flex-col gap-2">
          {channels.map((ch) => {
            const on = prefs.channels.includes(ch.id);
            const target = targetValue(ch.targetField);
            return (
              <div
                key={ch.id}
                className="rounded-lg border border-[color:var(--con-line)] p-3 transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[length:var(--con-fs-sm)] font-semibold" title={CHANNEL_TITLE[ch.id]}>
                      {ch.label}
                    </span>
                    {ch.id === "push" && ch.available && (
                      <span
                        className="rounded-full border border-[color:var(--con-pos-border)] bg-[color:var(--con-pos-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[color:var(--con-pos)]"
                        title="Push via ntfy needs no account or key and is free — the recommended first channel."
                      >
                        recommended · free
                      </span>
                    )}
                    {!ch.available && (
                      <span
                        className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                        title="The server operator hasn't configured this channel's provider, so it can't be enabled from here."
                      >
                        not configured on the server
                      </span>
                    )}
                  </div>
                  <Toggle
                    checked={on}
                    disabled={!ch.available || busy !== null}
                    onChange={(next) => toggleChannel(ch.id, next)}
                    label={`${ch.label} channel`}
                  />
                </div>
                {on && ch.available && (
                  <div className="mt-2 max-w-md">
                    <Field label={ch.targetLabel} hint={ch.hint} htmlFor={`ch-${ch.id}`}>
                      <TextInput
                        id={`ch-${ch.id}`}
                        value={typeof target === "string" ? target : ""}
                        placeholder={ch.placeholder}
                        onChange={(e) => setTarget(ch.targetField, e.target.value)}
                        title={ch.hint}
                      />
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {results && (
        <ul className="mt-3 flex flex-col gap-1 text-[length:var(--con-fs-xs)]">
          {results.length === 0 && <li className="text-[color:var(--con-muted)]">No channels enabled — toggle one above first.</li>}
          {results.map((r, i) => (
            <li
              key={i}
              className={r.ok ? "text-[color:var(--con-pos)]" : "text-[color:var(--con-muted)]"}
              title={r.ok ? "The test message was accepted by the provider." : r.skipped ? "Skipped — the channel is off, has no target, or its provider isn't configured." : r.error ?? "The provider rejected the test."}
            >
              {r.ok ? "✓" : "—"} {r.channel}
              {r.skipped ? ` (${r.skipped.replace(/_/g, " ")})` : r.ok ? " — sent" : ` — failed${r.error ? `: ${r.error}` : ""}`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
