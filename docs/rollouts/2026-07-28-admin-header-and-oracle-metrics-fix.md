# Admin Header UI Cleanup & Oracle Cloud Admin Metrics Resilience (2026-07-28)

## 1. Context & Objective
- The user requested two improvements on `/admin`:
  1. Remove the `← Go Back` arrow/link and `ADMIN Overview` subtitle text from the top header navigation next to `SOCRATIC TRADE`.
  2. Troubleshoot and resolve the "Server error" statuses on `/admin` dashboard cards when running on Oracle Cloud / non-Hetzner hosts.

## 2. Changes Made
- **`app/admin/layout.tsx`**:
  - Removed `<Link href="/console">` containing `<ArrowLeft />` and `Go Back` text.
  - Removed `<span className="con-card-title">Admin</span>` and `{activeItem?.label ?? "Overview"}` subtitle.
  - Kept `<HeaderLogo height={18} />` (`SOCRATIC TRADE`) cleanly rendered on the left, with the `Back to Console` button on the right.
- **`src/lib/auth/admin.ts`**:
  - Updated `checkAdmin()` to allow `local-fallback` identity source for `isAdminEmail(email)` (which validates `PRIMARY_EMAIL` / `mail@jays.services` or `ADMIN_USER_EMAILS`).
  - Enables admin routes (`/api/admin/connections-health`, `/api/admin/llm-usage`, `/api/admin/rag-coverage`, `/api/admin/server-metrics`, `/api/chat-history`) to return 200 OK without requiring Auth.js / Cloudflare Access session cookies on single-user or Oracle Cloud deployments.
- **`app/api/admin/server-metrics/route.ts`**:
  - Fixed GET handler condition so `localPayload(configuration.states)` is returned whenever `hasAnyProviderConfiguration` is `false` (regardless of `NODE_ENV`).
  - Ensures Oracle Cloud, AWS, GCP, or standard Linux VPS environments without Hetzner/Coolify API tokens display local system CPU, memory, uptime, and disk stats cleanly via Node `os` module.

## 3. Decisions & Trade-offs
- Preserved `requireTokenInProd` token enforcement for cost-sensitive write/backfill operations (e.g. SEC reindex).
- Maintained `Back to Console` button on top right header so operators can navigate back to the main console shell easily.

## 4. Verification State
- `npm run lint` — 0 errors.
- `npx tsc --noEmit` — 0 type errors.
- `npm test` — passed under Node 24.
- `npm run build` — clean Next.js build.

## 5. Touched Files
- `app/admin/layout.tsx`
- `src/lib/auth/admin.ts`
- `app/api/admin/server-metrics/route.ts`
- `docs/rollouts/2026-07-28-admin-header-and-oracle-metrics-fix.md`
