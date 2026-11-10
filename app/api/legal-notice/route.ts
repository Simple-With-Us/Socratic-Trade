import { NextResponse } from "next/server";
import { getLegalNoticeConsent, needsLegalNoticeConsent, setLegalNoticeConsent } from "@/lib/db";
import { LEGAL_NOTICE_VERSION } from "@/lib/legal-notice";
import { resolveRequestUserId } from "@/lib/request-user";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const consent = getLegalNoticeConsent(userId);
  return NextResponse.json({
    ...consent,
    currentVersion: LEGAL_NOTICE_VERSION,
    needsConsent: needsLegalNoticeConsent(userId)
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
      { error: "Accepting the current legal notice is required to use the app." },
      { status: 400 }
    );
  }
  const record = setLegalNoticeConsent(userId, true);
  return NextResponse.json({
    ...record,
    currentVersion: LEGAL_NOTICE_VERSION,
    needsConsent: false
  });
}
