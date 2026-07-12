"use client";

/** Company/ticker logo for the console, ported from app/ui/ticker-logo.tsx but
 *  themed with console tokens. Loads /api/logos/ticker?symbol=X&theme=… and
 *  falls back to a monogram tile (never a bare gap). Theme resolution follows
 *  the console model: data-theme on the closest .console-root ancestor, else
 *  prefers-color-scheme — NOT the legacy `.dark` class on <html>. */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { normalizeTickerLogoSymbol } from "@/lib/ticker-logos";
import { cx } from "../lib/format";

export type { TickerLogoDisplay };

/** Resolved light/dark for the console subtree containing `ref`. Reacts to both
 *  the explicit data-theme attribute (chrome toggle) and system changes. */
export function useConsoleResolvedTheme(ref: RefObject<HTMLElement | null>): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">("dark"); // SSR default: dark

  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>(".console-root") ?? null;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const explicit = root?.getAttribute("data-theme");
      setTheme(explicit === "light" || explicit === "dark" ? explicit : mq.matches ? "dark" : "light");
    };
    update();
    const observer = root ? new MutationObserver(update) : null;
    if (root) observer!.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    mq.addEventListener("change", update);
    return () => {
      observer?.disconnect();
      mq.removeEventListener("change", update);
    };
  }, [ref]);

  return theme;
}

export type TickerLogoSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<TickerLogoSize, string> = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
  lg: "h-12 w-12"
};

const MONOGRAM_FONT_CLASS: Record<TickerLogoSize, string> = {
  sm: "text-[9px]",
  md: "text-[11px]",
  lg: "text-base"
};

/** First 1–2 letters of the base symbol (before any class-share separator),
 *  e.g. "BRK.B" → "BR", "F" → "F". */
function monogram(symbol: string): string {
  const base = symbol.split(/[.\-_]/)[0] || symbol;
  return base.slice(0, 2);
}

export function TickerLogo({
  symbol,
  display = "tile",
  size = "sm",
  className,
  title,
  fallback
}: {
  symbol: string;
  /** "tile" (default): logo on a neutral tile so dark/transparent marks stay
   *  visible in light mode too; "transparent": bare logo; "off": render the
   *  fallback (or nothing). */
  display?: TickerLogoDisplay;
  size?: TickerLogoSize;
  className?: string;
  title?: string;
  fallback?: ReactNode;
}) {
  const normalized = useMemo(() => normalizeTickerLogoSymbol(symbol), [symbol]);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const theme = useConsoleResolvedTheme(ref);

  useEffect(() => {
    setFailed(false);
  }, [normalized]);

  if (!normalized || display === "off") {
    return fallback ? <>{fallback}</> : null;
  }

  // Image failed (no logo match, or a network error): honor an explicit
  // fallback, otherwise a monogram tile so the slot is never a bare gap.
  if (failed) {
    if (fallback) return <>{fallback}</>;
    return (
      <span
        ref={ref}
        className={cx(
          "con-logo-tile inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold uppercase leading-none",
          SIZE_CLASS[size],
          MONOGRAM_FONT_CLASS[size],
          className
        )}
        title={title}
        aria-hidden="true"
      >
        {monogram(normalized)}
      </span>
    );
  }

  return (
    <span
      ref={ref}
      className={cx(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        SIZE_CLASS[size],
        display === "tile" ? "con-logo-tile p-0.5" : "rounded-sm",
        className
      )}
      title={title}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/logos/ticker?symbol=${encodeURIComponent(normalized)}&theme=${theme}`}
        alt=""
        className="h-full w-full object-contain"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
