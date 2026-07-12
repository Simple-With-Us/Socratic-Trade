"use client";

// Custom model dropdown with provider logos + relative price tiers (vs the native <select>, which
// can't render images). Logos load from /public/model-logos/<provider>.svg; if a file is absent it
// falls back to a colored initial chip, so the picker looks intentional even before the SVGs are added.
// `providerStatus[provider] === false` (from /api/chat/providers) disables that provider's options.

import { useEffect, useRef, useState } from "react";
import { cn } from "./cn";

export type PickerProviderId = "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "offline";

export interface ModelOption {
  value: string;
  label: string;
  tier: "" | "$" | "$$" | "$$$";
  recommendedGreen?: boolean;
  recommendedRed?: boolean;
}
export interface ModelGroup {
  provider: PickerProviderId;
  label: string;
  options: ModelOption[];
}

const PROVIDER_META: Record<PickerProviderId, { initial: string; color: string }> = {
  openai: { initial: "O", color: "#10a37f" },
  anthropic: { initial: "C", color: "#d97757" },
  xai: { initial: "x", color: "#111827" },
  gemini: { initial: "G", color: "#1a73e8" },
  mistral: { initial: "M", color: "#fa520f" },
  deepseek: { initial: "D", color: "#4d6bfe" },
  offline: { initial: "•", color: "#6b7280" }
};

function ProviderLogo({ provider, size = 18 }: { provider: PickerProviderId; size?: number }) {
  const [failed, setFailed] = useState(false);
  const meta = PROVIDER_META[provider];
  if (provider === "offline" || failed) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
        style={{ width: size, height: size, background: meta.color }}
        aria-hidden
      >
        {meta.initial}
      </span>
    );
  }
  // White tile behind every logo so dark/transparent marks stay visible in any theme.
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded bg-white" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/model-logos/${provider}.svg`}
        alt=""
        width={size - 4}
        height={size - 4}
        className="object-contain"
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function TierBadge({ tier }: { tier: ModelOption["tier"] }) {
  if (!tier) return null;
  return <span className="ml-auto font-mono text-[11px] text-muted" title="Relative cost">{tier}</span>;
}

export function ModelPicker({
  value,
  onChange,
  groups,
  providerStatus = {},
  className
}: {
  value: string;
  onChange: (model: string) => void;
  groups: ModelGroup[];
  providerStatus?: Partial<Record<string, boolean>>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const all = groups.flatMap((g) => g.options.map((o) => ({ ...o, provider: g.provider })));
  const selected = all.find((o) => o.value === value) ?? all[0];

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            setTimeout(() => {
              const firstOpt = listRef.current?.querySelector('[role="option"]:not([disabled])') as HTMLButtonElement | null;
              firstOpt?.focus();
            }, 0);
          }
        }}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
        title="Chat model — pick any provider. Providers without a key are marked “no key” and disabled."
      >
        {selected && <ProviderLogo provider={selected.provider} size={16} />}
        <span className="truncate">{selected?.value ?? "Select model"}</span>
        {selected?.tier && <span className="font-mono text-[11px] text-muted">{selected.tier}</span>}
        <svg className="ml-auto h-3 w-3 shrink-0 text-muted" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Model options"
          className="absolute z-50 mt-1 max-h-80 w-[20rem] max-w-[80vw] overflow-y-auto rounded-lg border border-line bg-surface shadow-lg"
        >
          {groups.map((g) => {
            const missing = g.provider !== "offline" && providerStatus[g.provider] === false;
            return (
              <div key={g.provider} className="py-1">
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <ProviderLogo provider={g.provider} size={14} />
                  {g.label}
                  {missing && <span className="font-normal normal-case text-down">— no key</span>}
                </div>
                {g.options.map((o) => {
                  const active = o.value === value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={missing}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setOpen(false);
                          ref.current?.querySelector("button")?.focus();
                        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          const opts = Array.from(listRef.current?.querySelectorAll('[role="option"]:not([disabled])') ?? []) as HTMLElement[];
                          const idx = opts.indexOf(document.activeElement as HTMLElement);
                          if (idx !== -1) {
                            const nextIdx = (idx + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
                            opts[nextIdx]?.focus();
                          }
                        }
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs focus:outline-none focus:bg-surface-2",
                        missing ? "cursor-not-allowed text-faint" : "text-fg hover:bg-surface-2",
                        active && "bg-accent/10 focus:bg-accent/15"
                      )}
                    >
                      <ProviderLogo provider={g.provider} size={16} />
                      <span className="truncate">{o.label}</span>
                      <TierBadge tier={o.tier} />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
