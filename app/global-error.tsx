"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useLayoutEffect } from "react";
import { bindDocumentTheme } from "./ui/theme";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // No-op when Sentry was not initialized (NEXT_PUBLIC_SENTRY_DSN unset).
    Sentry.captureException(error);
    void import("@/lib/datadog-rum").then(({ captureRumError }) => captureRumError(error));
  }, [error]);

  useLayoutEffect(() => bindDocumentTheme(document, () => {}), []);

  const message = error.message?.trim() || "The workspace failed to render.";
  return (
    <html lang="en">
      <body>
        {/* This file replaces <html>, so the root boot script is gone. bindDocumentTheme
            rewrites .dark and data-theme from the same storage key before paint.
            Hex values match app/globals.css .dark (--bg, --fg, --muted, --accent). */}
        <style>{`
          html.dark .global-error-main,
          html[data-theme="dark"] .global-error-main { background: #0a0a0a !important; color: #f0f0f0 !important; }
          html.dark .global-error-message,
          html[data-theme="dark"] .global-error-message { color: #b0b0b0 !important; }
          html.dark .global-error-digest,
          html[data-theme="dark"] .global-error-digest { color: #969696 !important; }
          html.dark .global-error-button,
          html[data-theme="dark"] .global-error-button {
            border-color: #58c7d3 !important;
            background: #58c7d3 !important;
            color: #04130d !important;
          }
        `}</style>
        <main
          className="global-error-main"
          style={{
            minHeight: "100dvh",
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "#f8fafc",
            color: "#0a0a0a",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
          }}
        >
          <div style={{ maxWidth: 520, textAlign: "center" }}>
            <h1 style={{ fontSize: 24, lineHeight: 1.2, margin: "0 0 10px" }}>Dashboard error</h1>
            <p className="global-error-message" style={{ margin: "0 0 18px", color: "#475569" }}>
              {message}
            </p>
            {error.digest && (
              <p className="global-error-digest" style={{ margin: "0 0 18px", color: "#64748b", fontSize: 13 }}>
                Reference: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              className="global-error-button"
              style={{
                border: "1px solid #0a0a0a",
                background: "#0a0a0a",
                color: "#fff",
                borderRadius: 6,
                padding: "10px 14px",
                font: "inherit",
                cursor: "pointer"
              }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
