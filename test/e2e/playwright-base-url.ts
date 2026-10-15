/** Same origin as playwright.config.ts, including a PLAYWRIGHT_PORT override. */
export function playwrightBaseURL(
  baseURL: string | undefined = process.env.PLAYWRIGHT_BASE_URL,
  port: string | undefined = process.env.PLAYWRIGHT_PORT
): string {
  if (baseURL) return baseURL;
  return `http://127.0.0.1:${Number(port || 4201)}`;
}
