"use client";

/**
 * The animated "SOCRATIC TRADE" candlestick wordmark for the public site.
 *
 * Same letter sampling and the same 12-unit green-biased ticker as the console's
 * persistent top-bar logo (app/console/ui/header-logo.tsx), so the public pages
 * and the app can never render two different wordmarks.
 *
 * SIZING IS CSS-DRIVEN ON PURPOSE: the element's box is `width: 100%` of its
 * flex slot, capped at the wordmark's natural maximum width, with the shared
 * aspect ratio applied. The first paint is therefore already the right size —
 * the loading animation measures this element to find its landing target, and a
 * canvas that resized on mount would make the candles land BESIDE the wordmark
 * instead of on it. The JavaScript here only keeps the raster backing store in
 * step with the CSS box and draws the ticker.
 *
 * Static frame for prefers-reduced-motion.
 */

import { useEffect, useRef } from "react";
import {
  sampleWordmark,
  buildTickerUnits,
  drawTicker,
  WORDMARK_AR,
  type Wordmark,
  type TickerUnit
} from "../brand/candle-ticker";
import { PUBLIC_BRAND_MAX_W } from "../brand/public-geometry";

let CACHED: { wm: Wordmark; units: TickerUnit[] } | null = null;
function model() {
  if (!CACHED) CACHED = { wm: sampleWordmark("SOCRATIC TRADE"), units: buildTickerUnits() };
  return CACHED;
}

export function PublicBrand({ className = "" }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { wm, units } = model();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let raf = 0;
    let start: number | null = null;
    let lastTick = -1;
    let W = 0;
    let H = 0;

    const render = (tick: number) => {
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);
      drawTicker(ctx, wm, units, { x: 0, y: 0, w: W, h: H }, tick);
    };

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w === W && h === H) return;
      W = w;
      H = h;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (lastTick >= 0) render(lastTick);
    };

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      render(0);
      return () => ro.disconnect();
    }

    const loop = (now: number) => {
      // RAF is specified to pass a DOMHighResTimeStamp, but extension- and
      // polyfill-injected shims call the callback with no argument. `undefined`
      // then flows into the tick arithmetic and indexes the unit array with
      // NaN — an unhandled TypeError on every frame. Fall back to the clock.
      const ts = Number.isFinite(now) ? now : performance.now();
      if (start == null) start = ts;
      const tick = Math.floor((ts - start) / 1000);
      if (tick !== lastTick) {
        lastTick = tick;
        render(tick);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      data-brand-logo
      role="img"
      aria-label="Socratic Trade"
      className={`block h-auto w-full ${className}`}
      style={{ maxWidth: `${PUBLIC_BRAND_MAX_W}px`, aspectRatio: WORDMARK_AR }}
    />
  );
}
