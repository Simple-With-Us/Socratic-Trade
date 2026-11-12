import { createStrategyProfile, listStrategyProfiles } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import type { TradingPolicy } from "@/lib/types";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// This route owns the create envelope, so it is strict: unknown keys or wrong types are HTTP 400
// before anything reaches createStrategyProfile.
const CreateStrategyProfileSchema = z
  .object({
    name: z.string().optional(),
    prompt: z.string().optional(),
    policy: z.record(z.string(), z.unknown()).optional(),
    active: z.boolean().optional()
  })
  .strict();

export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  return NextResponse.json(listStrategyProfiles(userId));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateStrategyProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid profile payload", issues: parsed.error.issues }, { status: 400 });
  }
  const userId = resolveRequestUserIdOrResponse(request);
  if (userId instanceof Response) return userId;
  const { name, prompt, policy, active } = parsed.data;
  const profile = createStrategyProfile({
    name: name?.trim() ? name.trim() : "New Strategy",
    prompt,
    policy: policy as Partial<TradingPolicy> | undefined,
    active: active ?? false
  }, userId);
  return NextResponse.json(profile);
}
