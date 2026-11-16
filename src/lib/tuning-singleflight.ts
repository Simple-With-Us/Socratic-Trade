import { operationInFlightResponse } from "./operation-guard-response";

export type TuningOperation = "strategy-tune" | "tuning-dry-run";

type TuningFlight = { operation: TuningOperation; token: symbol };
type TuningFlightHost = typeof globalThis & {
  __socraticTuningInFlight?: Map<string, TuningFlight>;
};

const host = globalThis as TuningFlightHost;
const inFlight = (host.__socraticTuningInFlight ??= new Map<string, TuningFlight>());

function conflictResponse(operation: TuningOperation, activeOperation: TuningOperation): Response {
  return operationInFlightResponse(
    operation,
    activeOperation,
    operation === "strategy-tune"
      ? "strategy_tuning_in_progress"
      : "A strategy tuning review is already in progress.",
    { message: "A strategy tuning review is already in progress." }
  );
}

/**
 * One tuning LLM/OOS review per stable user identity across both the public tune route and the
 * admin dry-run route. The owner token prevents an old callback from releasing a successor claim.
 */
export async function withTuningSingleFlight(
  userId: string,
  operation: TuningOperation,
  run: () => Promise<Response>
): Promise<Response> {
  const active = inFlight.get(userId);
  if (active) return conflictResponse(operation, active.operation);

  const token = Symbol(operation);
  inFlight.set(userId, { operation, token });
  try {
    return await run();
  } finally {
    if (inFlight.get(userId)?.token === token) inFlight.delete(userId);
  }
}

/** Test/maintenance hook. */
export function resetTuningSingleFlight(): void {
  inFlight.clear();
}
