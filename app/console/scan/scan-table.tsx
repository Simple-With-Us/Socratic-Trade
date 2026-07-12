"use client";

/** Sortable Market Scan table. Row hover/focus highlight comes free from
 *  `.con-table`; the symbol column is sticky so the table can scroll
 *  horizontally on small screens without losing the identity column (the
 *  sticky cell repaints the row-hover wash itself via group-hover, since its
 *  opaque background sits above the row's). Every header and cell carries a
 *  tooltip; cell tooltips get the scan-level "Received …" stamp when the
 *  field's own tooltip doesn't already carry one. */

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import type { MarketScan } from "@/lib/types";
import { receivedLabel } from "@/lib/dashboard-ui";
import { cx } from "../lib/format";
import { DEFAULT_VISIBLE_SCAN_COLUMN_IDS, SCAN_COLUMNS } from "./columns";

type SortDir = "asc" | "desc";
const SYMBOL_COLUMN_ID = "symbol";
const SCORE_COLUMN_ID = "score";
export const SCAN_COLS_KEY = "console-scan-visible-cols-v1";

/** Missing values (undefined/null/NaN) sort last in BOTH directions so the
 *  interesting rows stay on top whichever way the user flips a column. */
function compareValues(a: unknown, b: unknown, dir: SortDir): number {
  const aMissing = a === undefined || a === null || (typeof a === "number" && !Number.isFinite(a));
  const bMissing = b === undefined || b === null || (typeof b === "number" && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const base = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  return dir === "asc" ? base : -base;
}

// The sticky symbol cell needs its own opaque background (the row's hover wash
// is painted on the <tr>, underneath it). group-hover/focus-within re-derive
// the same 6% fg wash composited onto the surface so hover looks identical
// across the whole row in both themes.
const STICKY_CELL = "sticky left-0 z-[1] bg-[color:var(--con-surface)]";
const STICKY_CELL_HOVER =
  "group-hover:bg-[color:color-mix(in_oklab,var(--con-fg)_6%,var(--con-surface))] group-focus-within:bg-[color:color-mix(in_oklab,var(--con-fg)_6%,var(--con-surface))]";

function defaultSortForVisible(visible: string[]): { col: string; dir: SortDir } {
  return visible.includes(SCORE_COLUMN_ID) ? { col: SCORE_COLUMN_ID, dir: "desc" } : { col: SYMBOL_COLUMN_ID, dir: "asc" };
}

export function sanitizeVisibleScanColumns(saved: unknown): string[] {
  if (!Array.isArray(saved)) return DEFAULT_VISIBLE_SCAN_COLUMN_IDS;
  const valid = new Set(SCAN_COLUMNS.map((column) => column.id));
  const deduped = saved.filter((id): id is string => typeof id === "string" && valid.has(id)).filter((id, i, arr) => arr.indexOf(id) === i);
  if (deduped.length === 0) return DEFAULT_VISIBLE_SCAN_COLUMN_IDS;
  return [SYMBOL_COLUMN_ID, ...deduped.filter((id) => id !== SYMBOL_COLUMN_ID)];
}

export function toggleVisibleScanColumn(visible: string[], id: string): string[] {
  if (id === SYMBOL_COLUMN_ID) return visible;
  return visible.includes(id) ? visible.filter((columnId) => columnId !== id) : [...visible, id];
}

export function moveVisibleScanColumn(visible: string[], id: string, delta: -1 | 1): string[] {
  if (id === SYMBOL_COLUMN_ID) return visible;
  const from = visible.indexOf(id);
  if (from === -1) return visible;
  const minIndex = visible[0] === SYMBOL_COLUMN_ID ? 1 : 0;
  const to = Math.max(minIndex, Math.min(visible.length - 1, from + delta));
  if (from === to) return visible;
  const next = visible.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function sameScanColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export function ScanTable({ scan }: { scan: MarketScan }) {
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: "score", dir: "desc" });
  const [visible, setVisible] = useState<string[]>(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
  const [columnsOpen, setColumnsOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SCAN_COLS_KEY);
      if (!saved) return;
      const next = sanitizeVisibleScanColumns(JSON.parse(saved));
      setVisible((current) => (sameScanColumns(current, next) ? current : next));
    } catch {
      /* ignore storage failures */
    }
  }, []);

  function saveVisibleColumns(next: string[]) {
    setVisible(next);
    try {
      window.localStorage.setItem(SCAN_COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore storage failures */
    }
  }

  function resetScanColumns() {
    saveVisibleColumns(DEFAULT_VISIBLE_SCAN_COLUMN_IDS);
  }

  const activeSort = useMemo(() => (visible.includes(sort.col) ? sort : defaultSortForVisible(visible)), [sort, visible]);

  const rows = useMemo(() => {
    // Shape defense (not data hiding): a candidate without a symbol can't be
    // keyed or drilled into — old/compact run captures may carry such rows.
    const candidates = scan.topCandidates.filter((q) => typeof q?.symbol === "string" && q.symbol.length > 0);
    const col = SCAN_COLUMNS.find((c) => c.id === activeSort.col);
    if (!col) return candidates;
    return [...candidates].sort((a, b) => compareValues(col.sortValue(a), col.sortValue(b), activeSort.dir));
  }, [activeSort, scan]);

  const visibleColumns = useMemo(
    () =>
      visible
        .map((id) => SCAN_COLUMNS.find((column) => column.id === id))
        .filter((column): column is (typeof SCAN_COLUMNS)[number] => Boolean(column)),
    [visible]
  );

  const columnChooserRows = useMemo(
    () => [...visibleColumns, ...SCAN_COLUMNS.filter((column) => !visible.includes(column.id))],
    [visible, visibleColumns]
  );

  // The quote-level `asOf` can be a display sentence rather than a timestamp;
  // the scan's ISO generatedAt is the authoritative "received" time here.
  const received = receivedLabel(scan.generatedAt);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-[color:var(--con-line)] px-4 py-2">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title="Visible columns are saved per browser for the console scan table.">
          {visibleColumns.length} shown
        </p>
        <div className="relative">
          <button
            type="button"
            onClick={() => setColumnsOpen((open) => !open)}
            title="Show, hide, reorder, or reset scan columns. Saved in this browser."
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[color:var(--con-line)] bg-[color:var(--con-surface)] px-2.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)] transition-colors hover:text-[color:var(--con-fg)]"
          >
            <Columns3 size={14} aria-hidden />
            Columns
          </button>
          {columnsOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-10 cursor-default border-0 bg-transparent p-0"
                aria-label="Close column settings"
                onClick={() => setColumnsOpen(false)}
              />
              <div className="absolute right-0 z-20 mt-1 flex max-h-[60vh] w-72 flex-col overflow-hidden rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface)] shadow-[var(--shadow-lg)]">
                <div className="flex items-center justify-between gap-2 border-b border-[color:var(--con-line)] px-3 py-2">
                  <p className="text-[length:var(--con-fs-xs)] font-semibold uppercase tracking-[0.07em] text-[color:var(--con-faint)]">
                    Columns
                  </p>
                  <button
                    type="button"
                    onClick={resetScanColumns}
                    className="text-[length:var(--con-fs-xs)] font-medium text-[color:var(--con-accent)] hover:opacity-80"
                  >
                    Reset
                  </button>
                </div>
                <div className="overflow-auto p-1.5">
                  {columnChooserRows.map((column) => {
                    const isVisible = visible.includes(column.id);
                    const index = visible.indexOf(column.id);
                    return (
                      <div
                        key={column.id}
                        title={column.headerTitle}
                        className={cx(
                          "grid grid-cols-[1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)] hover:bg-[color:var(--con-surface-2)]",
                          !isVisible && "opacity-70"
                        )}
                      >
                        <label className={cx("flex min-w-0 items-center gap-2", column.id === SYMBOL_COLUMN_ID ? "opacity-70" : "cursor-pointer")}>
                          <input
                            type="checkbox"
                            checked={isVisible}
                            onChange={() => saveVisibleColumns(toggleVisibleScanColumn(visible, column.id))}
                            disabled={column.id === SYMBOL_COLUMN_ID}
                            className="accent-[var(--con-accent)]"
                          />
                          <span className="truncate">{column.label}</span>
                        </label>
                        {isVisible ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Move ${column.label} earlier`}
                              onClick={() => saveVisibleColumns(moveVisibleScanColumn(visible, column.id, -1))}
                              disabled={index <= 0}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--con-faint)] hover:bg-[color:var(--con-surface-2)] hover:text-[color:var(--con-fg)] disabled:opacity-30"
                            >
                              <ArrowUp size={14} aria-hidden />
                            </button>
                            <button
                              type="button"
                              aria-label={`Move ${column.label} later`}
                              onClick={() => saveVisibleColumns(moveVisibleScanColumn(visible, column.id, 1))}
                              disabled={index === visible.length - 1}
                              className="inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--con-faint)] hover:bg-[color:var(--con-surface-2)] hover:text-[color:var(--con-fg)] disabled:opacity-30"
                            >
                              <ArrowDown size={14} aria-hidden />
                            </button>
                          </div>
                        ) : (
                          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">hidden</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="con-table w-full min-w-max">
        <thead>
          <tr>
            {visibleColumns.map((c, i) => {
              const active = activeSort.col === c.id;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={active ? (activeSort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cx(c.num && "num", i === 0 && STICKY_CELL)}
                >
                  <button
                    type="button"
                    title={`${c.headerTitle}\nClick to sort by ${c.label.toLowerCase()}${active ? ` (currently ${activeSort.dir === "asc" ? "ascending" : "descending"})` : ""}.`}
                    onClick={() => setSort({ col: c.id, dir: activeSort.col === c.id && activeSort.dir === "desc" ? "asc" : "desc" })}
                    className={cx(
                      "inline-flex cursor-pointer select-none items-center gap-1 font-semibold uppercase tracking-[0.07em] transition-colors",
                      active ? "text-[color:var(--con-fg)]" : "hover:text-[color:var(--con-fg)]"
                    )}
                  >
                    {c.label}
                    <span aria-hidden className={cx("text-[9px]", !active && "opacity-0")}>
                      {active && activeSort.dir === "asc" ? "▲" : "▼"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.symbol} className="group">
              {visibleColumns.map((c, i) => {
                const own = c.cellTitle?.(q);
                // Stamp the scan-level "Received …" only when the cell's own
                // tooltip doesn't already carry a received line — no duplicates.
                const title =
                  [own, own?.includes("Received ") ? undefined : received].filter(Boolean).join("\n") || undefined;
                return (
                  <td
                    key={c.id}
                    title={title}
                    className={cx("cursor-default whitespace-nowrap", c.num && "num con-num", i === 0 && cx(STICKY_CELL, STICKY_CELL_HOVER))}
                  >
                    {c.render(q)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  );
}
