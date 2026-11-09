"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // No-op when Sentry was not initialized (NEXT_PUBLIC_SENTRY_DSN unset).
    Sentry.captureException(error);
    void import("@/lib/datadog-rum").then(({ captureRumError }) => captureRumError(error));
  }, [error]);

  const message = error.message?.trim() || "The workspace failed to render.";
  return (
    <html lang="en">
      <body>
        {/* Dependency-free inline dark-mode override: this file replaces <html>/<body> at the
            root, so the app's CSS-variable theme system isn't available here. Dark is the app
            default (src/.../theme.tsx) - without this, a dark-mode user hitting a root crash
            gets a jarring white flash. Hex values hand-picked to match app/globals.css's .dark
            block (--bg, --fg, --muted, --accent, --accent-fg, --line). */}
        <style>{`
          @media (prefers-color-scheme: dark) {
            .global-error-main { background: #0a0a0a !important; color: #f0f0f0 !important; }
            .global-error-message { color: #b0b0b0 !important; }
            .global-error-digest { color: #969696 !important; }
            .global-error-button {
              border-color: #58c7d3 !important;
              background: #58c7d3 !important;
              color: #04130d !important;
            }
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
