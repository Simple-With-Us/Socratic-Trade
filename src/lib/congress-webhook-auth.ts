// Webhook bearer-secret verification for the congress.trade (App A) push receiver.
//
// Kept in its OWN module (imported only by the Node route handler) so the `crypto` dependency is
// never pulled into the SSE-consumer chain (congress-stream → streams/index → instrumentation),
// which Next bundles for a runtime that rejects Node built-ins. Mirrors web-sources/technical.ts.

import crypto from "crypto";

/**
 * Constant-time verify of App A's webhook signature (X-Signature). Returns false
 * when no secret is configured or the signature is absent/mismatched.
 */
export function verifyCongressWebhookSignature(req: Request, bodyText: string): boolean {
  const expectedSecret = (process.env.CONGRESS_WEBHOOK_SECRET ?? "").trim();
  if (!expectedSecret) return false; // no secret configured → reject all writes

  const signatureHeader = req.headers.get("x-signature")?.trim() ?? "";
  if (!signatureHeader) return false;

  try {
    const hmac = crypto.createHmac("sha256", expectedSecret);
    hmac.update(bodyText);
    const expectedSignature = hmac.digest("hex");

    const provided = Buffer.from(signatureHeader);
    const expected = Buffer.from(expectedSignature);

    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
