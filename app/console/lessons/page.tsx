import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { FrameworkProposalsPanel } from "./framework-proposals";
import { LearnedContextInbox, LearnedFactsArchive } from "./learned-context";
import { LearningLedgerPanel } from "./learning-ledger";

export default function LessonsPage() {
  return (
    <div className={`${CONSOLE_PAGE_WIDTH} space-y-8 px-4 pb-12 pt-6 lg:px-8`}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Lessons</h1>
      </div>

      <div className="flex flex-col gap-8">
        {/* W25 / OD-11: framework proposals used to render only on the console
            Home; Lessons now carries the same full review surface. */}
        <FrameworkProposalsPanel />
        <LearnedContextInbox />
        <LearnedFactsArchive />
        <div id="learning-ledger" className="scroll-mt-28">
          <LearningLedgerPanel />
        </div>
      </div>
    </div>
  );
}
