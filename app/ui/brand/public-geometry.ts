/**
 * Geometry constants for the PUBLIC site chrome (the /welcome landing page, the
 * /framework explainer, and the legal pages).
 *
 * WHY THIS EXISTS: the owner asked for the animated wordmark to sit in the SAME
 * place on every public page, and for the public loading animation to fly its
 * candles into that exact spot. The animation's landing box is computed in
 * JavaScript, while the header's box is laid out by CSS — so the two have to
 * agree, or the candles land next to the wordmark instead of on it.
 *
 * The rule: the public header is a fixed 32px-tall content row inside a 16px
 * vertical pad, in a centered container of PUBLIC_SHELL_MAX_W with
 * PUBLIC_SHELL_PAD_X of horizontal padding. The brand wordmark is
 * PUBLIC_BRAND_MAX_H tall and is vertically centred in that row, so its top edge
 * is always PUBLIC_HEADER_PAD_Y + (PUBLIC_ROW_H - PUBLIC_BRAND_MAX_H) / 2.
 *
 * The brand's own width is responsive: it is `min(available, PUBLIC_BRAND_MAX_W)`
 * wide, because the wordmark's aspect ratio (WORDMARK_AR) is very wide and a
 * narrow phone would otherwise overflow. The animation measures the real element
 * every frame, so a responsive width is fine — this file only has to agree with
 * the CSS for the FIRST frame.
 */

import { WORDMARK_AR } from "./candle-ticker";

/** The public container width. Matches Tailwind's max-w-5xl (64rem). */
export const PUBLIC_SHELL_MAX_W = 1024;
/** The narrower content column the legal pages use for readable prose.
 *  Matches Tailwind's max-w-3xl (48rem). */
export const PUBLIC_CONTENT_NARROW_W = 768;
/** The public container's horizontal padding. Matches Tailwind's px-6 (1.5rem). */
export const PUBLIC_SHELL_PAD_X = 24;
/** The public header's vertical padding. Matches Tailwind's py-4 (1rem). */
export const PUBLIC_HEADER_PAD_Y = 16;
/** The public header's content row height. Matches the h-8 header action. */
export const PUBLIC_ROW_H = 32;
/** The brand wordmark's height on a wide viewport. */
export const PUBLIC_BRAND_MAX_H = 22;
/** The brand wordmark's width at PUBLIC_BRAND_MAX_H (the wordmark's aspect ratio
 *  is fixed, so width follows from height). */
export const PUBLIC_BRAND_MAX_W = PUBLIC_BRAND_MAX_H * WORDMARK_AR;

/** The brand wordmark's left edge, in viewport px, at a given viewport width. */
export function publicBrandLeft(viewportWidth: number): number {
  return Math.max(0, (viewportWidth - PUBLIC_SHELL_MAX_W) / 2) + PUBLIC_SHELL_PAD_X;
}

/** The brand wordmark's top edge, in viewport px. Constant: the public header's
 *  row is a fixed height on every public page, so the wordmark never moves. */
export function publicBrandTop(): number {
  return PUBLIC_HEADER_PAD_Y + (PUBLIC_ROW_H - PUBLIC_BRAND_MAX_H) / 2;
}
