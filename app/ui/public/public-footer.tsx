"use client";

/**
 * The shared public-site footer. One implementation for every public page, so
 * the legal links, the contact address, and the Simple With Us attribution are
 * identical everywhere and the page never loses its bottom rail.
 *
 * The container geometry matches the header's (see ../brand/public-geometry.ts)
 * so the whole public chrome lines up on one vertical grid.
 */

import type { ReactNode } from "react";
import { PUBLIC_SHELL_MAX_W, PUBLIC_SHELL_PAD_X } from "../brand/public-geometry";

const LINK_CLASS = "underline underline-offset-2 hover:text-muted";

export function PublicFooter({ extra }: { extra?: ReactNode }) {
  return (
    <footer className="mt-8 border-t border-line">
      <div
        className="mx-auto flex w-full flex-col items-center gap-2 py-8 text-center sm:flex-row sm:justify-between"
        style={{
          maxWidth: PUBLIC_SHELL_MAX_W,
          paddingLeft: PUBLIC_SHELL_PAD_X,
          paddingRight: PUBLIC_SHELL_PAD_X
        }}
      >
        <p className="text-xs text-faint">
          Not investment advice.&nbsp; You set authority.&nbsp;{" "}
          <a href="/terms-and-conditions" className={LINK_CLASS}>
            Terms
          </a>
          {" · "}
          <a href="/privacy-policy" className={LINK_CLASS}>
            Privacy
          </a>
          {extra ? (
            <>
              {" · "}
              {extra}
            </>
          ) : null}
        </p>
        <p className="text-xs text-faint">
          &copy; 2026 Socratic Trade &middot;{" "}
          <a href="mailto:mail@jays.services" className={LINK_CLASS}>
            mail@jays.services
          </a>
          {" · "}
          <a
            href="https://simplewithus.com/"
            aria-label="From Simple With Us"
            className="inline-flex items-center gap-1.5 align-middle hover:text-muted focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <span>From</span>
            <img
              src="/swu-wordmark-light.webp"
              alt="Simple With Us by Jay Wedgeworth"
              width={288}
              height={30}
              className="block h-auto w-72 max-w-[calc(100vw-92px)] dark:hidden"
            />
            <img
              src="/swu-wordmark-dark.webp"
              alt="Simple With Us by Jay Wedgeworth"
              width={288}
              height={30}
              className="hidden h-auto w-72 max-w-[calc(100vw-92px)] dark:block"
            />
          </a>
        </p>
      </div>
    </footer>
  );
}
