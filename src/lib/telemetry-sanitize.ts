const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|encryption[_-]?key|password|secret|session|token|webhook[_-]?url|account[_-]?number)/i;
const SECRET_VALUE =
  /\b(?:Bearer\s+)?(?:sk|pk|rk|ghp|gho|ghs|xox[baprs]?|rh|mcp|pc|voyage|fred|finnhub|tradier|marketstack|massive)[A-Za-z0-9._:-]{12,}\b/g;
const HEX_SECRET = /\b[A-Fa-f0-9]{48,}\b/g;

type RedactionOptions = {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
};

const DEFAULT_REDACTION: Required<RedactionOptions> = {
  maxDepth: 6,
  maxArrayItems: 20,
  maxObjectKeys: 60,
  maxStringLength: 1000
};

export function redactForTelemetry(value: unknown, options: RedactionOptions = {}): unknown {
  const limits = { ...DEFAULT_REDACTION, ...options };
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number, keyHint?: string): unknown {
    if (keyHint && SENSITIVE_KEY.test(keyHint)) return "[redacted]";
    if (current === null || current === undefined) return current;

    if (typeof current === "string") return redactString(current, limits.maxStringLength);
    if (typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "function" || typeof current === "symbol") return `[${typeof current}]`;

    if (current instanceof Date) return current.toISOString();
    if (depth >= limits.maxDepth) return "[redacted:depth-limit]";

    if (Array.isArray(current)) {
      const mapped = current.slice(0, limits.maxArrayItems).map((item) => visit(item, depth + 1));
      if (current.length > limits.maxArrayItems) mapped.push(`[truncated:${current.length - limits.maxArrayItems}]`);
      return mapped;
    }

    if (typeof current === "object") {
      if (seen.has(current)) return "[redacted:circular]";
      seen.add(current);

      const entries = Object.entries(current as Record<string, unknown>).slice(0, limits.maxObjectKeys);
      const output: Record<string, unknown> = {};
      for (const [key, item] of entries) {
        output[key] = visit(item, depth + 1, key);
      }
      const keyCount = Object.keys(current as Record<string, unknown>).length;
      if (keyCount > limits.maxObjectKeys) output.__truncatedKeys = keyCount - limits.maxObjectKeys;
      return output;
    }

    return "[redacted:unknown]";
  }

  return visit(value, 0);
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message, 500);
  if (typeof error === "string") return redactString(error, 500);
  return "Unknown error";
}

export function summarizeOpenAiRequest(body: unknown): Record<string, unknown> {
  if (process.env.LANGFUSE_CAPTURE_IO === "full") {
    return {
      captureMode: "full-redacted",
      body: redactForTelemetry(body, { maxDepth: 8, maxStringLength: 3000 })
    };
  }

  const record = isRecord(body) ? body : {};
  const messages = Array.isArray(record.messages) ? record.messages : undefined;
  const input = Array.isArray(record.input) ? record.input : undefined;
  const textRecord = isRecord(record.text) ? record.text : undefined;
  const items = messages ?? input ?? [];
  const roleStats = summarizeMessageRoles(items);

  return {
    captureMode: "summary",
    model: typeof record.model === "string" ? record.model : undefined,
    transport: messages ? "chat-completions" : input ? "responses" : "unknown",
    itemCount: items.length,
    textChars: roleStats.textChars,
    systemChars: roleStats.systemChars,
    userChars: roleStats.userChars,
    responseFormat: Boolean(record.response_format || textRecord?.format),
    jsonSchemaName: schemaName(record)
  };
}

export function summarizeOpenAiResponseText(text: string | undefined): Record<string, unknown> {
  if (process.env.LANGFUSE_CAPTURE_IO === "full") {
    return {
      captureMode: "full-redacted",
      text: redactString(text ?? "", 3000)
    };
  }
  return {
    captureMode: "summary",
    textChars: text?.length ?? 0,
    jsonLike: text ? /^[\s\r\n]*[\[{]/.test(text) : false
  };
}

export function summarizeTradeProposals(proposals: unknown): Record<string, unknown> {
  if (!Array.isArray(proposals)) return { proposalCount: 0 };
  return {
    proposalCount: proposals.length,
    proposals: proposals.slice(0, 10).map((proposal) => {
      const record = isRecord(proposal) ? proposal : {};
      return {
        symbol: typeof record.symbol === "string" ? record.symbol : undefined,
        side: typeof record.side === "string" ? record.side : undefined,
        type: typeof record.type === "string" ? record.type : undefined,
        thesis: typeof record.tradeThesisTag === "string" ? record.tradeThesisTag : undefined,
        confidenceScore: typeof record.confidenceScore === "number" ? record.confidenceScore : undefined,
        hasQuantity: typeof record.quantity === "number",
        hasDollarAmount: typeof record.dollarAmount === "number"
      };
    })
  };
}

function redactString(value: string, maxLength: number): string {
  const redacted = value.replace(SECRET_VALUE, "[redacted]").replace(HEX_SECRET, "[redacted]");
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...[truncated:${redacted.length - maxLength}]` : redacted;
}

function summarizeMessageRoles(items: unknown[]): { textChars: number; systemChars: number; userChars: number } {
  let textChars = 0;
  let systemChars = 0;
  let userChars = 0;

  for (const item of items) {
    if (!isRecord(item)) continue;
    const role = typeof item.role === "string" ? item.role : "unknown";
    const chars = contentLength(item.content);
    textChars += chars;
    if (role === "system") systemChars += chars;
    if (role === "user") userChars += chars;
  }

  return { textChars, systemChars, userChars };
}

function contentLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentLength(isRecord(item) ? item.text ?? item.content : item), 0);
  if (isRecord(value)) return JSON.stringify(redactForTelemetry(value)).length;
  return 0;
}

function schemaName(record: Record<string, unknown>): string | undefined {
  const responseFormat = isRecord(record.response_format) ? record.response_format : undefined;
  const jsonSchema = isRecord(responseFormat?.json_schema) ? responseFormat.json_schema : undefined;
  if (typeof jsonSchema?.name === "string") return jsonSchema.name;

  const text = isRecord(record.text) ? record.text : undefined;
  const format = isRecord(text?.format) ? text.format : undefined;
  return typeof format?.name === "string" ? format.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
