"use client";

/** Combined first-use gate: versioned legal clickwrap + mandatory data-pool.
 *  Accepting both dismisses the notice until either version bumps.  There is
 *  no Decline — unset users must not silently share, and the app is unusable
 *  until they accept.  Personal account data is never pooled. */

import { useEffect, useId, useRef, useState } from "react";
import { Scale } from "lucide-react";
import { Btn } from "../ui/primitives";
import { useFocusTrap } from "../ui/focus-trap";
import { useOverlay } from "../ui/use-overlay";
import { BACKUP_RETENTION_SENTENCE, LEGAL_NOTICE_SENTENCE } from "@/lib/legal-notice";

type GateState = "loading" | "needed" | "done";

interface ConsentPayload {
  needsConsent?: boolean;
}

export function ConsentGate() {
  const [state, setState] = useState<GateState>("loading");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayId = useId();

  useFocusTrap(dialogRef, state === "needed", { blocking: true });
  useOverlay(overlayId, state === "needed", () => {}, { history: false });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/legal-notice", { cache: "no-store" }),
      fetch("/api/consent", { cache: "no-store" })
    ])
      .then(async ([legalRes, poolRes]) => {
        if (cancelled) return;
        if (!legalRes.ok || !poolRes.ok) {
          setState("needed");
          return;
        }
        const legal = (await legalRes.json()) as ConsentPayload;
        const pool = (await poolRes.json()) as ConsentPayload;
        setState(legal.needsConsent === true || pool.needsConsent === true ? "needed" : "done");
      })
      .catch(() => {
        if (!cancelled) setState("needed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const accept = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const [legalRes, poolRes] = await Promise.all([
        fetch("/api/legal-notice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accepted: true })
        }),
        fetch("/api/consent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accepted: true })
        })
      ]);
      if (!legalRes.ok || !poolRes.ok) throw new Error("Consent could not be saved.");
      setState("done");
    } catch {
      setError("Your acceptance could not be saved.  The console stays locked until this is resolved — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (state !== "needed") return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="con-consent-title"
      aria-describedby="con-consent-body"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
    >
      <div className="absolute inset-0" style={{ background: "var(--con-scrim)" }} aria-hidden />
      <div className="con-card relative z-10 flex w-full max-w-lg max-h-[min(90dvh,calc(var(--con-vv-height,100dvh)-2rem))] flex-col gap-4 overflow-y-auto overscroll-contain p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]">
            <Scale size={20} />
          </span>
          <div>
            <h2 id="con-consent-title" className="text-[length:var(--con-fs-md)] font-semibold">
              Terms, Privacy, and Shared Data
            </h2>
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {LEGAL_NOTICE_SENTENCE}
            </p>
          </div>
        </div>

        <div id="con-consent-body" className="space-y-3 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
          <p>
            Socratic Trade is software you configure, not investment advice.  Using the app requires
            accepting the{" "}
            <a href="/terms-and-conditions" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Terms
            </a>{" "}
            and{" "}
            <a href="/privacy-policy" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Privacy Policy
            </a>
            , and contributing general market data — quotes, fundamentals, history, and news — to a
            shared pool.  Personal account data (positions, orders, balances, P&amp;L, credentials)
            stays private.
          </p>
          <p>
            You can delete your account yourself in Settings.  {BACKUP_RETENTION_SENTENCE}  Fact-level research notes may join a shared research
            corpus; risk rules and strategy instructions stay private.
          </p>
        </div>

        {error && <p className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">{error}</p>}

        <div className="flex justify-end">
          <Btn
            variant="primary"
            disabled={submitting}
            onClick={() => void accept()}
            title="Accept the current terms, privacy notice, and required market-data share."
          >
            {submitting ? "Saving…" : "Accept & Continue"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
