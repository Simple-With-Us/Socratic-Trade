import { getBrokerGateway } from "@/lib/broker";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json(await getBrokerGateway(getPolicy(userId), userId).getAccounts());
}
