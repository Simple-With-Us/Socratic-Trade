import { NextResponse } from "next/server";
import {
  DATA_POOL_CONSENT_VERSION,
  getDataPoolConsent,
  getLegalNoticeConsent,
  needsAppConsent,
  setDataPoolConsent,
  setLegalNoticeConsent
} from "@/lib/db";
import { LEGAL_NOTICE_VERSION } from "@/lib/legal-notice";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  return NextResponse.json({
    legal: getLegalNoticeConsent(userId),
    dataPool: getDataPoolConsent(userId),
    legalVersion: LEGAL_NOTICE_VERSION,
    dataPoolVersion: DATA_POOL_CONSENT_VERSION,
    needsConsent: needsAppConsent(userId)
  });
}

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  let accepted = false;
  try {
    const body = (await request.json()) as { accepted?: boolean };
    accepted = body?.accepted === true;
  } catch {
    accepted = false;
  }
  if (!accepted) {
    return NextResponse.json(
      { error: "Accepting the current terms, privacy notice, and shared data pool is required to use the app." },
      { status: 400 }
    );
  }
  const legal = setLegalNoticeConsent(userId, true);
  const dataPool = setDataPoolConsent(userId, true);
  return NextResponse.json({
    legal,
    dataPool,
    legalVersion: LEGAL_NOTICE_VERSION,
    dataPoolVersion: DATA_POOL_CONSENT_VERSION,
    needsConsent: false
  });
}
