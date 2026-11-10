const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|cookie|credential|encryption[_-]?key|password|secret|session|token|webhook[_-]?url|account[_-]?number)/i;
const SECRET_VALUE =
  /\b(?:Bearer\s+)?(?:sk|pk|rk|ghp|gho|ghs|xox[baprs]?|rh|mcp|pc|voyage|fred|finnhub|tradier|marketstack|massive)[A-Za-z0-9._:-]{12,}\b/g;
const HEX_SECRET = /\b[A-Fa-f0-9]{48,}\b/g;

// Query-param names that must be redacted in addition to whatever SENSITIVE_KEY
// already catches. These are either trading-specific identifiers that are not
// "secrets" in the SENSITIVE_KEY sense (symbol/proposal/account/code) or legacy
// bare aliases ("key", "auth") that predate SENSITIVE_KEY's compound patterns
// (api[_-]?key etc). Exact-match only -- SENSITIVE_KEY already does the
// substring-style matching for anything provider-key-shaped, e.g. a query param
// literally named "apikey" (no separator) matches api[_-]?key's optional
// separator, so it's covered without listing every provider's naming style here.
const SENSITIVE_QUERY_PARAM_NAME = /^(?:symbol|proposal|account|code|auth|key)$/i;

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

// Parses actual query-param names (rather than matching a fixed alternation
// literal) and redacts any whose decoded name matches SENSITIVE_KEY or the
// trading-specific SENSITIVE_QUERY_PARAM_NAME list above. This fixed a real gap:
// the previous implementation matched "api_key" exactly but not "apikey" (no
// separator), which is what this app's actual providers use (Alpha Vantage,
// Twelve Data, ROIC -- see src/lib/history.ts's `?apikey=`), so provider keys
// were leaking into Sentry unredacted. Parsing param names against the shared
// sensitive-key list means a future provider using a differently-shaped key
// param name (as long as it still reads as "...key..."/"...token..."/etc, or is
// one of the exact trading-identifier names above) is covered automatically.
export function sanitizeTelemetryUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;

  const hashIndex = rawUrl.indexOf("#");
  const withoutHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex);
  // A fragment can carry params too (OAuth implicit flow puts access_token
  // there), so a key=value fragment gets the same per-param redaction.
  const rawHash = hashIndex === -1 ? "" : rawUrl.slice(hashIndex + 1);
  const hash = hashIndex === -1 ? "" : `#${rawHash.includes("=") ? redactParams(rawHash) : rawHash}`;

  const queryIndex = withoutHash.indexOf("?");
  if (queryIndex === -1) return `${withoutHash}${hash}`;

  const base = withoutHash.slice(0, queryIndex);
  const query = withoutHash.slice(queryIndex + 1);
  if (!query) return `${withoutHash}${hash}`;

  return `${base}?${redactParams(query)}${hash}`;
}

// Any param whose name ends in a key segment (access_key, x-key, accessKey)
// is a credential slot too; SENSITIVE_KEY alone only knows api/encryption keys.
// camelCase is matched case-sensitively so words like "monkey" stay readable.
const KEY_SUFFIXED_PARAM_NAME = /(?:^|[_.-])key$/i;
const KEY_CAMEL_SUFFIXED_PARAM_NAME = /[a-z0-9]Key$/;

function redactParams(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      if (!pair) return pair;
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) return pair; // bare flag, no value to redact

      const rawName = pair.slice(0, eqIndex);
      let decodedName = rawName;
      try {
        decodedName = decodeURIComponent(rawName.replace(/\+/g, " "));
      } catch {
        // malformed percent-encoding in the param name: fall back to the raw form
      }

      const isSensitive =
        SENSITIVE_KEY.test(decodedName) ||
        SENSITIVE_QUERY_PARAM_NAME.test(decodedName) ||
        KEY_SUFFIXED_PARAM_NAME.test(decodedName) ||
        KEY_CAMEL_SUFFIXED_PARAM_NAME.test(decodedName);
      return isSensitive ? `${rawName}=[REDACTED]` : pair;
    })
    .join("&");
}

const URL_IN_TEXT = /(?:https?:\/\/|\/)[^\s"'<>]*\?[^\s"'<>]*/g;

type TransactionLike = {
  request?: { url?: unknown; query_string?: unknown; headers?: unknown; cookies?: unknown; data?: unknown };
  spans?: Array<{ description?: unknown; data?: Record<string, unknown> } | null | undefined>;
};

/**
 * Transaction events cannot go through redactForTelemetry whole: its array and
 * depth limits would truncate the span list and replace spans with strings,
 * which breaks the trace.  So the request and the URL-bearing span fields are
 * redacted in place and the span structure is left intact.
 */
export function sanitizeTransactionEvent<T>(event: T): T {
  const e = event as unknown as TransactionLike;
  if (e && typeof e === "object") {
    const req = e.request;
    if (req && typeof req === "object") {
      if (typeof req.url === "string") req.url = sanitizeTelemetryUrl(req.url);
      if (typeof req.query_string === "string" && req.query_string) {
        req.query_string = redactParams(req.query_string.replace(/^\?/, ""));
      } else if (req.query_string !== undefined) {
        req.query_string = redactForTelemetry(req.query_string);
      }
      if (req.headers !== undefined) req.headers = redactForTelemetry(req.headers);
      if (req.cookies !== undefined) req.cookies = "[redacted]";
      if (req.data !== undefined) req.data = redactForTelemetry(req.data);
    }
    if (Array.isArray(e.spans)) {
      for (const span of e.spans) {
        if (!span || typeof span !== "object") continue;
        if (typeof span.description === "string") {
          span.description = span.description.replace(URL_IN_TEXT, (m) => sanitizeTelemetryUrl(m));
        }
        const data = span.data;
        if (data && typeof data === "object") {
          for (const k of ["url", "http.url", "http.query", "http.fragment"]) {
            const v = data[k];
            if (typeof v !== "string") continue;
            data[k] = k === "http.query" || k === "http.fragment" ? redactParams(v.replace(/^[?#]/, "")) : sanitizeTelemetryUrl(v);
          }
        }
      }
    }
  }
  return event;
}
