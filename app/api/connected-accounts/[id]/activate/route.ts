import { setActiveConnectedAccount } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    setActiveConnectedAccount(id, resolveRequestUserId(req));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Error", { status: 400 });
  }
}
