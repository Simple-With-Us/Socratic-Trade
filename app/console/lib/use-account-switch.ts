"use client";

/** Hook form of the guarded account switch (W16 / OD-11). Wires the pure steps
 *  in ./account-switch to the console's real activate endpoint and snapshot
 *  refresh, and exposes `busyId` — the in-flight guard: while it matches the
 *  account being loaded the callers disable their switch affordance, closing
 *  the window in which a second switch (or another account-scoped control)
 *  could fire mid-scope-change. On failure the hook rethrows so each caller
 *  keeps its own error surface and busy reset. The switch path never goes
 *  through a pagewide navigation escape: the shell's account-keyed page
 *  remount plus refresh replaces the old full-page technique. */

import { useCallback, useState } from "react";
import { activateAccount } from "./api";
import { useConsoleActions } from "./useConsoleData";
import { switchAccountGuarded } from "./account-switch";

export function useAccountSwitch(): { busyId: string | null; switchAccount: (id: string) => Promise<void> } {
  const { refresh } = useConsoleActions();
  const [busyId, setBusyId] = useState<string | null>(null);

  const switchAccount = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await switchAccountGuarded(id, { activate: activateAccount, refresh });
      } finally {
        setBusyId((current) => (current === id ? null : current));
      }
    },
    [refresh]
  );

  return { busyId, switchAccount };
}