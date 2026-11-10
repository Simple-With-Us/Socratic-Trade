"use client";

import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./focus-trap";
import { useOverlay } from "./use-overlay";

interface SymbolDrawerContent {
  title: ReactNode;
  ariaLabel: string;
  body: ReactNode;
}

interface SymbolDrawerApi {
  openDrawer: (content: SymbolDrawerContent) => void;
  updateDrawerTitle: (ariaLabel: string, title: ReactNode) => void;
  closeDrawer: () => void;
}

const SymbolDrawerContext = createContext<SymbolDrawerApi | null>(null);

export function SymbolDrawerProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<SymbolDrawerContent | null>(null);

  const closeDrawer = useCallback(() => setContent(null), []);
  const updateDrawerTitle = useCallback((ariaLabel: string, title: ReactNode) => {
    setContent((current) =>
      current?.ariaLabel === ariaLabel ? { ...current, title } : current
    );
  }, []);
  const api = useMemo<SymbolDrawerApi>(
    () => ({
      openDrawer: setContent,
      updateDrawerTitle,
      closeDrawer
    }),
    [closeDrawer, updateDrawerTitle]
  );

  return (
    <SymbolDrawerContext.Provider value={api}>
      {children}
      {/* Keyed on the drawer's identity so opening a DIFFERENT symbol from inside the open
       *  drawer remounts the host: the focus trap re-runs and moves focus into the new
       *  content. `updateDrawerTitle` keeps the same ariaLabel on purpose, so a title
       *  refresh does NOT remount and cannot yank focus mid-read. */}
      {content && <SymbolDrawerHost key={content.ariaLabel} content={content} onClose={closeDrawer} />}
    </SymbolDrawerContext.Provider>
  );
}

export function useSymbolDrawer() {
  const context = useContext(SymbolDrawerContext);
  if (!context) throw new Error("useSymbolDrawer must be used inside SymbolDrawerProvider");
  return context;
}

function SymbolDrawerHost({ content, onClose }: { content: SymbolDrawerContent; onClose: () => void }) {
  const drawerRef = useRef<HTMLElement>(null);
  const overlayId = useId();
  // The host only mounts while a drawer is open, so the trap is active for its whole life:
  // focus moves in on mount, Tab stays inside, Escape closes, and unmount hands focus back
  // to the SymbolButton that opened it.
  useFocusTrap(drawerRef, true, { onEscape: onClose });
  useOverlay(overlayId, true, onClose);

  return (
    <>
      <div className="con-drawer-scrim" onClick={onClose} aria-hidden />
      <aside
        ref={drawerRef}
        className="con-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={content.ariaLabel}
        tabIndex={-1}
      >
        <header className="con-drawer-header">
          <h2 className="min-w-0 text-[length:var(--con-fs-md)] font-semibold">{content.title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="con-icon-btn h-8 w-8 shrink-0"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="con-drawer-body">{content.body}</div>
      </aside>
    </>
  );
}
