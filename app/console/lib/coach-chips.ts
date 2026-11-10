/** Home Coach quick-action chips.  These are real buttons that prefill the
 *  coach note — they are not a legend and not decorative. */

export const COACH_NOTE_CHIPS = [
  { id: "refocus-mandate", label: "Refocus Mandate", prefill: "Refocus the mandate: " },
  { id: "critique-thesis", label: "Critique Thesis", prefill: "Critique the thesis: " },
  { id: "promote-lesson", label: "Promote Lesson", prefill: "Promote this as a lesson: " }
] as const;

export type CoachNoteChip = (typeof COACH_NOTE_CHIPS)[number];

/** Apply a chip to the current note.  An empty (or chip-only) note becomes the
 *  starter phrase.  Owner-typed text is kept and the starter is prepended once. */
export function applyCoachChipPrefill(current: string, prefill: string): string {
  const trimmed = current.trim();
  if (!trimmed) return prefill;
  const starters = COACH_NOTE_CHIPS.map((chip) => chip.prefill.trim());
  if (starters.includes(trimmed)) return prefill;
  if (current.startsWith(prefill)) return current;
  return `${prefill}${trimmed}`;
}
