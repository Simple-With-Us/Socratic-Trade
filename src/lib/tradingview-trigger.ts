/**
 * Bridge from the TradingView webhook route into the event-driven decision-trigger engine.
 *
 * Lives in its own module (not in the route file) because a Next.js `route.ts` may only export
 * route handlers — any other export fails the production build. Callers in the POST handler use
 * `void submitTriggerEvent(...)` to stay non-blocking; tests await it directly.
 *
 * The `triggers` module is imported dynamically (mirroring src/lib/web-sources/sec8k.ts) both to
 * avoid a circular import and so vitest's module-mock system can reliably intercept the call. The
 * engine's own gate (TRIGGER_ENGINE) decides whether the event actually starts a run, plus the
 * engine's dedup/cooldown/cap rules — this helper just hands the event off. Defensive catch keeps a
 * trigger-engine failure from ever rolling back the webhook's signal-cache write.
 */
export async function submitTriggerEvent(symbol: string, sourceId: string): Promise<void> {
  try {
    const { broadcastMaterialEvent } = await import("@/lib/triggers");
    broadcastMaterialEvent({ type: "technical", symbol, sourceId, reason: "TradingView alert" });
  } catch {
    // trigger engine unavailable — webhook durability unaffected
  }
}
