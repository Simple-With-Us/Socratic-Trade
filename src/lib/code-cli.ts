import { randomUUID } from "node:crypto";
import { isPrimaryEmail, userIdForEmail } from "./auth/identity";

/** Private, text-only broker contract. This module never reads CLI credentials or spawns a process. */
export const CODE_CLI_PREFIX = "code-cli://";
export type CodeCliService = "meta" | "minimax";

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
  let body: Record<string, unknown>;
  try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { throw new Error("Code CLI requires a JSON request body"); }
  const messages = body.messages;
  if (body.stream || body.tools || body.functions || !Array.isArray(messages) || !messages.length || messages.length > 100) {
    throw new Error("Code CLI is text-only: streaming and tools are disabled");
  }
  for (const message of messages) {
    if (!message || typeof message !== "object" || !["system", "user", "assistant"].includes(message.role)
      || typeof message.content !== "string" || message.tool_calls || message.function_call) {
      throw new Error("Code CLI accepts only plain text messages");
    }
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (!(service === "meta" ? /^muse-spark-/i.test(model) : /^minimax-/i.test(model))) {
    throw new Error("Model is not supported by this Code CLI adapter");
  }
  // Explicit reconstruction: no caller headers, API keys, tools, paths or extra body fields cross.
  const response = await fetch(process.env.CODE_CLI_BROKER_URL!, {
    method: "POST", redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
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
  let result: { version?: unknown; text?: unknown; finishReason?: unknown };
  try { result = JSON.parse(responseText); } catch { throw new Error("Invalid Code CLI broker response"); }
  if (result.version !== 1 || typeof result.text !== "string" || !result.text.trim()
    || !["stop", "length"].includes(String(result.finishReason))) throw new Error("Invalid Code CLI broker response");
  return Response.json({ choices: [{ message: { role: "assistant", content: result.text }, finish_reason: result.finishReason }] });
}
