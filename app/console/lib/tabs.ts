/** Roving-focus keyboard movement for the console's WAI-ARIA tablists.
 *
 *  In the tabs pattern the whole tablist is a SINGLE tab stop (only the selected
 *  tab has tabIndex 0) and arrow keys move between the tabs — so without a key
 *  handler a roving tabIndex would strand keyboard users on one view with no way
 *  to reach the others.
 *
 *  Pure, and in lib rather than beside the tablist, because the switchers live in
 *  app-router page files whose exports Next 16 type-checks against a whitelist —
 *  nothing extra can be exported from a page for a test to import.
 */

/** The tab that should become selected+focused for `key`, or null when the key
 *  is not one this pattern handles (the caller must then NOT preventDefault, so
 *  Tab, Enter, and the rest keep their normal behavior). */
export function nextTabId<T extends string>(ids: readonly T[], current: T, key: string): T | null {
  const index = ids.indexOf(current);
  // Unknown current tab: leave selection and focus exactly where they are rather
  // than guessing an index.
  if (index < 0) return null;
  switch (key) {
    case "ArrowRight":
      return ids[(index + 1) % ids.length];
    case "ArrowLeft":
      return ids[(index - 1 + ids.length) % ids.length];
    case "Home":
      return ids[0];
    case "End":
      return ids[ids.length - 1];
    default:
      return null;
  }
}
