import { NextResponse } from "next/server";
import { checkAdmin, requireAdmin } from "@/lib/auth/admin";
import { userIdForEmail } from "@/lib/auth/identity";
import { resolveRequestUserId } from "@/lib/request-user";
import { audit } from "@/lib/db";
import {
  SERVER_KNOB_GROUPS,
  listEffectiveServerKnobs,
  resolveServerKnob,
  serverKnobById,
  writeServerKnobThrough
} from "@/lib/server-knobs";
import { InfisicalWriteError, infisicalSettingsStatus } from "@/lib/infisical-settings";

export const dynamic = "force-dynamic";

// Admin/operator route for the server-level operational knobs (Admin > Operations panel):
//   GET  -> catalog + effective value, provenance (override/env/default), and env reset target
//     for every knob in SERVER_KNOBS_CATALOG.
//   POST {id, value} -> write-through save: Infisical FIRST, then the settings cache, then the
//     DB override (see writeServerKnobThrough).  A failed Infisical write fails the save.
//   POST {id, value: null} -> clear the override, falling back to Infisical/default (the
//     Infisical value itself is left alone).
// Admin-gated via the shared requireAdmin gate (same as app/api/admin/r2-usage — these are
// UI-driven flips by a verified admin, not token-scripted backfills). Every write audits
// `server_knob.changed` with the effective before/after values.

function knobsPayload() {
  return {
    ok: true,
    // Infisical SOT status: whether the live settings cache is credentialed
    // (write-through + background refresh available) or boot-env-seeded.
    settings: infisicalSettingsStatus(),
    groups: SERVER_KNOB_GROUPS,
    knobs: listEffectiveServerKnobs().map((row) => ({
      id: row.spec.id,
      group: row.spec.group,
      label: row.spec.label,
      description: row.spec.description,
      type: row.spec.type,
      defaultValue: row.spec.defaultValue,
      min: row.spec.min,
      max: row.spec.max,
      effect: row.spec.effect,
      value: row.value,
      source: row.source,
      envValue: row.envValue,
      override: row.override
    }))
  };
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return NextResponse.json(knobsPayload());
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let id: string | undefined;
  let value: unknown;
  try {
    const body = (await request.json()) as { id?: string; value?: unknown };
    id = body?.id;
    value = body?.value;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const spec = id ? serverKnobById(id) : undefined;
  if (!id || !spec) {
    return NextResponse.json({ ok: false, error: `Unknown server knob: ${id ?? "(missing id)"}` }, { status: 400 });
  }
  if (value !== null) {
    if (spec.type === "boolean" && typeof value !== "boolean") {
      return NextResponse.json({ ok: false, error: `${id} expects a boolean value` }, { status: 400 });
    }
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      return NextResponse.json({ ok: false, error: `${id} expects a finite number value` }, { status: 400 });
    }
  }

  // Record WHICH admin flipped the knob. This used to audit every write under a hardcoded `"local"`,
  // so with more than one entry in ADMIN_USER_EMAILS the audit row could not answer "who did this?".
  // `checkAdmin` re-runs the same (cheap, env-only) decision `requireAdmin` just made and returns the
  // verified email on the allowlist path; the legacy `x-admin-token` path has no email by design, so
  // it is recorded as the token principal rather than silently attributed to a person.
  const actor = checkAdmin(request);
  const actorUserId = actor.email ? userIdForEmail(actor.email) : resolveRequestUserId(request);

  const from = resolveServerKnob(id);
  let infisicalWriteThrough = false;
  try {
    ({ infisicalWriteThrough } = await writeServerKnobThrough(id, value as boolean | number | null));
  } catch (error) {
    if (error instanceof InfisicalWriteError) {
      // Write-through contract: a failed Infisical write fails the save — the DB
      // override is never written, so the layers cannot diverge silently.
      return NextResponse.json(
        { ok: false, error: `Infisical write-through failed for ${id}; save rejected. ${error.message}` },
        { status: 502 }
      );
    }
    throw error;
  }
  const to = resolveServerKnob(id);
  audit(
    "server_knob.changed",
    { id, from, to, override: value, infisicalWriteThrough, actor: { email: actor.email, via: actor.reason } },
    actorUserId
  );

  return NextResponse.json({ ...knobsPayload(), infisicalWriteThrough });
}
