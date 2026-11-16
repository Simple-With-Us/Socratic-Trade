"use client";

/** Delete account & data — console port of the legacy 3-step deletion flow,
 *  wired to the real endpoints (GET/POST/DELETE /api/account/deletion →
 *  src/lib/account-deletion.ts). The server is the source of truth for every
 *  gate: prepared-first, typed email + phrase, five acknowledgements, the
 *  local-operator extra phrase, and activity blockers. This UI mirrors those
 *  gates so nothing is discoverable only by failing.
 *  Honest scope: this deletes THIS APP's data for your login. It does not
 *  close broker positions, cancel broker orders, or delete your Google/
 *  GitHub/Apple account — and signing in again later can create a fresh,
 *  empty app account. */

import { useState } from "react";
import Link from "next/link";
import { OctagonAlert, Trash2 } from "lucide-react";
import { useToast } from "../ui/toast";
import { Btn, Card, Chip, Field, TextInput } from "../ui/primitives";

const ACCOUNT_DELETE_PHRASE = "DELETE MY ACCOUNT";
const LOCAL_OPERATOR_DELETE_PHRASE = "DELETE LOCAL OPERATOR ACCOUNT";

interface DeletionBlockers {
  runningStrategyRuns: number;
  placingProposals: number;
  pendingReconciliationFills: number;
  activeMobileCommands: number;
  activeReplacements: number;
}

interface DeletionPreview {
  userId: string;
  email?: string;
  isLocalOperatorAccount: boolean;
  prepared: boolean;
  requestedAt?: string;
  connectedAccounts: Array<{ id: string; label: string; broker: string; environment: string; isActive: boolean }>;
  blockers: DeletionBlockers;
  counts: Record<string, number>;
}

const ACK_ITEMS: Array<{ key: string; label: string }> = [
  { key: "deleteAppData", label: "Delete my app data for this signed-in user." },
  { key: "deleteBrokerConnections", label: "Delete stored broker/API connections from this app." },
  { key: "understandBrokerPositionsRemain", label: "I understand broker positions and open broker orders are NOT closed or cancelled — they remain at the broker." },
  { key: "understandProviderRevocation", label: "I understand I may need to revoke Google, GitHub, Apple, or broker access in those providers' settings too." },
  { key: "understandCanSignInAgain", label: "I understand signing in again later can create a fresh, empty app account." }
];

function blockerCount(b: DeletionBlockers): number {
  return b.runningStrategyRuns + b.placingProposals + b.pendingReconciliationFills + b.activeMobileCommands + b.activeReplacements;
}

function recordTotal(preview: DeletionPreview): number {
  return Object.values(preview.counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

async function fetchPreview(method: "GET" | "POST"): Promise<DeletionPreview> {
  const res = await fetch("/api/account/deletion", { method, cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return (await res.json()) as DeletionPreview;
}

export function AccountDeletionCard() {
  const toast = useToast();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [typedEmail, setTypedEmail] = useState("");
  const [typedPhrase, setTypedPhrase] = useState("");
  const [localOperatorPhrase, setLocalOperatorPhrase] = useState("");
  const [deleting, setDeleting] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      setPreview(await fetchPreview("GET"));
    } catch (error) {
      toast.push("neg", "Could not load the deletion preview", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    setBusy(true);
    try {
      const next = await fetchPreview("POST");
      setPreview(next);
      toast.push("warn", "Deletion prepared", "This login's strategy is now stopped and its run lock cleared.  Nothing has been deleted yet.");
    } catch (error) {
      toast.push("neg", "Could not prepare deletion", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const cancelFlow = () => {
    setPreview(null);
    setAcks({});
    setTypedEmail("");
    setTypedPhrase("");
    setLocalOperatorPhrase("");
  };

  const confirmDelete = async () => {
    if (!preview) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/account/deletion", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typedEmail: typedEmail.trim(),
          typedPhrase: typedPhrase.trim(),
          ...(preview.isLocalOperatorAccount
            ? { localOperatorPhrase: localOperatorPhrase.trim(), confirmLocalOperator: acks.confirmLocalOperator === true }
            : {}),
          deleteAppData: acks.deleteAppData === true,
          deleteBrokerConnections: acks.deleteBrokerConnections === true,
          understandBrokerPositionsRemain: acks.understandBrokerPositionsRemain === true,
          understandProviderRevocation: acks.understandProviderRevocation === true,
          understandCanSignInAgain: acks.understandCanSignInAgain === true
        })
      });
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; logoutUrl?: string } | null;
      if (!res.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `Deletion failed (${res.status}).`);
      }
      // The account is gone — end the session rather than keep polling as a deleted user.
      window.location.href = payload.logoutUrl || "/logout";
    } catch (error) {
      toast.push("neg", "Account was not deleted", error instanceof Error ? error.message : undefined);
      setDeleting(false);
    }
  };

  const ackItems = preview?.isLocalOperatorAccount
    ? [...ACK_ITEMS, { key: "confirmLocalOperator", label: "I understand this deletes the local operator dataset shared by the primary email aliases." }]
    : ACK_ITEMS;
  const allAcked = preview !== null && ackItems.every((item) => acks[item.key] === true);
  const emailMatches = preview?.email ? typedEmail.trim().toLowerCase() === preview.email.toLowerCase() : false;
  const phraseMatches = typedPhrase.trim() === ACCOUNT_DELETE_PHRASE;
  const operatorPhraseMatches = !preview?.isLocalOperatorAccount || localOperatorPhrase.trim() === LOCAL_OPERATOR_DELETE_PHRASE;
  const blocked = preview !== null && blockerCount(preview.blockers) > 0;
  const canDelete = preview !== null && preview.prepared && allAcked && emailMatches && phraseMatches && operatorPhraseMatches && !blocked && !deleting;

  return (
    <Card
      title={
        <span className="flex items-center gap-2 text-[color:var(--con-neg)]">
          <OctagonAlert size={15} /> Delete account &amp; data
        </span>
      }
    >
      <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
        Permanently deletes this login&apos;s data from <strong>this app</strong>: stored API keys, broker connections
        and OAuth tokens, settings, strategy profiles, watchlists, alerts, chat history, memories, proposals, fills,
        snapshots, notifications, and private learned context.  It does <strong>not</strong> close broker positions,
        cancel broker orders, or delete your Google/GitHub/Apple account — those live outside this app.
      </p>

      {preview === null ? (
        <div className="mt-3">
          <Btn
            variant="dangerOutline"
            size="sm"
            disabled={busy}
            onClick={() => void start()}
            title="Opens the deletion flow.  Nothing is deleted until the final typed confirmation."
          >
            <Trash2 size={13} /> {busy ? "Loading…" : "Start deletion…"}
          </Btn>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {/* Scope preview */}
          <div className="rounded-control border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-xs)] leading-relaxed">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-[color:var(--con-fg)]">In scope for {preview.email ?? preview.userId}:</span>
              <span className="con-num text-[color:var(--con-muted)]" title="Sum of the per-table row counts the server reported for this user.">
                {preview.connectedAccounts.length} broker connection{preview.connectedAccounts.length === 1 ? "" : "s"} · about {recordTotal(preview)} private app row{recordTotal(preview) === 1 ? "" : "s"}
              </span>
              {preview.prepared ? (
                <Chip tone="warn" title="Preparing stopped this login's strategy and cleared its run lock.  Nothing is deleted yet.">
                  prepared — strategy stopped
                </Chip>
              ) : (
                <Chip tone="muted">not prepared yet</Chip>
              )}
            </div>
            {preview.isLocalOperatorAccount && (
              <p className="mt-2 text-[color:var(--con-warn)]">
                This is the local operator dataset shared by the primary email aliases — it includes legacy app data
                and needs one extra typed phrase.
              </p>
            )}
            {(preview.counts.learned_context_pending ?? 0) > 0 && (
              <p className="mt-2 text-[color:var(--con-warn)]">
                {preview.counts.learned_context_pending} pending learned-context item
                {preview.counts.learned_context_pending === 1 ? "" : "s"} awaiting your approval will be discarded —
                review them on the{" "}
                <Link href="/console/approvals" className="text-[color:var(--con-accent)] hover:underline">
                  Approvals
                </Link>{" "}
                screen before deleting.
              </p>
            )}
          </div>

          {blocked && (
            <p className="rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] px-3 py-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-warn)]">
              Deletion is blocked until trading activity settles: {preview.blockers.runningStrategyRuns} running
              strategy run(s), {preview.blockers.placingProposals} placing proposal(s),{" "}
              {preview.blockers.pendingReconciliationFills} fill(s) pending broker reconciliation,{" "}
              {preview.blockers.activeMobileCommands} in-flight mobile command(s), and{" "}
              {preview.blockers.activeReplacements} active order replacement(s). Preparing (below)
              stops the strategy; in-flight work must drain on its own.
            </p>
          )}

          {!preview.prepared ? (
            <div className="flex flex-wrap items-center gap-2">
              <Btn
                variant="dangerOutline"
                size="sm"
                disabled={busy}
                onClick={() => void prepare()}
                title="Stops this login's strategy and records the deletion request. Deletes nothing yet — the typed confirmation comes after."
              >
                {busy ? "Preparing…" : "Prepare deletion — stops the strategy"}
              </Btn>
              <Btn variant="ghost" size="sm" onClick={cancelFlow} title="Close the flow.  Nothing was deleted.">
                Cancel
              </Btn>
            </div>
          ) : (
            <>
              {/* Acknowledgements — mirror the server's required booleans exactly. */}
              <div className="flex flex-col gap-1">
                {ackItems.map((item) => (
                  <label
                    key={item.key}
                    className="con-row flex cursor-pointer items-start gap-2 rounded-control px-1.5 py-1 text-[length:var(--con-fs-xs)] leading-relaxed"
                    title="The server refuses deletion unless every acknowledgement is explicitly checked."
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={acks[item.key] === true}
                      onChange={(e) => setAcks((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>

              {/* Typed ritual — destructive, so it gets the red frame. */}
              <div className="rounded-control border border-[color:var(--con-live-border)] bg-[color:var(--con-live-soft)] p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Type your signed-in email"
                    hint={preview.email ? undefined : "No verified sign-in email — the server refuses deletion without one."}
                    htmlFor="del-email"
                  >
                    <TextInput
                      id="del-email"
                      value={typedEmail}
                      onChange={(e) => setTypedEmail(e.target.value)}
                      placeholder={preview.email ?? "email@example.com"}
                      autoComplete="off"
                      spellCheck={false}
                      title="Must match the email you are signed in with."
                    />
                  </Field>
                  <Field label={`Type exactly: ${ACCOUNT_DELETE_PHRASE}`} htmlFor="del-phrase">
                    <TextInput
                      id="del-phrase"
                      value={typedPhrase}
                      onChange={(e) => setTypedPhrase(e.target.value)}
                      onPaste={(e) => e.preventDefault()}
                      placeholder={ACCOUNT_DELETE_PHRASE}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      className="con-mono"
                      title="The typed phrase is the friction — it cannot be pasted."
                    />
                  </Field>
                  {preview.isLocalOperatorAccount && (
                    <div className="sm:col-span-2">
                      <Field label={`Type exactly: ${LOCAL_OPERATOR_DELETE_PHRASE}`} htmlFor="del-operator-phrase">
                        <TextInput
                          id="del-operator-phrase"
                          value={localOperatorPhrase}
                          onChange={(e) => setLocalOperatorPhrase(e.target.value)}
                          onPaste={(e) => e.preventDefault()}
                          placeholder={LOCAL_OPERATOR_DELETE_PHRASE}
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                          className="con-mono"
                          title="Extra phrase required because this is the shared local operator dataset."
                        />
                      </Field>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Btn
                    variant="danger"
                    disabled={!canDelete}
                    onClick={() => void confirmDelete()}
                    title="Irreversible.  Deletes this login's app data and signs you out."
                  >
                    <Trash2 size={13} /> {deleting ? "Deleting…" : "Permanently delete account"}
                  </Btn>
                  <Btn variant="ghost" size="sm" disabled={deleting} onClick={cancelFlow} title="Close the flow.  The prepared request stays recorded; the strategy stays stopped until you start it again.">
                    Cancel
                  </Btn>
                </div>
                <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  On success you are signed out.  Cancelling here does not restart the strategy — start it again from the
                  run-state chip if you keep the account.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
