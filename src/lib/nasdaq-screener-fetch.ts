import { fetchWithRetry } from "./data-providers";
import { withProviderLimit } from "./provider-rate-limit";
import { BROWSER_UA } from "./web-sources/http";

/**
 * Shared Nasdaq delayed-screener fetch. Quote + calendar already use BROWSER_UA +
 * Origin/Referer + fetchWithRetry (2026-08-05). The screener was left on stub
 * "Mozilla/5.0" + `setTimeout(() => controller.abort(), 8000)` with no reason,
 * which Node/undici reports as "This operation was aborted" and never writes
 * the 5-minute cache. That is why prod receipts are `market_scan` with 0 quotes.
 */
export const NASDAQ_SCREENER_URL =
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=8000&offset=0";

export const NASDAQ_SCREENER_TIMEOUT_MS = 15_000;
export const NASDAQ_SCREENER_ATTEMPTS = 2;
export const NASDAQ_SCREENER_TIMEOUT_MESSAGE =
  "Nasdaq delayed screener timed out waiting for api.nasdaq.com.";

export const NASDAQ_SCREENER_HEADERS = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent": BROWSER_UA,
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/"
} as const;

export function nasdaqScreenerUrl(exchange?: "nasdaq" | "nyse"): string {
  if (!exchange) return NASDAQ_SCREENER_URL;
  const url = new URL(NASDAQ_SCREENER_URL);
  url.searchParams.set("exchange", exchange);
  return url.toString();
}

function isScreenerTimeout(error: unknown, reason: unknown): boolean {
  const named =
    (reason instanceof Error && reason.message === NASDAQ_SCREENER_TIMEOUT_MESSAGE) ||
    (error instanceof Error && error.message === NASDAQ_SCREENER_TIMEOUT_MESSAGE);
  const abort = error instanceof Error && error.name === "AbortError";
  return named || abort;
}

function errorFromSignal(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

/** Parent deadline aborts the in-flight headers.  It does not retry: the scan budget is gone. */
function bindParentSignal(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort);
  return () => signal.removeEventListener("abort", onAbort);
}

export async function fetchNasdaqScreenerResponse(
  service: "nasdaq-delayed-screener" | "congress-nasdaq-screener",
  options?: { url?: string; signal?: AbortSignal }
): Promise<Response> {
  const url = options?.url ?? NASDAQ_SCREENER_URL;
  const parent = options?.signal;
  if (parent?.aborted) {
    throw errorFromSignal(parent, "Nasdaq screener aborted before the request started.");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < NASDAQ_SCREENER_ATTEMPTS; attempt++) {
    if (parent?.aborted) {
      throw errorFromSignal(parent, "Nasdaq screener aborted.");
    }
    const controller = new AbortController();
    const unlink = bindParentSignal(controller, parent);
    const timeout = setTimeout(() => {
      controller.abort(new Error(NASDAQ_SCREENER_TIMEOUT_MESSAGE));
    }, NASDAQ_SCREENER_TIMEOUT_MS);
    try {
      // fetch() resolves when headers arrive.  Clear the timer here so the
      // 8000-row JSON body cannot be aborted by the 15s header budget.  The
      // caller deadline (parent signal) still covers the body read.
      const response = await withProviderLimit(service, () =>
        fetchWithRetry(
          url,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: { ...NASDAQ_SCREENER_HEADERS }
          },
          { service, retries: 1 }
        ),
        url
      );
      clearTimeout(timeout);
      unlink();
      return response;
    } catch (error) {
      const reason = controller.signal.reason;
      lastError = reason instanceof Error ? reason : error;
      if (parent?.aborted) {
        throw errorFromSignal(parent, "Nasdaq screener aborted.");
      }
      if (!isScreenerTimeout(error, reason) || attempt === NASDAQ_SCREENER_ATTEMPTS - 1) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(NASDAQ_SCREENER_TIMEOUT_MESSAGE);
}

/** Read the screener JSON.  A caller deadline aborts the wait; it does not become an empty table. */
export async function readNasdaqScreenerJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const body = response.json();
  // If the deadline wins the race, the body promise can still reject later.
  void body.catch(() => {});
  if (!signal) return body;
  if (signal.aborted) throw errorFromSignal(signal, "Nasdaq screener body aborted.");
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(errorFromSignal(signal, "Nasdaq screener body aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    body.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
