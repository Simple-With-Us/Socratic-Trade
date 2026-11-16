// Release an unread response body.
//
// Proxied fetches hold a concurrency-gate slot until the body settles
// (src/lib/proxy-fetch.ts). A retry or an error return that never reads the
// body keeps that slot for the life of the process. Cancel on every path that
// does not hand the body to a caller. Do not edit the proxy wrapper for this.

export async function cancelResponseBody(response: Response | undefined | null): Promise<void> {
  if (!response?.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch {
    // The body is already closed or cancelled.
  }
}

/**
 * Cancel an error response and return a status-preserving response with an
 * empty body. Callers still read `status` / `ok`. The original stream is
 * released so the proxy gate slot is not held.
 */
export async function detachErrorResponse(response: Response): Promise<Response> {
  if (response.ok || response.bodyUsed || response.body == null) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  await cancelResponseBody(response);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
