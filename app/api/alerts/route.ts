import { resolveRequestUserId } from "@/lib/request-user";
import { createAlert, listAlerts, removeAlert } from "@/lib/alerts";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam === "armed" || statusParam === "triggered" ? statusParam : "all";
  return NextResponse.json({ alerts: listAlerts(userId, status) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: unknown;
    op?: unknown;
    price?: unknown;
    note?: unknown;
    userId?: unknown;
  };
  const userId = resolveRequestUserId(request, body);
  if (typeof body.symbol !== "string" || typeof body.op !== "string" || body.price == null) {
    return NextResponse.json({ error: "symbol, op, and price are required" }, { status: 400 });
  }
  const result = createAlert(userId, {
    symbol: body.symbol,
    op: body.op,
    price: Number(body.price),
    note: typeof body.note === "string" ? body.note : undefined
  });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; userId?: unknown };
  const userId = resolveRequestUserId(request, body);
  const id = typeof body.id === "string" ? body.id : url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const removed = removeAlert(userId, id);
  return NextResponse.json({ removed });
}
