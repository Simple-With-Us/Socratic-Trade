// SiliconFlow runs two separate platforms with independent accounts and keys:
// api.siliconflow.com (international) and api.siliconflow.cn (China).  A key
// from one returns 401 "Invalid token" on the other.  The fleet's key is
// international, so that host is the default; override via SILICONFLOW_BASE_URL
// if a China-platform key is ever used.
const DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.com";

export function siliconflowBaseUrl(): string {
  const raw = process.env.SILICONFLOW_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_SILICONFLOW_BASE_URL;
  return base.replace(/\/+$/, "");
}
