/** Remove-key flow for Settings > API keys, kept free of React so it is unit-testable.
 *
 *  The list is ALWAYS reloaded after the DELETE settles, success or failure: deleteApiKey can
 *  reject after the server already ran the DELETE (e.g. the response body failed validation),
 *  so a rejection does not prove the key still exists.  Reloading lets the row reflect the
 *  server's real state, and the error toast says the outcome is uncertain instead of claiming
 *  the key was not removed. */

import { ConsoleApiError } from "../lib/api";
import type { ToastKind } from "../ui/toast";
import type { ApiKeyDeleteResponse, ApiKeyEntry } from "./lib";

export interface RemoveKeyDeps {
  deleteApiKey: (service: string) => Promise<ApiKeyDeleteResponse>;
  reload: () => Promise<void>;
  push: (kind: ToastKind, title: string, detail?: string) => void;
  onSettled?: () => void;
}

export async function runRemoveKey(
  entry: Pick<ApiKeyEntry, "service" | "label" | "credentialName" | "source">,
  deps: RemoveKeyDeps
): Promise<void> {
  const credName = entry.credentialName ?? "key";
  try {
    const result = await deps.deleteApiKey(entry.service);
    if (!result.deleted) {
      deps.push("warn", `No stored ${entry.label} ${credName} was removed`, "Nothing was stored for this service, or the stored row could not be deleted.  Reload to check.");
    } else if (entry.source === "retired") {
      deps.push("pos", `${entry.label} ${credName} removed`, "This provider is retired on Socratic-Trade, so the key was never used.");
    } else {
      deps.push("pos", `${entry.label} ${credName} removed`, "Features it unlocked fall back to the server key if one exists, otherwise turn off.");
    }
  } catch (error) {
    const reason = error instanceof ConsoleApiError ? error.message : String(error);
    deps.push(
      "neg",
      `Could not confirm ${entry.label} ${credName} removal`,
      `${reason}  The ${credName} may or may not have been removed; the list was refreshed to show the current state.`
    );
  } finally {
    await deps.reload();
    deps.onSettled?.();
  }
}
