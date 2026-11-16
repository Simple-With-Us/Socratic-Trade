import crypto from "crypto";
import { audit } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";

export type RecoverableIssueSeverity = "warn" | "error";

export interface RecoverableIssueInput {
  source: "broker" | "market-data" | "llm" | "dashboard" | "system" | string;
  operation: string;
  message: string;
  fallback: string;
  severity?: RecoverableIssueSeverity;
  userId?: string;
  connectedAccountId?: string;
  broker?: string;
  accountNumber?: string;
  details?: Record<string, unknown>;
  throttleMs?: number;
}

interface RecoverableIssueThrottleState {
  lastAuditedAt: string;
  suppressed: number;
}

const DEFAULT_THROTTLE_MS = 5 * 60 * 1000;
const SETTING_PREFIX = "recoverable_issue";

export function messageFromUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function recordRecoverableIssue(input: RecoverableIssueInput): void {
  try {
    const now = new Date();
    const throttleMs = input.throttleMs ?? DEFAULT_THROTTLE_MS;
    const key = `${SETTING_PREFIX}:${input.userId ?? "local"}:${hashIssueKey(input)}`;
    const previous = getInternalSetting<RecoverableIssueThrottleState>(key);
    const previousMs = previous ? Date.parse(previous.lastAuditedAt) : Number.NaN;
    if (previous && Number.isFinite(previousMs) && now.getTime() - previousMs < throttleMs) {
      setInternalSetting(key, { ...previous, suppressed: (previous.suppressed ?? 0) + 1 });
      return;
    }

    audit(
      "recoverable_issue",
      {
        source: input.source,
        operation: input.operation,
        severity: input.severity ?? "warn",
        message: input.message,
        fallback: input.fallback,
        broker: input.broker,
        accountNumber: input.accountNumber,
        details: input.details,
        suppressedSinceLastAudit: previous?.suppressed ?? 0
      },
      input.userId ?? "local",
      input.connectedAccountId
    );
    setInternalSetting(key, { lastAuditedAt: now.toISOString(), suppressed: 0 });
  } catch (error) {
    console.warn("[recoverable-issue] failed to record audit event:", messageFromUnknownError(error));
  }
}

function hashIssueKey(input: RecoverableIssueInput): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        source: input.source,
        operation: input.operation,
        broker: input.broker,
        accountNumber: input.accountNumber,
        connectedAccountId: input.connectedAccountId,
        fallback: input.fallback
      })
    )
    .digest("hex")
    .slice(0, 16);
}
