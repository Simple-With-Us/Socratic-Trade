"use client";

/** Unsaved-changes guard (#7): screens with editable drafts register their
 *  dirty state here; the shell warns on tab close (beforeunload) and the nav
 *  rail / tab bar ask "Discard unsaved changes?" before navigating away.
 *
 *  Design: registrations live in a ref'd Map so reading dirtiness at click
 *  time is always current and registering never re-renders the whole shell.
 *  The provider is a no-op server-side. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode
} from "react";

export const DISCARD_PROMPT = "Discard unsaved changes?";

interface DirtyGuardValue {
  register: (id: string, dirty: boolean) => void;
  unregister: (id: string) => void;
  /** True when ANY registered draft is dirty — read at event time, not render time. */
  isDirty: () => boolean;
}

const DirtyGuardContext = createContext<DirtyGuardValue | null>(null);

export function DirtyGuardProvider({ children }: { children: ReactNode }) {
  const dirtyById = useRef(new Map<string, boolean>());

  const value = useMemo<DirtyGuardValue>(() => {
    const isDirty = () => {
      for (const dirty of dirtyById.current.values()) if (dirty) return true;
      return false;
    };
    return {
      register: (id, dirty) => {
        dirtyById.current.set(id, dirty);
      },
      unregister: (id) => {
        dirtyById.current.delete(id);
      },
      isDirty
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!value.isDirty()) return;
      // Browsers show their own generic wording; preventDefault + returnValue is
      // the cross-browser contract for "ask before leaving".
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [value]);

  return <DirtyGuardContext.Provider value={value}>{children}</DirtyGuardContext.Provider>;
}

/** Screens call this with their current dirty flag. Safe outside the provider
 *  (no-op) so components stay testable in isolation. */
export function useUnsavedChanges(dirty: boolean): void {
  const id = useId();
  const ctx = useContext(DirtyGuardContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.register(id, dirty);
    return () => ctx.unregister(id);
  }, [ctx, id, dirty]);
}

/** Returns a click-guard for navigation controls: when any draft is dirty it
 *  asks "Discard unsaved changes?" and cancels the navigation on decline.
 *  Returns true when navigation may proceed. */
export function useNavDirtyGuard(): (event?: { preventDefault: () => void }) => boolean {
  const ctx = useContext(DirtyGuardContext);
  return useCallback(
    (event) => {
      if (!ctx?.isDirty()) return true;
      if (window.confirm(DISCARD_PROMPT)) return true;
      event?.preventDefault();
      return false;
    },
    [ctx]
  );
}
