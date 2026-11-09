// In-process chat-turn cancellation registry. Duplicate turn keys 409.
// Follows the globalThis singleton pattern used by events.ts / scan-singleflight.

export interface ChatTurnHandle {
  turnKey: string;
  userId: string;
  controller: AbortController;
  startedAt: number;
}

const REGISTRY_KEY = "__socraticChatTurnRegistry" as const;

type RegistryStore = Map<string, ChatTurnHandle>;

function store(): RegistryStore {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryStore };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

export function registerChatTurn(input: { turnKey: string; userId: string }): ChatTurnHandle {
  const existing = store().get(input.turnKey);
  if (existing && !existing.controller.signal.aborted) {
    const err = new Error("chat_turn_in_flight") as Error & { status: number };
    err.status = 409;
    throw err;
  }
  const handle: ChatTurnHandle = {
    turnKey: input.turnKey,
    userId: input.userId,
    controller: new AbortController(),
    startedAt: Date.now()
  };
  store().set(input.turnKey, handle);
  return handle;
}

export function cancelChatTurn(turnKey: string, userId?: string): boolean {
  const handle = store().get(turnKey);
  if (!handle) return false;
  if (userId && handle.userId !== userId) return false;
  handle.controller.abort();
  return true;
}

export function releaseChatTurn(turnKey: string): void {
  store().delete(turnKey);
}

export function getChatTurn(turnKey: string): ChatTurnHandle | undefined {
  return store().get(turnKey);
}
