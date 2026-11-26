"use client";

import { useCallback } from "react";
import { activateAccount, ConsoleApiError } from "./api";
import { useNextUnloadBypass } from "./useDirtyGuard";
import { useToast } from "../ui/toast";

/** The guarded account switch shared by the header scope selector and the symbol drawer's
 *  peer-account rows: activate the account server-side, arm the one-shot dirty-unload bypass,
 *  then reload so no stale Account A UI stays interactive while the server points at Account B
 *  and every account-scoped editor remounts from B's snapshot. A failure surfaces the same toast
 *  the header uses and rethrows, so the caller can keep its own surface open / reset busy state.
 *
 *  Must run inside ToastProvider (the console shell). The drawer only mounts its switch affordance
 *  when account data is present, which is exactly the console-shell case. */
export function useGuardedAccountSwitch(): (id: string) => Promise<void> {
  const toast = useToast();
  const allowNextUnload = useNextUnloadBypass();
  return useCallback(
    async (id: string) => {
      try {
        await activateAccount(id);
        allowNextUnload();
        window.location.reload();
      } catch (error) {
        toast.push("neg", "Could not load account", error instanceof ConsoleApiError ? error.message : undefined);
        throw error;
      }
    },
    [toast, allowNextUnload]
  );
}