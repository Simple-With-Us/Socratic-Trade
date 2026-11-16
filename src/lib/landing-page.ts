/**
 * Public marketing-page gate.
 *
 * History: `/welcome` and `/how-it-works` were originally default-off behind
 * `LANDING_PAGE_ENABLED=true`. The gate was deliberately removed 2026-07-03 so the pages
 * stay reachable for product/design review (see docs/rollouts/2026-07-03-socratic-autonomy-ui.md).
 *
 * Current contract (2026-07-27, restated 2026-08-18):
 *   - unset / empty → pages ON (matches live product behavior since 2026-07-03)
 *   - truthy (`1`/`true`/`on`/`yes`) → pages ON
 *   - falsy (`0`/`false`/`off`/`no`) → pages 404 (private deploy / go-public off-switch)
 *
 * Do not 404 `/welcome` in production to "make ST owner-only."  The runtime is
 * single-user today, but it stays multi-user-capable for friends/family on
 * ALLOWED_EMAILS.  Isolation for a second allowed email is a product requirement.
 *
 * Indexing remains separately gated by `NEXT_PUBLIC_ALLOW_INDEXING`.
 */
import { envFlagOn, type EnvSource } from "./rag/env-flag";

export function landingPageEnabled(env: EnvSource = process.env): boolean {
  const raw = env.LANDING_PAGE_ENABLED;
  if (raw == null || String(raw).trim() === "") return true;
  return envFlagOn("LANDING_PAGE_ENABLED", true, env);
}
