/** Shared outer-wrapper width for /console content pages.
 *
 *  Owner feedback: switching tabs on desktop showed sections of oddly
 *  different widths (e.g. Journal at 768px next to Orders at 1024px, each
 *  centered, so the whole page visibly jumped left/right and wider/narrower
 *  on every nav click). Standardized on max-w-5xl (1024px) — the session
 *  lead's call over the raw 3xl plurality: the data-dense pages (scan,
 *  orders, macro) lose real table room at 768px and fall into constant
 *  horizontal scrolling, while the reading pages stretch to 1024px
 *  gracefully (label-left/control-right form rows and feed cards keep
 *  working). Two-column layouts (home dashboard, decision-trace ready
 *  state) are documented exceptions — their aside columns have hard px
 *  floors that a narrower cap would starve.
 *
 *  Apply to a page's outermost wrapper, e.g.:
 *    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-4`}>
 */
export const CONSOLE_PAGE_WIDTH = "mx-auto w-full max-w-5xl";
