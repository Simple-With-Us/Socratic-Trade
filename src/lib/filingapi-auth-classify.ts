/** Client-safe classifiers for FilingAPI auth failures. No node:crypto. */

export function isFilingApiAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function isFilingApiAuthErrorText(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  return (
    /\bHTTP 401\b/i.test(errorText) ||
    /\bHTTP 403\b/i.test(errorText) ||
    /\bunauthorized\b/i.test(errorText) ||
    /\binvalid api key\b/i.test(errorText) ||
    /\binvalid_api_key\b/i.test(errorText)
  );
}
