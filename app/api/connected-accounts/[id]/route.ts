import { deleteConnectedAccount, renameConnectedAccount } from "@/lib/db";
import { resolveRequestUserIdOrResponse } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

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
    const body = (await req.json().catch(() => ({}))) as { label?: unknown };
    if (typeof body.label !== "string") {
      return new NextResponse("A `label` string is required.", { status: 400 });
    }
    const userId = resolveRequestUserIdOrResponse(req);
    if (userId instanceof Response) return userId;
    const renamed = renameConnectedAccount(id, body.label, userId);
    if (!renamed) return new NextResponse("Connected account not found.", { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
