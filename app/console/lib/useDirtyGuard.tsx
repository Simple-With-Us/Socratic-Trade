"use client";

/** Unsaved-changes guard: screens with editable drafts register their dirty
 *  state here; the shell warns on tab close (beforeunload) and the nav rail /
 *  tab bar intercept navigating away.
 *
 *  On an in-app navigation while dirty, we no longer fall through to a 2-option
 *  `window.confirm`. Instead a 3-option prompt asks: Discard changes (leave,
 *  losing them) · Keep editing (stay) · Review & save (stay and open this
 *  screen's review/commit flow). The third option only appears when the dirty
 *  screen registered a review opener via `useUnsavedChanges(dirty, onReview)`.
 *
 *  Design: dirtiness lives in a ref'd Map so reading it at click time is always
 *  current and registering never re-renders the shell (a keystroke that flips
 *  dirtiness only mutates the Map). Only opening the prompt sets React state.
 *  The provider is a no-op server-side. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useRouter } from "next/navigation";
import { Btn } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

/** @deprecated The 2-option confirm was replaced by the 3-option prompt below; kept exported
 *  for any external reference. */
export const DISCARD_PROMPT = "Discard unsaved changes?";

interface Registration {
  dirty: boolean;
  onReview?: () => void;
}

interface DirtyGuardValue {
  register: (id: string, dirty: boolean, onReview?: () => void) => void;
  unregister: (id: string) => void;
  /** True when ANY registered draft is dirty — read at event time, not render time. */
  isDirty: () => boolean;
  /** When any draft is dirty, opens the 3-option prompt and returns false (the caller must cancel
   *  its own navigation); `proceed` runs only if the user chooses Discard. When clean, runs
   *  `proceed` immediately and returns true. */
  guardNavigation: (proceed: () => void) => boolean;
  /** Suppress exactly the next beforeunload prompt. Used only after a server-side scope mutation
   *  has succeeded and the page must reload so stale scope UI cannot remain interactive. */
  allowNextUnload: () => void;
}

const DirtyGuardContext = createContext<DirtyGuardValue | null>(null);

export function DirtyGuardProvider({ children }: { children: ReactNode }) {
  const registry = useRef(new Map<string, Registration>());
  const allowNextUnloadRef = useRef(false);
  // Only set when a dirty navigation is intercepted — toggling it is the one thing here that
  // re-renders (rare, user-initiated), so typing in a guarded draft never re-renders the shell.
  const [prompt, setPrompt] = useState<null | { proceed: () => void; hasReview: boolean }>(null);

  const value = useMemo<DirtyGuardValue>(() => {
    const isDirty = () => {
      for (const r of registry.current.values()) if (r.dirty) return true;
      return false;
    };
    return {
      register: (id, dirty, onReview) => registry.current.set(id, { dirty, onReview }),
      unregister: (id) => registry.current.delete(id),
      isDirty,
      guardNavigation: (proceed) => {
        if (!isDirty()) {
          proceed();
          return true;
        }
        let hasReview = false;
        for (const r of registry.current.values()) if (r.dirty && r.onReview) hasReview = true;
        setPrompt({ proceed, hasReview });
        return false;
      },
      allowNextUnload: () => {
        allowNextUnloadRef.current = true;
        // Reload normally dispatches beforeunload immediately. Bound the bypass anyway so a blocked
        // or mocked reload cannot silently suppress an unrelated later close/navigation.
        window.setTimeout(() => {
          allowNextUnloadRef.current = false;
        }, 1_000);
      }
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowNextUnloadRef.current) {
        allowNextUnloadRef.current = false;
        return;
      }
      if (!value.isDirty()) return;
      // Browsers show their own generic wording; preventDefault + returnValue is the cross-browser
      // contract for "ask before leaving". (A full-page unload can't offer the in-app 3 options.)
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [value]);

  const discard = () => {
    const proceed = prompt?.proceed;
    setPrompt(null);
    proceed?.();
  };
  const review = () => {
    setPrompt(null);
    for (const r of registry.current.values()) if (r.dirty && r.onReview) r.onReview();
  };

  return (
    <DirtyGuardContext.Provider value={value}>
      {children}
      <Sheet open={prompt !== null} onClose={() => setPrompt(null)} title="Unsaved changes">
        <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
          You have unsaved changes on this page.  Leaving now discards them.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Btn variant="ghost" onClick={() => setPrompt(null)} title="Stay on this page and keep your unsaved changes.">
            Keep editing
          </Btn>
          <Btn variant="dangerOutline" onClick={discard} title="Leave this page and discard the unsaved changes.">
            Discard changes
          </Btn>
          {prompt?.hasReview && (
            <Btn variant="primary" onClick={review} title="Stay here and open the review-and-save panel for these changes.">
              Review &amp; save
            </Btn>
          )}
        </div>
      </Sheet>
    </DirtyGuardContext.Provider>
  );
}

/** Screens call this with their current dirty flag and, optionally, a callback that opens their
 *  review/commit flow (which powers the prompt's "Review & save" option). Safe outside the provider
 *  (no-op) so components stay testable in isolation. */
export function useUnsavedChanges(dirty: boolean, onReview?: () => void): void {
  const id = useId();
  const ctx = useContext(DirtyGuardContext);
  const reviewRef = useRef(onReview);
  useEffect(() => {
    reviewRef.current = onReview;
  });
  const hasReview = Boolean(onReview);
  useEffect(() => {
    if (!ctx) return;
    // The registered thunk reads the latest onReview via the ref, so an inline callback that
    // changes every render doesn't churn this effect — only dirtiness / review-presence do.
    ctx.register(id, dirty, hasReview ? () => reviewRef.current?.() : undefined);
    return () => ctx.unregister(id);
  }, [ctx, id, dirty, hasReview]);
}

/** Returns a click handler for navigation controls. When any draft is dirty it cancels the control's
 *  own navigation and opens the 3-option prompt; the intended `href` is navigated to (client-side)
 *  only if the user chooses Discard. Returns true when navigation may proceed immediately. */
export function useNavDirtyGuard(): (event: { preventDefault: () => void } | undefined, href: string) => boolean {
  const ctx = useContext(DirtyGuardContext);
  const router = useRouter();
  return useCallback(
    (event, href) => {
      if (!ctx || !ctx.isDirty()) return true; // clean → let the Link navigate normally
      event?.preventDefault();
      ctx.guardNavigation(() => router.push(href));
      return false;
    },
    [ctx, router]
  );
}

/** Guard a non-navigation action that also changes the meaning of every account-scoped editor —
 *  chiefly the global account selector. The caller supplies the action and it runs immediately
 *  when clean, or only after the user explicitly chooses Discard in the shared prompt. */
export function useDirtyActionGuard(): (proceed: () => void) => boolean {
  const ctx = useContext(DirtyGuardContext);
  return useCallback(
    (proceed) => {
      if (!ctx) {
        proceed();
        return true;
      }
      return ctx.guardNavigation(proceed);
    },
    [ctx]
  );
}

/** Return a one-shot escape hatch for a mandatory reload after a mutation already changed the
 * server-side scope. Calling it before the mutation would be unsafe; callers arm it only after the
 * mutation succeeds and immediately before `window.location.reload()`. */
export function useNextUnloadBypass(): () => void {
  const ctx = useContext(DirtyGuardContext);
  return useCallback(() => ctx?.allowNextUnload(), [ctx]);
}
