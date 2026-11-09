import { confirmAndDeleteAccount, getAccountDeletionPreview, prepareAccountDeletion, type AccountDeletionConfirmation } from "@/lib/account-deletion";
import { resolveRequestUser } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = resolveRequestUser(request);
  return NextResponse.json(getAccountDeletionPreview(user));
}

export async function POST(request: Request) {
  const user = resolveRequestUser(request);
  return NextResponse.json(prepareAccountDeletion(user));
}

export async function DELETE(request: Request) {
  const user = resolveRequestUser(request);
  const body = (await request.json().catch(() => ({}))) as AccountDeletionConfirmation;
  try {
    return NextResponse.json(await confirmAndDeleteAccount({ userId: user.userId, email: user.email, body }));
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Account deletion failed.",
        blockers: (error as { blockers?: unknown }).blockers
      },
      { status }
    );
  }
}
