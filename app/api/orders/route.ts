import { brokerReadOrRethrow, jsonError } from "@/lib/api-error";
import { getBrokerGateway } from "@/lib/broker";
import { getPolicy } from "@/lib/db";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Permissive on purpose: TypeScript types do not validate runtime broker payloads, but a strict
// field schema would 502 on a valid order that is missing an optional or newly added field.
const equityOrdersResponseSchema = z.array(z.record(z.string(), z.unknown()));

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return new NextResponse("No selected account.", { status: 400 });
  try {
    const parsed = equityOrdersResponseSchema.safeParse(
      await getBrokerGateway(policy, userId).getEquityOrders(accountNumber)
    );
    if (!parsed.success) {
      return jsonError(502, "broker_unavailable", "Broker returned a malformed order list.");
    }
    return NextResponse.json(parsed.data);
  } catch (error) {
    return brokerReadOrRethrow(error);
  }
}
