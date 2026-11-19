/**
 * ST-4636: a connectivity streak halts only after BROKER_CONNECTIVITY_HALT_STREAK failures that
 * also span BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS.  Tests that drive three failures back to back
 * call this first, so the streak reads as having started that long ago, the way production ticks
 * minutes apart would.
 */
export async function backdateConnectivityStreak(userId: string, accountScope: string): Promise<void> {
  const { brokerConnectivityStreakSinceKey, BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS } = await import("../../src/lib/broker-health");
  const { setInternalSetting } = await import("../../src/lib/db");
  setInternalSetting(
    brokerConnectivityStreakSinceKey(userId, accountScope),
    new Date(Date.now() - BROKER_CONNECTIVITY_HALT_MIN_SPAN_MS - 1_000).toISOString()
  );
}
