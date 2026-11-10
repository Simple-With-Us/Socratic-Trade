"use client";

/** "Needs attention" inbox block: pending approvals, halted/close-only
 *  notices, breaker events, reconciliation orphans, readiness problems.
 *  Every automatic transition is narrated in plain words with a next step. */

import Link from "next/link";
import { AlertTriangle, ArrowRight, BellRing, Inbox } from "lucide-react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveAttention, type AttentionItem } from "../lib/derive";
import { Card } from "../ui/primitives";

const TONE_STYLE: Record<AttentionItem["tone"], { border: string; color: string }> = {
  neg: { border: "var(--con-neg-border)", color: "var(--con-neg)" },
  warn: { border: "var(--con-warn-border)", color: "var(--con-warn)" },
  accent: { border: "var(--con-accent-border)", color: "var(--con-accent)" }
};

function ItemIcon({ tone }: { tone: AttentionItem["tone"] }) {
  const props = { size: 15, style: { color: TONE_STYLE[tone].color }, className: "mt-0.5 shrink-0" };
  if (tone === "accent") return <Inbox {...props} />;
  if (tone === "neg") return <AlertTriangle {...props} />;
  return <BellRing {...props} />;
}

export function NeedsAttention({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = deriveAttention(snapshot);
  return (
    <Card title={`Needs attention${items.length > 0 ? ` (${items.length})` : ""}`}>
      {items.length === 0 ? (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Nothing needs you right now.  Quiet is a legitimate state — the strategy reports deliberate inaction too.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => {
            const body = (
              <div
                className="flex items-start gap-2.5 rounded-control border p-3 transition-colors"
                style={{ borderColor: TONE_STYLE[item.tone].border }}
              >
                <ItemIcon tone={item.tone} />
                <div className="min-w-0 flex-1">
                  <div className="text-[length:var(--con-fs-sm)] font-semibold">{item.title}</div>
                  <p className="mt-0.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                    {item.detail}
                  </p>
                </div>
                {item.href && <ArrowRight size={14} className="mt-1 shrink-0 text-[color:var(--con-faint)]" />}
              </div>
            );
            return item.href ? (
              <Link key={item.id} href={item.href} className="block hover:opacity-90">
                {body}
              </Link>
            ) : (
              <div key={item.id}>{body}</div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
