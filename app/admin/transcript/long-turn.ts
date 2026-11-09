/** When a transcript turn is long enough to be worth collapsing.
 *
 *  /admin/transcript is a read-the-whole-conversation audit view: it fetches up
 *  to 100 turns (src/lib/chat-history.ts clamps MAX_TURNS, whatever ?limit says)
 *  and renders every one fully expanded. That is the right default — putting a
 *  click in front of each turn would defeat the purpose of the page — so the
 *  threshold is deliberately set near the per-turn ceiling rather than at some
 *  "typical reply" length. `sanitizeTranscriptText` truncates each stored turn at
 *  4000 characters, so this only ever catches the handful of near-maximum walls
 *  of text that make the page an unbounded scroll, and leaves ordinary
 *  substantive replies open where you can read them.
 */
export const LONG_TURN_CHARS = 2000;

export interface LongTurnPresentation {
  /** Render the body inside a <details> instead of inline. */
  collapse: boolean;
  /** Summary text when collapsed. Structured (a length), NOT an excerpt: an
   *  excerpt of markdown source would put the same raw `**`/`###` noise into the
   *  summary that we render properly in the body. */
  label: string;
}

export function describeLongTurn(text: string): LongTurnPresentation {
  return {
    collapse: text.length > LONG_TURN_CHARS,
    label: `Long reply · ${text.length.toLocaleString("en-US")} characters`
  };
}
