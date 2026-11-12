import "server-only";
import { headers } from "next/headers";
import { CSP_NONCE_HEADER } from "./csp-policy";

/** Same token shape Next extracts from `'nonce-...'`.  Anything else is ignored. */
const NONCE_TOKEN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Nonce middleware stamped on this request.  Undefined when CSP is off, when
 * CSP_POLICY replaces the built-in policy, or when the header is not a nonce token.
 *
 * Calling this reads request headers, so the route is dynamically rendered.
 * A static or ISR body cannot carry a matching per-request nonce.
 */
export async function readRequestCspNonce(): Promise<string | undefined> {
  const value = (await headers()).get(CSP_NONCE_HEADER)?.trim();
  if (!value || !NONCE_TOKEN.test(value)) return undefined;
  return value;
}
