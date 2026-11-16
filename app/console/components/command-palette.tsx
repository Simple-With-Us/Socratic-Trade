"use client";

/** Console command palette (⌘K / Ctrl+K). A from-anywhere jump to any of the console
 *  destinations, a few safe global actions, and (once you type) settings catalog hits
 *  from `searchSettings` / `settingsPaletteHits`. Console-native (con-* tokens, mounts
 *  inside .console-root). Opens on the ⌘K/Ctrl+K chord or the chrome trigger button;
 *  arrow keys + Enter to run, Escape to close. Navigation uses the router — the
 *  beforeunload dirty guard still catches a tab close; in-console unsaved-draft
 *  interception on palette jumps is a deliberate v1 gap, not a silent one. */

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";
import { DESTINATIONS } from "./nav";
import { hasBlockingFocusTrap, useFocusTrap } from "../ui/focus-trap";
import { useOverlay } from "../ui/use-overlay";
import { useConsoleTheme } from "../lib/useConsoleTheme";
import { useNavDirtyGuard } from "../lib/useDirtyGuard";
import { cx } from "../lib/format";
import { settingsPaletteHits } from "../../settings-search";

const CMDK_EVENT = "console:open-command-palette";

interface Command {
  id: string;
  label: string;
  hint?: string;
  hotkey?: string;
  keywords: string;
  group?: "command" | "settings";
  title?: string;
  run: () => void;
}

/** True on Apple platforms (so we show ⌘ rather than Ctrl). Resolved after mount to avoid
 *  an SSR/client hydration mismatch — defaults to the ⌘ label, corrected on the client. */
function useIsApple(): boolean {
  const [apple, setApple] = useState(true);
  useEffect(() => {
    const p = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}` : "";
    setApple(/Mac|iPhone|iPad|iPod/i.test(p));
  }, []);
  return apple;
}

/** Compact chrome button that advertises and opens the palette.
 *  Always mounted in the chrome bar (PR-E3) — including mobile — so touch
 *  users can discover it without a keyboard. The ⌘/Ctrl kbd badge is hidden
 *  below `sm` so the phone bar stays dense (icon-only). */
export function CommandPaletteTrigger() {
  const apple = useIsApple();
  return (
    <button
      type="button"
      className="con-cmdk-trigger"
      title="Search screens, actions, and settings (⌘K / Ctrl+K)"
      aria-label="Open command palette"
      onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
    >
      <Search size={14} aria-hidden />
      <kbd className="hidden sm:inline">{apple ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const checkNav = useNavDirtyGuard();
  const { cycle } = useConsoleTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionIdPrefix = useId();
  const overlayId = useId();

  // Focus moves to the search input (the first focusable), Tab stays inside the palette,
  // Escape closes it, and closing returns focus to wherever the user was — a jump-anywhere
  // affordance that dropped focus on document.body would cost keyboard users their place.
  useFocusTrap(dialogRef, open, { onEscape: () => setOpen(false) });
  useOverlay(overlayId, open, () => setOpen(false));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        // A blocking surface (the consent gate) owns the screen until it is answered, and
        // palette commands navigate — opening over it would route around it.
        if (hasBlockingFocusTrap()) return;
        setOpen((o) => !o);
        return;
      }

      if (hasBlockingFocusTrap()) return;

      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);

      if (isInput) return;

      // 1-6 for tab navigation
      if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-6]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1;
        const dest = DESTINATIONS[index];
        if (dest) {
          e.preventDefault();
          if (checkNav(undefined, dest.href)) {
            router.push(dest.href);
          }
        }
        return;
      }

      // A / a for approve / proposals
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        if (checkNav(undefined, "/console/approvals")) {
          router.push("/console/approvals");
        }
        return;
      }

      // R / r for run-once
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        window.dispatchEvent(new Event("console:run-once"));
        return;
      }
    };
    const onOpen = () => {
      if (hasBlockingFocusTrap()) return;
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(CMDK_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(CMDK_EVENT, onOpen);
    };
  }, [checkNav, router]);

  const commands = useMemo<Command[]>(
    () => [
      ...DESTINATIONS.map((d, idx) => ({
        id: `nav:${d.href}`,
        label: d.label,
        hint: d.desc,
        hotkey: idx < 6 ? `${idx + 1}` : d.href === "/console/approvals" ? "A" : undefined,
        keywords: `${d.label} ${d.href} ${d.desc}`.toLowerCase(),
        run: () => {
          if (checkNav(undefined, d.href)) {
            router.push(d.href);
          }
        }
      })),
      {
        id: "nav:alerts-center",
        label: "Alerts Center",
        hint: "Open the Alerts Center on Activity.",
        keywords: "notifications alerts inbox history unread alert center",
        run: () => {
          if (checkNav(undefined, "/console/activity?tab=alerts")) {
            router.push("/console/activity?tab=alerts");
          }
        }
      },
      {
        id: "nav:notifications",
        label: "Notifications",
        hint: "Delivery ledger of push, email, SMS, and Pushover sends.",
        keywords: "notifications delivery push pushover email sms sent",
        run: () => {
          if (checkNav(undefined, "/console/activity?tab=notifications")) {
            router.push("/console/activity?tab=notifications");
          }
        }
      },
      {
        id: "action:run-once",
        label: "Run once strategy",
        hint: "Execute manual strategy run",
        hotkey: "R",
        keywords: "run once strategy manual execute start r",
        run: () => window.dispatchEvent(new Event("console:run-once"))
      },
      {
        id: "action:theme",
        label: "Toggle theme",
        hint: "Cycle light / dark / follow system",
        keywords: "toggle theme dark light mode appearance system",
        run: cycle
      }
    ],
    [router, cycle, checkNav]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const navHits = q ? commands.filter((c) => c.keywords.includes(q)) : commands;
    if (!q) return navHits;
    const settingHits: Command[] = settingsPaletteHits(query).map((hit) => ({
      id: `setting:${hit.id}`,
      label: hit.label,
      hint: hit.hint,
      title: hit.help,
      keywords: "",
      group: "settings",
      run: () => {
        if (!checkNav(undefined, hit.href)) return;
        router.push(hit.href);
        const hash = hit.href.includes("#") ? hit.href.slice(hit.href.indexOf("#") + 1) : "";
        if (!hash) return;
        // Same-page hash: Next may not remount, so scroll the live section ourselves.
        window.setTimeout(() => {
          document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 60);
      }
    }));
    return [...navHits, ...settingHits];
  }, [commands, query, checkNav, router]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  };

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="con-cmdk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={() => setOpen(false)}
    >
      <div className="con-cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="con-cmdk-search">
          <Search size={16} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a screen, action, or setting…"
            aria-label="Search commands and settings"
            autoComplete="off"
            spellCheck={false}
            // Combobox wiring: the input keeps focus while the arrow keys move the
            // highlight, so without aria-activedescendant a screen reader announces the
            // input and never the option the user has landed on.
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? `${optionIdPrefix}-${filtered[active].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(active);
              }
            }}
          />
          <kbd className="con-kbd">esc</kbd>
        </div>
        <ul className="con-cmdk-list" ref={listRef} id={listId} role="listbox" aria-label="Commands and settings">
          {filtered.length === 0 ? (
            <li className="con-cmdk-empty">No matches</li>
          ) : (
            filtered.map((c, i) => {
              const showSettingsHeading = c.group === "settings" && filtered[i - 1]?.group !== "settings";
              return (
                <Fragment key={c.id}>
                  {showSettingsHeading && (
                    <li className="con-cmdk-group" role="presentation">
                      Settings
                    </li>
                  )}
                  <li
                    id={`${optionIdPrefix}-${c.id}`}
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    className={cx("con-cmdk-item")}
                    title={c.title}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runAt(i);
                    }}
                  >
                    <span className="con-cmdk-item-label">{c.label}</span>
                    {c.hint && <span className="con-cmdk-item-hint">{c.hint}</span>}
                    {c.hotkey && <kbd className="con-kbd text-[10px] ml-auto mr-1">{c.hotkey}</kbd>}
                    {i === active && <CornerDownLeft size={13} className="con-cmdk-enter" aria-hidden />}
                  </li>
                </Fragment>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
