import { brokerReadOrInternalError, resolveRequestUserIdOrApiError } from "@/lib/api-error";
import { getBrokerGateway } from "@/lib/broker";
import { getPolicy } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrApiError(request);
  if (userId instanceof Response) return userId;
  try {
    const policy = getPolicy(userId);
    const accountNumber = policy.accountNumber;
    if (!accountNumber) return new NextResponse("No selected account.", { status: 400 });
    return NextResponse.json(await getBrokerGateway(policy, userId).getEquityPositions(accountNumber));
  } catch (error) {
    return brokerReadOrInternalError(error);
  }
}
