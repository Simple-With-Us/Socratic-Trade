import type { Metadata } from "next";
import { AssistantChat } from "./chat";

export const metadata: Metadata = {
  title: "Coach",
  description: "Coach Socratic Trade's market thesis, decision logic, remembered evidence, and framework improvements."
};

export default function AssistantPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div>
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Coach Socratic Trade</h1>
        <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Challenge the current thesis, refocus the next run, preserve lessons, or draft a trade for Approvals.
        </p>
      </div>
      <AssistantChat />
    </div>
  );
}
