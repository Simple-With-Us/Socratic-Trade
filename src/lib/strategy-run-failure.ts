/**
 * Plain-English failure copy for strategy runs.
 *
 * Activity (Alerts Center, Strategy Runs, Audit Log, Notifications) must show
 * WHY a run failed, not the delivery chip ("Sent") and not a JSON blob.
 * Two spaces between sentences.  Never dump raw JSON as the primary explanation.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/** Collapse whitespace, keep sentence gaps as two spaces. */
function tidyProse(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\.\s+/g, ".  ")
    .replace(/\?\s+/g, "?  ")
    .replace(/!\s+/g, "!  ")
    .trim();
}

type FailurePattern = { test: (text: string) => boolean; copy: string };

const FAILURE_PATTERNS: FailurePattern[] = [
  {
    test: (t) => t.includes("gather timeout") || t.includes("gather timed out") || t.includes("market scan timeout"),
    copy: "This strategy run stopped because gathering market data took too long.  The next run will try again."
  },
  {
    test: (t) =>
      t.includes("credits exhausted") ||
      t.includes("credit balance") ||
      t.includes("insufficient credits") ||
      t.includes("402") && t.includes("credit"),
    copy: "This strategy run stopped because the language-model account is out of credits."
  },
  {
    test: (t) =>
      t.includes("spend ceiling") ||
      t.includes("usage budget") ||
      t.includes("llm/rag") ||
      t.includes("budget skip") ||
      (t.includes("budget") && (t.includes("exceed") || t.includes("exhaust") || t.includes("limit"))),
    copy: "This strategy run stopped because the language-model budget was exhausted."
  },
  {
    test: (t) => t.includes("market is closed") || t.includes("market closed") || t.includes("holiday or weekend"),
    copy: "This strategy run did not evaluate names because the market was closed."
  },
  {
    test: (t) => t.includes("broker unhealthy") || t.includes("broker health") || t.includes("broker is unhealthy"),
    copy: "This strategy run did not evaluate names because the broker connection was unhealthy."
  },
  {
    test: (t) => t.includes("unfunded") || t.includes("buying power"),
    copy: "This strategy run could not place orders because the account has no buying power."
  },
  {
    test: (t) => t.includes("declined") || t.includes("rejected by broker") || t.includes("order rejected"),
    copy: "The broker declined an order during this strategy run."
  },
  {
    test: (t) => t.includes("not_placed") || t.includes("not placed") || t.includes("placement failed"),
    copy: "An order from this strategy run was not placed at the broker."
  },
  {
    test: (t) => t.includes("stale-run") || t.includes("stale run") || t.includes("sweep"),
    copy: "This strategy run was closed because it was still marked running after the process restarted."
  },
  {
    test: (t) => t.includes("abort") && t.includes("timeout"),
    copy: "This strategy run stopped because a step hit its time limit and was aborted."
  },
  {
    test: (t) => t.includes("rate limit") || t.includes("429") || t.includes("too many requests"),
    copy: "This strategy run stopped because a provider rate-limited the request.  The next run will try again."
  },
  {
    test: (t) => t.includes("api key") || t.includes("unauthorized") || t.includes("401") || t.includes("invalid key"),
    copy: "This strategy run stopped because a provider key was missing or rejected."
  }
];

/**
 * Turn a stored summary / error / payload reason into a wrapping English
 * paragraph.  Returns null when there is nothing useful to say.
 */
export function humanizeFailureText(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text || looksLikeJson(text)) return null;
  const lower = text.toLowerCase();
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.test(lower)) return pattern.copy;
  }
  if (text.length > 400) return `${tidyProse(text.slice(0, 380))}…`;
  return tidyProse(text);
}

export function payloadFailureSource(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const nestedError = asRecord(record.error);
  return (
    stringValue(record.summary) ||
    stringValue(record.reason) ||
    stringValue(record.error) ||
    stringValue(record.errorText) ||
    stringValue(record.detail) ||
    stringValue(record.message) ||
    stringValue(nestedError.message) ||
    stringValue(record.reconcile)
  );
}

/** Failure paragraph for a persisted strategy_runs row. */
export function plainEnglishRunFailure(input: {
  status?: string | null;
  summary?: string | null;
  payload?: unknown;
}): string | null {
  const fromPayload = humanizeFailureText(payloadFailureSource(input.payload));
  if (fromPayload) return fromPayload;
  const fromSummary = humanizeFailureText(input.summary);
  if (fromSummary) return fromSummary;
  if (input.status === "failed") {
    return "This strategy run failed.  Open Run Details for the recorded diagnostics.";
  }
  return null;
}

const PAYLOAD_REASON_TYPES = new Set([
  "run_failed",
  "kill_switch",
  "provider_degraded",
  "budget_alert",
  "storage_warning",
  "protective_exit_failing",
  "earningscalls_entitlement_blocked",
  "autonomy_halted_on_boot",
  "risk_advisory"
]);

/** Prefer the event's own reason over the delivery-status chip ("Sent").
 *  Returns null when the payload has no reason so delivery-status copy still
 *  explains skipped/failed sends. */
export function notificationFailureDetail(input: {
  type?: string | null;
  payload?: unknown;
  title?: string | null;
}): string | null {
  if (!input.type || !PAYLOAD_REASON_TYPES.has(input.type)) return null;
  const fromPayload = humanizeFailureText(payloadFailureSource(input.payload));
  if (fromPayload) return fromPayload;
  if (input.type === "run_failed") {
    const fromTitle = humanizeFailureText(input.title);
    if (
      fromTitle &&
      fromTitle.toLowerCase() !== "strategy run failed" &&
      fromTitle.toLowerCase() !== "run failed"
    ) {
      return fromTitle;
    }
  }
  return null;
}
