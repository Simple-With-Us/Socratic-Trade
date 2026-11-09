import { getPolicy } from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return new NextResponse("No selected account.", { status: 400 });
  return NextResponse.json(await getBrokerGateway(policy, userId).getPortfolio(accountNumber));
}
