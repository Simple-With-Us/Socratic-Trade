// apps/bff/src/orchestrator.mjs
// Per-turn flow:
//   1. Ingest the message into memory via the salience policy (what to remember).
//   2. Assemble context (hard constraints always; recent preferences) into the system prompt.
//   3. Run the provider's tool loop — the model can call read-only / draft tools only,
//      through an executeTool callback that validates, executes, and audits.
//   4. Return { text, draft?, citations, used_memories } — never executes a trade.

import { audit } from './audit.mjs';
import { getLLM, classifyIntent } from './llm/client.mjs';
import { buildSystem, PROMPT_VERSION } from './llm/prompt.mjs';
import { buildTools } from './tools/index.mjs';
import { ingestMessage, retrieve } from './memory/store.mjs';
import { appendTurn } from './history/store.mjs';

export function makeOrchestrator({ marketData, llm } = {}) {
  const model = llm ?? getLLM();
  const tools = buildTools({ marketData });
  const toolSchemas = Object.entries(tools).map(([name, t]) => ({
    name, description: t.description, input_schema: t.input_schema,
  }));

  return async function handleTurn({ userId, message }) {
    audit('chat.turn', { user_id: userId, message_len: message.length, prompt_version: PROMPT_VERSION });
    appendTurn(userId, { role: 'user', text: message });

    // 1. Memory write decision.
    const mem = ingestMessage(userId, message);

    // 2. Context assembly (constraints always included; surfaced first).
    const memories = retrieve(userId);
    const memorySummary = memories.map((m) => `- ${m.hard ? '[HARD] ' : ''}${m.subject}: ${m.value}`).join('\n');

    // 3. Provider-agnostic tool loop. executeTool is the only path to a tool, and it has
    //    no execution capability — draft_order returns a ticket, never a fill.
    const executeTool = async (name, input) => {
      const tool = tools[name];
      if (!tool) return { error: 'UNKNOWN_TOOL', name };
      audit('tool.call', { user_id: userId, tool: name });
      return tool.execute(input, { userId, marketData });
    };

    const result = await model.run({
      system: buildSystem(memorySummary),
      message,
      tools: toolSchemas,
      executeTool,
      context: { memorySummary },
    });

    // 4. Extract a draft (if any) for the UI; the assistant never executes.
    const draftCall = result.toolCalls?.find((c) => c.name === 'draft_order' && c.result && !c.result.error);
    const draft = draftCall ? draftCall.result : null;

    const reply = {
      text: result.text,
      draft,
      citations: result.citations ?? [],
      memory: { written: mem.written, held: mem.held },
      used_memories: memories.map((m) => ({ subject: m.subject, value: m.value, hard: m.hard })),
      intent: classifyIntent(message).intent,
      prompt_version: PROMPT_VERSION,
    };
    appendTurn(userId, { role: 'assistant', text: reply.text, citations: reply.citations, intent: reply.intent });

    audit('chat.reply', { user_id: userId, has_draft: !!draft, citations: result.citations?.length ?? 0 });
    return reply;
  };
}
