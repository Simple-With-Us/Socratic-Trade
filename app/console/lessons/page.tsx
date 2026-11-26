"use client";

import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useConsoleSnapshotOptional } from "../lib/useConsoleData";
import { LearnedContextInbox, LearnedFactsArchive } from "./learned-context";
import { LearningLedgerPanel } from "./learning-ledger";

export default function LessonsPage() {
  // The ledger is an operator diagnostic backed by /api/admin/learning-ledger (requireAdmin).
  // Mounting it for everyone fired a guaranteed 403 on each non-admin Lessons load, so gate it
  // on the same isAdmin flag the shell's Admin link uses — no panel, no toast, no admin request.
  const isAdmin = useConsoleSnapshotOptional()?.currentUser?.isAdmin === true;
  return (
    <div className={`${CONSOLE_PAGE_WIDTH} space-y-8 px-4 pb-12 pt-6 lg:px-8`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Lessons</h1>
      </div>

      <div className="flex flex-col gap-8">
        <LearnedContextInbox />
        <LearnedFactsArchive />
        {isAdmin && (
          <div id="learning-ledger" className="scroll-mt-28">
            <LearningLedgerPanel />
          </div>
        )}
      </div>
    </div>
  );
}
