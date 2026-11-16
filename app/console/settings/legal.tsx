"use client";

/** Settings → Legal.  Shows the accepted clickwrap version, the desk sentence,
 *  and links.  The first-use gate is what records acceptance; this card does
 *  not re-prompt once the current version is stored. */

import { useEffect, useState } from "react";
import { Card } from "../ui/primitives";
import { fmtExact } from "../lib/format";
import { LEGAL_NOTICE_SENTENCE, LEGAL_PRIVACY_PATH, LEGAL_TERMS_PATH } from "@/lib/legal-notice";

interface LegalState {
  accepted: boolean;
  acceptedAt: string | null;
  version: number;
  currentVersion?: number;
  needsConsent?: boolean;
}

export function LegalCard() {
  const [legal, setLegal] = useState<LegalState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/legal-notice", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<LegalState>) : Promise.reject(new Error("failed"))))
      .then((data) => {
        if (!cancelled) setLegal(data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const acceptedLabel =
    legal?.accepted && legal.acceptedAt
      ? `Accepted on ${fmtExact(legal.acceptedAt)}.`
      : "Not yet accepted.  You will be asked once the next time you open the app.";

  return (
    <Card title="Legal">
      <p className="mb-2 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]">
        {LEGAL_NOTICE_SENTENCE}
      </p>
      <p className="mb-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
        {acceptedLabel}
      </p>
      {loadFailed && (
        <p className="mb-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">
          Legal acceptance could not be loaded.  Reload to retry.
        </p>
      )}
      <p className="text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
        <a href={LEGAL_TERMS_PATH} className="underline underline-offset-2">
          Terms
        </a>
        {" · "}
        <a href={LEGAL_PRIVACY_PATH} className="underline underline-offset-2">
          Privacy
        </a>
        .  You can delete your account under Danger below.  Each signed-in account stays private
        to that person.
      </p>
    </Card>
  );
}
