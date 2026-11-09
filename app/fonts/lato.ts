import localFont from "next/font/local";

/** Lato — the product typeface, shared with the native iOS app (which bundles the
 *  matching TTFs in ios/SocraticTrade/Fonts/). SIL Open Font License 1.1; the full
 *  licence text ships alongside the files in ./LATO-OFL.txt.
 *
 *  Self-hosted on purpose, NOT `next/font/google`. Merging to `main` auto-deploys, and
 *  next/font/google fetches the face at BUILD time — an unreachable fonts.gstatic.com
 *  would then fail the container build and freeze production over a typeface. These
 *  woff2 files are the exact ones Google serves (latin + latin-ext subsets of the same
 *  release), committed once so the build has no network dependency at all.
 *
 *  Weights: 400 (+ italic) for body, 700 for emphasis/headings, 900 for the wordmark and
 *  display numerals. `display: "swap"` so a slow font never blocks first paint — the
 *  console's load screen must stay visible, which is the whole point of the intro. */
export const lato = localFont({
  src: [
    { path: "./lato-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./lato-400-latin-ext.woff2", weight: "400", style: "normal" },
    { path: "./lato-400-italic-latin.woff2", weight: "400", style: "italic" },
    { path: "./lato-400-italic-latin-ext.woff2", weight: "400", style: "italic" },
    { path: "./lato-700-latin.woff2", weight: "700", style: "normal" },
    { path: "./lato-700-latin-ext.woff2", weight: "700", style: "normal" },
    { path: "./lato-900-latin.woff2", weight: "900", style: "normal" },
    { path: "./lato-900-latin-ext.woff2", weight: "900", style: "normal" }
  ],
  display: "swap",
  // Consumed by --font-lato in globals.css / --con-font-lato in console.css, which is what
  // every other font token resolves through. Nothing should hardcode the literal family name.
  variable: "--font-lato",
  // Lato's metrics are close to Helvetica/Arial, so the pre-swap system fallback is nearly the
  // same size — this keeps the swap from reflowing the page.
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: "Arial"
});
