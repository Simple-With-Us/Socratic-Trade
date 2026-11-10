"use client";

/**
 * The shared public-site chrome: header, content column, footer, and the
 * one-shot loading splash.
 *
 * Every public page (/welcome, /framework, /terms-and-conditions,
 * /privacy-policy) renders through this shell, which is what makes the animated
 * wordmark land in the SAME place on every one of them — the header is a fixed
 * 32px row in a fixed-width centered container (see ../brand/public-geometry.ts
 * for the numbers the loading animation also uses).
 *
 * The splash is the same candlestick animation the operator console opens with
 * (../brand/intro-canvas.tsx), playing the "public" variant: the candles fly
 * out of the chart and assemble the top-left wordmark, which then keeps ticking.
 * The brand stays invisible until the candles have landed, via the shared
 * intro-bus phase.
 */

import { useEffect, useState, type ReactNode } from "react";
import { BrandIntro } from "../brand/intro-canvas";
import { getIntroPhase, subscribeIntroPhase, type IntroPhase } from "../brand/intro-bus";
import {
  PUBLIC_CONTENT_NARROW_W,
  PUBLIC_HEADER_PAD_Y,
  PUBLIC_ROW_H,
  PUBLIC_SHELL_MAX_W,
  PUBLIC_SHELL_PAD_X
} from "../brand/public-geometry";
import { PublicBrand } from "./public-brand";
import { PublicFooter } from "./public-footer";

/** The header's primary action. `h-8` matches the public header's fixed row
 *  height, so the wordmark's vertical position never changes with the action. */
export const PUBLIC_HEADER_ACTION_CLASS =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";

export function PublicShell({
  children,
  headerAction,
  footerExtra,
  contentWidth = "wide",
  showIntro = false
}: {
  children: ReactNode;
  headerAction?: ReactNode;
  /** Extra links rendered at the end of the footer's left column. */
  footerExtra?: ReactNode;
  /** The content column's width. "narrow" is for the legal pages, whose prose
   *  reads better in a 768px column. The HEADER is unaffected either way — the
   *  wordmark stays in the same place on every public page. */
  contentWidth?: "wide" | "narrow";
  /** Play the loading splash on this page. It is one-shot per browser tab
   *  session, so whichever public page a visitor lands on first plays it. */
  showIntro?: boolean;
}) {
  const [phase, setPhase] = useState<IntroPhase>("pending");

  useEffect(() => {
    // Seed from the CURRENT phase, not "pending": a visitor who already saw the
    // splash on /welcome and then opens /framework must not have the wordmark
    // hidden behind a phase that was settled before this shell mounted.
    setPhase(getIntroPhase());
    return subscribeIntroPhase(setPhase);
  }, []);

  // The splash owns the wordmark until its candles have assembled it.
  const brandPending = showIntro && (phase === "pending" || phase === "playing");

  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* The header's row height and vertical padding come from the shared geometry
          constants, NOT from a Tailwind class: the loading animation computes its
          landing box from those same constants, so the two must not be able to drift.
          The row is a FIXED height rather than a min-height — with a min-height the
          row would shrink to the wordmark's 22px on a page with no header action, and
          the wordmark would move 5px off the position the animation aims at. */}
      <header
        className="border-b border-line bg-surface/80 backdrop-blur-sm"
        style={{ paddingTop: PUBLIC_HEADER_PAD_Y, paddingBottom: PUBLIC_HEADER_PAD_Y }}
      >
        <div
          className="mx-auto flex w-full items-center justify-between gap-3"
          style={{
            maxWidth: PUBLIC_SHELL_MAX_W,
            height: PUBLIC_ROW_H,
            paddingLeft: PUBLIC_SHELL_PAD_X,
            paddingRight: PUBLIC_SHELL_PAD_X
          }}
        >
          <a
            href="/welcome"
            className="flex min-w-0 flex-1 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--ring)]"
            aria-label="Socratic Trade — home"
          >
            <PublicBrand
              className={brandPending ? "opacity-0" : "opacity-100 transition-opacity duration-300"}
            />
          </a>
          <div className="flex shrink-0 items-center gap-2">{headerAction}</div>
        </div>
      </header>

      <main
        className="mx-auto w-full py-14"
        style={{
          maxWidth: contentWidth === "narrow" ? PUBLIC_CONTENT_NARROW_W : PUBLIC_SHELL_MAX_W,
          paddingLeft: PUBLIC_SHELL_PAD_X,
          paddingRight: PUBLIC_SHELL_PAD_X
        }}
      >
        {children}
      </main>

      <PublicFooter extra={footerExtra} />

      {showIntro ? <BrandIntro variant="public" /> : null}
    </div>
  );
}
