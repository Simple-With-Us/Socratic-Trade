import { brokerReadOrInternalError, resolveRequestUserIdOrApiError } from "@/lib/api-error";
import { getBrokerGateway } from "@/lib/broker";
import { getPolicy } from "@/lib/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserIdOrApiError(request);
  if (userId instanceof Response) return userId;
  try {
    return NextResponse.json(await getBrokerGateway(getPolicy(userId), userId).getAccounts());
  } catch (error) {
    return brokerReadOrInternalError(error);
  }
}
