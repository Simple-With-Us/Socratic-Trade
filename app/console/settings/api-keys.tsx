"use client";

/** API keys — per-user provider keys over /api/keys. The server NEVER returns
 *  a stored key value (GET is status-only: configured + source), so this UI
 *  never shows one either: a key is written once and thereafter only described.
 *  "Server key" means the operator's env credential is serving you — you can
 *  still store your own, which always wins. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConsoleApiError } from "../lib/api";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Field, TextInput } from "../ui/primitives";
import { deleteApiKey, listApiKeys, saveApiKey, type ApiKeyEntry } from "./lib";

const SOURCE_COPY: Record<ApiKeyEntry["source"], { chip: string; title: string; tone: "pos" | "accent" | "muted" }> = {
  user: {
    chip: "your key",
    title: "You stored a key for this service. It always wins over any server-level credential.",
    tone: "pos"
  },
  env: {
    chip: "server key",
    title: "No key of your own — the server operator's credential is serving this for you. Add your own to take over.",
    tone: "accent"
  },
  none: {
    chip: "not set",
    title: "No key resolves for this service. The features it unlocks stay unavailable until one is added.",
    tone: "muted"
  }
};

export function ApiKeysCard() {
  const toast = useToast();
  const [entries, setEntries] = useState<ApiKeyEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // service being edited
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { keys } = await listApiKeys();
      setEntries(keys);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ConsoleApiError ? error.message : "Could not load API keys.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byCategory = useMemo(() => {
    const groups = new Map<string, ApiKeyEntry[]>();
    for (const entry of entries ?? []) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }
    return [...groups.entries()];
  }, [entries]);

  const removeKey = async (entry: ApiKeyEntry) => {
    setBusy(entry.service);
    try {
      await deleteApiKey(entry.service);
      await load();
      setConfirmingDelete(null);
      toast.push("pos", `${entry.label} key removed`, "Features it unlocked fall back to the server key if one exists, otherwise turn off.");
    } catch (error) {
      toast.push("neg", "Could not remove key", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="API keys">
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Optional provider keys, stored per user on the server. Keys are write-only: once saved they are never displayed
        again — only whether one is set and where it came from. Everything works without any of these; each key just
        unlocks the data or models it names.
      </p>

      {loadError && (
        <p className="mb-3 rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {loadError} — showing nothing rather than something stale.{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()} title="Try loading the key list again.">
            Retry
          </button>
        </p>
      )}

      {entries === null && !loadError && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading key status…</p>
      )}

      <div className="flex flex-col gap-3">
        {byCategory.map(([category, list]) => (
          <div key={category}>
            <div className="con-card-title mb-1.5" title={`Keys in the "${category}" group.`}>
              {category}
            </div>
            <div className="flex flex-col divide-y divide-[color:var(--con-line)] rounded-lg border border-[color:var(--con-line)]">
              {list.map((entry) => {
                const source = SOURCE_COPY[entry.source] ?? SOURCE_COPY.none;
                const isEditing = editing === entry.service;
                const isConfirmingDelete = confirmingDelete === entry.service;
                return (
                  <div
                    key={entry.service}
                    tabIndex={0}
                    className="px-3 py-2.5 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-[color:var(--con-surface-2)] focus-visible:bg-[color:var(--con-surface-2)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="font-semibold" title={entry.unlocks}>
                          {entry.label}
                        </span>
                        <Chip tone={source.tone} title={source.title}>
                          {source.chip}
                        </Chip>
                        {entry.source === "user" && entry.updatedAt && (
                          <span
                            className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
                            title="When you last saved a key for this service."
                          >
                            saved <Ago iso={entry.updatedAt} />
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <a
                          href={entry.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)] hover:underline"
                          title={`Opens ${entry.label}'s own site, where keys are created. (new tab)`}
                        >
                          get a key ↗
                        </a>
                        <Btn
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => {
                            setEditing(isEditing ? null : entry.service);
                            setConfirmingDelete(null);
                          }}
                          title={
                            entry.source === "user"
                              ? "Replace your stored key with a new value. The old one is overwritten server-side."
                              : "Store your own key for this service."
                          }
                        >
                          {isEditing ? "Close" : entry.source === "user" ? "Replace" : "Add key"}
                        </Btn>
                        {entry.source === "user" && (
                          <Btn
                            size="sm"
                            variant="dangerOutline"
                            disabled={busy !== null}
                            onClick={() => {
                              setConfirmingDelete(isConfirmingDelete ? null : entry.service);
                              setEditing(null);
                            }}
                            title="Delete your stored key from the server. Falls back to the server key if one exists."
                          >
                            Remove
                          </Btn>
                        )}
                      </div>
                    </div>
                    <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title={entry.envVar ? `Server-side env var for this service: ${entry.envVar}` : undefined}>
                      {entry.unlocks}
                    </p>
                    {isConfirmingDelete && (
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-2.5">
                        <span className="text-[length:var(--con-fs-xs)]">
                          Remove your {entry.label} key? This can&apos;t be undone — you&apos;d have to paste a new key.
                        </span>
                        <div className="flex gap-2">
                          <Btn size="sm" variant="ghost" onClick={() => setConfirmingDelete(null)} title="Keep the key.">
                            Cancel
                          </Btn>
                          <Btn
                            size="sm"
                            variant="danger"
                            disabled={busy !== null}
                            onClick={() => void removeKey(entry)}
                            title="Delete the stored key now."
                          >
                            {busy === entry.service ? "Removing…" : "Remove key"}
                          </Btn>
                        </div>
                      </div>
                    )}
                    {isEditing && (
                      <KeyEditor
                        entry={entry}
                        busy={busy === entry.service}
                        onCancel={() => setEditing(null)}
                        onSave={async (value, label) => {
                          setBusy(entry.service);
                          try {
                            await saveApiKey(entry.service, value, label);
                            await load();
                            setEditing(null);
                            toast.push("pos", `${entry.label} key saved`, "Stored server-side. It won't be shown again.");
                          } catch (error) {
                            toast.push("neg", "Could not save key", error instanceof ConsoleApiError ? error.message : String(error));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function KeyEditor({
  entry,
  busy,
  onCancel,
  onSave
}: {
  entry: ApiKeyEntry;
  busy: boolean;
  onCancel: () => void;
  onSave: (value: string, label?: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [label, setLabel] = useState(entry.savedLabel ?? "");

  return (
    <div className="mt-2 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-2.5">
      <div className="grid gap-2.5 sm:grid-cols-[1fr_auto]">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Field
            label={entry.source === "user" ? "New key (replaces the stored one)" : "Key"}
            htmlFor={`key-${entry.service}`}
          >
            <TextInput
              id={`key-${entry.service}`}
              type="password"
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder="paste the key — sent once, never shown again"
              onChange={(e) => setValue(e.target.value)}
              title="The secret value from the provider. Stored server-side; this field is the only place it ever appears."
            />
          </Field>
          <Field label="Label (optional)" htmlFor={`key-label-${entry.service}`}>
            <TextInput
              id={`key-label-${entry.service}`}
              value={label}
              placeholder="e.g. personal, work"
              onChange={(e) => setLabel(e.target.value)}
              title="A non-secret note to remember which key this is."
            />
          </Field>
        </div>
        <div className="flex items-end gap-2">
          <Btn size="sm" variant="ghost" onClick={onCancel} title="Discard without saving.">
            Cancel
          </Btn>
          <Btn
            size="sm"
            variant="primary"
            disabled={busy || value.trim().length === 0}
            onClick={() => void onSave(value.trim(), label)}
            title="Store this key server-side for your user."
          >
            {busy ? "Saving…" : "Save key"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
