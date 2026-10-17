"use client";
import { Select } from "../ui/primitives";
import type { ApiKeyEntry } from "./lib";

type Route = NonNullable<ApiKeyEntry["route"]>;
export function LlmRouteSelect({ entry, busy, retired, onChange }: {
  entry: ApiKeyEntry; busy: boolean; retired: boolean; onChange: (route: Route) => void;
}) {
  return <label className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]"
    title={entry.route === "code-cli" && !entry.codeCliAvailable ? "Code CLI is unavailable.  Choose another route or finish server setup." : "OpenRouter or direct API with your key.  Code CLI uses the owner's server subscription for text only, without tools."}>
    <span className="whitespace-nowrap">Route</span>
    <Select className="min-w-[10rem] py-0.5 text-[length:var(--con-fs-xs)]"
      value={entry.route ?? "openrouter"} disabled={busy || retired || (entry.source === "none" && !entry.codeCliAvailable)}
      aria-busy={busy} aria-label={`${entry.label} route`}
      onChange={e => onChange(e.target.value === "code-cli" ? "code-cli" : e.target.value === "native" ? "native" : "openrouter")}>
      <option value="openrouter">OpenRouter (default)</option>
      <option value="native">Direct (own key)</option>
      {(entry.codeCliAvailable || entry.route === "code-cli") &&
        <option value="code-cli" disabled={!entry.codeCliAvailable}>Code CLI (server)</option>}
    </Select>
  </label>;
}
