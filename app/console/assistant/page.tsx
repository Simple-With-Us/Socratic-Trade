import type { Metadata } from "next";
import { AssistantChat } from "./chat";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";

export const metadata: Metadata = {
  description: "Coach Socratic Trade's market thesis, decision logic, remembered evidence, and framework improvements."
};

export default function AssistantPage() {
  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-3`}>
      <div>
        {/* Literal, not destinationLabel(): this page is a SERVER component (metadata
            export) and nav.tsx is "use client" — calling its function here would throw.
            Keep in lockstep with DESTINATIONS ("/console/assistant") in components/nav.tsx. */}
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Coach</h1>
        <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Challenge the current thesis, refocus the next run, preserve lessons, or draft a trade for Approvals.
        </p>
      </div>
      <AssistantChat />
    </div>
  );
}
