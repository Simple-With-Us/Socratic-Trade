import { brokerReadOrInternalError } from "@/lib/api-error";
import { getBrokerGateway } from "@/lib/broker";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return new NextResponse("No selected account.", { status: 400 });
  try {
    return NextResponse.json(await getBrokerGateway(policy, userId).getPortfolio(accountNumber));
  } catch (error) {
    return brokerReadOrInternalError(error);
  }
}
