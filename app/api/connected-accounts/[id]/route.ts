import { deleteConnectedAccount, renameConnectedAccount } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// This route owns the PATCH envelope, so it is strict: unknown keys (e.g. a client-sent accountNumber)
// fail validation with HTTP 400 instead of being silently dropped. Only `label` is renameable.
const RenameConnectedAccountBodySchema = z.object({ label: z.string() }).strict();

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const userId = resolveRequestUserIdOrResponse(req);
    if (userId instanceof Response) return userId;
    const deleted = deleteConnectedAccount(id, userId);
    if (!deleted) return new NextResponse("Connected account not found.", { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}

// Rename a connected account's cosmetic display label ONLY. The broker-sourced account number
// and credentials are intentionally out of reach here — this endpoint cannot mutate them.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsedBody = RenameConnectedAccountBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsedBody.success) {
      return new NextResponse("Only a `label` string is accepted.", { status: 400 });
    }
    const userId = resolveRequestUserIdOrResponse(req);
    if (userId instanceof Response) return userId;
    const renamed = renameConnectedAccount(id, parsedBody.data.label, userId);
    if (!renamed) return new NextResponse("Connected account not found.", { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
