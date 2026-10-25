import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  SOURCE_SETTING_GROUPS,
  SOURCE_SETTINGS_CATALOG,
  type SourceSettingGroup
} from "@/lib/source-settings-catalog";
import {
  getUserSourceSettingsMap,
  listEffectiveSourceSettings,
  patchUserSourceSettings
} from "@/lib/source-settings";

export const dynamic = "force-dynamic";

/**
 * GET — catalog + effective values (user override / env / default) for Settings UI.
 * PATCH — { settings: { [id]: value | null } } null resets to env+default.
 */
export async function GET(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  const rows = listEffectiveSourceSettings(userId).map((row) => {
    return {
      id: row.spec.id,
      group: row.spec.group,
      label: row.spec.label,
      description: row.spec.description,
      type: row.spec.type,
      defaultValue: row.spec.defaultValue,
      min: row.spec.min,
      max: row.spec.max,
      advanced: row.spec.advanced ?? false,
      caveat: row.spec.caveat,
      value: row.value,
      source: row.source
    };
  });

  return NextResponse.json({
    ok: true,
    groups: SOURCE_SETTING_GROUPS,
    settings: rows,
    overrides: getUserSourceSettingsMap(userId)
  });
}

const PatchBodySchema = z
  .object({
    userId: z.string().optional(),
    settings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()]).nullable())
  })
  .strict();

export async function PATCH(request: NextRequest) {
  try {
    const parsed = PatchBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "settings object required (values: boolean, number, string or null)" }, { status: 400 });
    }
    const body = parsed.data;
    const userId = resolveRequestUserId(request, body);

    const sourcePatch: Record<string, boolean | number | string | null> = {};
    for (const [k, v] of Object.entries(body.settings)) {
      const known = SOURCE_SETTINGS_CATALOG.some((s) => s.id === k);
      if (!known) {
        return NextResponse.json({ error: `Unknown setting: ${k}` }, { status: 400 });
      }
      sourcePatch[k] = v;
    }

    const overrides = patchUserSourceSettings(userId, sourcePatch);

    return NextResponse.json({ ok: true, overrides });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export type { SourceSettingGroup };
