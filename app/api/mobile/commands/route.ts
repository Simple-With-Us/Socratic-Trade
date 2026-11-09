import {
  isMobileCommandType,
  isImmediateMobileCommandType,
  listMobileCommands,
  MobileCommandValidationError,
  executeMobileCommandImmediately,
  processPendingMobileCommands,
  queueMobileCommand
} from "@/lib/mobile-api";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status =
    rawStatus === "queued" || rawStatus === "running" || rawStatus === "succeeded" || rawStatus === "failed" || rawStatus === "cancelled"
      ? rawStatus
      : undefined;
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return NextResponse.json({ commands: listMobileCommands({ userId, status, limit }) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    commandType?: unknown;
    payload?: unknown;
    idempotencyKey?: unknown;
    client?: unknown;
  };
  const userId = resolveRequestUserId(request, body);
  const limited = enforceRateLimit(userId, "mobile/commands", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (!isMobileCommandType(body.commandType)) {
    return NextResponse.json({ error: "commandType is required or unsupported" }, { status: 400 });
  }

  try {
    const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotencyKey;
    const queued = queueMobileCommand({
      userId,
      commandType: body.commandType,
      payload: body.payload,
      idempotencyKey,
      client: body.client
    });
    // Stop/close_only/liquidating AND account.activate run in this request — never wait on the
    // sequential worker (which may be mid strategy.run_once for minutes).
    if (isImmediateMobileCommandType(body.commandType)) {
      const command = await executeMobileCommandImmediately(queued.command.id, userId);
      return NextResponse.json(
        { command, deduped: queued.deduped },
        { status: command.status === "queued" || command.status === "running" ? 202 : 200 }
      );
    }
    void processPendingMobileCommands({ limit: 3 }).catch((error) => console.error("[mobile] command worker kick failed:", error));
    return NextResponse.json(
      { command: queued.command, deduped: queued.deduped },
      { status: queued.deduped ? 200 : 202 }
    );
  } catch (error) {
    const status = error instanceof MobileCommandValidationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid mobile command." }, { status });
  }
}
