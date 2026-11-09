import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  infisicalSettingsStatus,
  refreshInfisicalSettings
} from "@/lib/infisical-settings";

export const dynamic = "force-dynamic";

// Admin-only on-demand refresh of the Infisical settings cache (fleet SOT
// directive 2026-10-03 — the "Reload settings" admin action from the canonical
// pattern; the other on-demand path is the SIGHUP handler installed at boot).
// Admin-gated via the shared requireAdmin gate (403 for non-admins).
//
// POST -> refresh the in-memory cache from Infisical and return the status.
// A failed refresh keeps serving the last-known-good cache (reported honestly
// in the payload); an uncredentialed process (production — the secrets runner
// scrubs bootstrap credentials by design) reports refreshed:false with the
// reason instead of pretending.
export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const result = await refreshInfisicalSettings();
  return NextResponse.json({
    ok: result.refreshed || result.reason === "uncredentialed",
    refresh: result,
    settings: infisicalSettingsStatus()
  });
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return NextResponse.json({ ok: true, settings: infisicalSettingsStatus() });
}
