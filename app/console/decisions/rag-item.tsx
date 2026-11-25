"use client";

import type { SocraticRagAttribution } from "@/lib/types";
import { plainLabel } from "../lib/labels";

export function RagItem({ item }: { item: SocraticRagAttribution }) {
  const meta = [plainLabel(item.docType), item.source, typeof item.score === "number" ? `score ${item.score.toFixed(2)}` : item.symbol]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="con-evidence-card con-evidence-accent">
      <div className="flex items-start justify-between gap-3">
        <strong>{item.title || item.chunkId || "Retrieved evidence"}</strong>
        <span>{meta}</span>
      </div>
      <p>{item.contribution || item.text}</p>
      {item.text && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]">
            Raw Chunk
          </summary>
          <div className="mt-1.5 whitespace-pre-wrap text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            {item.text}
            {item.chunkId && (
              <div className="con-mono mt-1.5 text-[color:var(--con-faint)]">Chunk {item.chunkId}</div>
            )}
          </div>
        </details>
      )}
      {item.url && /^https?:\/\//i.test(item.url) && (
        <a className="mt-2 inline-flex text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-accent)]" href={item.url} target="_blank" rel="noreferrer">
          Source
        </a>
      )}
    </article>
  );
}
