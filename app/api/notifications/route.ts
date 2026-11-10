import { resolveRequestUserId } from "@/lib/request-user";
import { getNotifyPrefs, setNotifyPrefs } from "@/lib/db";
import { describeChannels, loadUserNotifyConfig } from "@/lib/notify";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  // Availability reflects the user's OWN stored channel credentials as well as
  // server env — per-user Pushover/Twilio creds (Settings → Delivery) make a
  // channel available even when the server operator configured nothing.
  return NextResponse.json({ channels: describeChannels(loadUserNotifyConfig(userId)), prefs: getNotifyPrefs(userId) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    channels?: unknown;
    pushTarget?: unknown;
    pushoverTarget?: unknown;
    webhookUrl?: unknown;
    email?: unknown;
    phone?: unknown;
    pushoverAppToken?: unknown;
    twilioAccountSid?: unknown;
    twilioAuthToken?: unknown;
    twilioFrom?: unknown;
    watchlistDigestEnabled?: unknown;
    userId?: unknown;
  };
  const userId = resolveRequestUserId(request, body);
  return NextResponse.json({ prefs: setNotifyPrefs(userId, body) });
}
