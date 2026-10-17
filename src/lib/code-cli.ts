import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isPrimaryEmail, userIdForEmail } from "./auth/identity";

/** Private, text-only broker contract. This module never reads CLI credentials or spawns a process. */
export const CODE_CLI_PREFIX = "code-cli://";
export type CodeCliService = "meta" | "minimax";

/** A capability the route never enables: the field must be absent, null or false. */
const Disabled = z.union([z.undefined(), z.null(), z.literal(false)]).optional();

const CodeCliMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
  tool_calls: Disabled,
  function_call: Disabled
});

/** Inbound OpenAI-style body.  Deliberately not .strict(): ST callers also send sampling fields such
 *  as temperature (red-team.ts), and the broker payload below is rebuilt from an allowlist, so no
 *  unknown key ever crosses to the broker. */
const CodeCliRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.unknown()).min(1).max(100),
  stream: Disabled,
  tools: Disabled,
  functions: Disabled,
  max_tokens: z.number().nullish(),
  max_completion_tokens: z.number().nullish(),
  response_format: z.unknown().optional()
});

/** Broker response contract v1 (docs/llm/code-cli-broker.md).  Only text and finishReason are
 *  forwarded into the completion ST builds below, so any other broker field is dropped here. */
const CodeCliBrokerResponseSchema = z.object({
  version: z.literal(1),
  text: z.string().refine((text) => text.trim().length > 0),
  finishReason: z.enum(["stop", "length"])
});

export function codeCliOwner(userId: string | undefined): boolean {
  const owner = process.env.CODE_CLI_OWNER_USER_ID?.trim();
  const email = process.env.CODE_CLI_OWNER_EMAIL?.trim().toLowerCase();
  return !!email && isPrimaryEmail(email) && userIdForEmail(email) === owner && process.env.CODE_CLI_ENABLED === "true" && !!owner && userId === owner
    && !!process.env.CODE_CLI_OWNER_EMAIL?.trim();
}

export function codeCliReady(userId: string | undefined): boolean {
  if (!codeCliOwner(userId) || !process.env.CODE_CLI_BROKER_TOKEN?.trim()) return false;
  try {
    const url = new URL(process.env.CODE_CLI_BROKER_URL ?? "");
    // No credentials/query/fragment in a broker URL. Deployment must restrict egress to this origin.
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function codeCliUrl(service: CodeCliService, userId: string): string {
  if (!codeCliReady(userId)) throw new Error("Code CLI is disabled or not configured for this owner");
  return `${CODE_CLI_PREFIX}${service}/${encodeURIComponent(userId)}`;
}

/** Called at the shared HTTP boundary, including scheduled and capturing calls. No paid fallback. */
export async function fetchCodeCli(url: string, init: RequestInit): Promise<Response> {
  if (init.signal?.aborted) throw new Error("Code CLI request cancelled");
  const route = new URL(url);
  const service = route.hostname;
  const userId = decodeURIComponent(route.pathname.slice(1));
  if ((service !== "meta" && service !== "minimax") || !codeCliReady(userId)) {
    throw new Error("Code CLI execution denied");
  }
  if (init.method !== "POST" || typeof init.body !== "string") throw new Error("Code CLI requires a text request");
  if (Buffer.byteLength(init.body, "utf8") > 1_000_000) throw new Error("Code CLI request exceeds text limit");
  let raw: unknown;
  try { raw = JSON.parse(init.body); } catch { throw new Error("Code CLI requires a JSON request body"); }
  const parsedBody = CodeCliRequestSchema.safeParse(raw);
  if (!parsedBody.success) throw new Error("Code CLI is text-only: streaming and tools are disabled");
  const body = parsedBody.data;
  const parsedMessages = z.array(CodeCliMessageSchema).safeParse(body.messages);
  if (!parsedMessages.success) throw new Error("Code CLI accepts only plain text messages");
  const messages = parsedMessages.data;
  const model = body.model ?? "";
  if (!(service === "meta" ? /^muse-spark-/i.test(model) : /^minimax-/i.test(model))) {
    throw new Error("Model is not supported by this Code CLI adapter");
  }
  // Explicit reconstruction: no caller headers, API keys, tools, paths or extra body fields cross.
  const response = await fetch(process.env.CODE_CLI_BROKER_URL!, {
    method: "POST", redirect: "error", signal: init.signal ?? AbortSignal.timeout(150_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.CODE_CLI_BROKER_TOKEN}` },
    body: JSON.stringify({ version: 1, requestId: randomUUID(), ownerUserId: userId, adapter: service === "meta" ? "muse" : "minimax",
      model, messages: messages.map(({ role, content }) => ({ role, content })),
      maxOutputTokens: Math.min(16000, Math.max(1, Number(body.max_tokens ?? body.max_completion_tokens) || 1500)),
      responseFormat: body.response_format, capabilities: { tools: false, terminal: false, files: false, mcp: false } })
  });
  // Never forward broker error bodies or session/credential metadata into model telemetry.
  if (!response.ok) throw new Error(`Code CLI broker failed (${response.status}); no API fallback`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid Code CLI broker response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) { await reader.cancel(); throw new Error("Code CLI response exceeds text limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const responseText = Buffer.concat(chunks).toString("utf8");
  let rawResult: unknown;
  try { rawResult = JSON.parse(responseText); } catch { throw new Error("Invalid Code CLI broker response"); }
  const parsedResult = CodeCliBrokerResponseSchema.safeParse(rawResult);
  if (!parsedResult.success) throw new Error("Invalid Code CLI broker response");
  const result = parsedResult.data;
  return Response.json({ choices: [{ message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }] });
}
