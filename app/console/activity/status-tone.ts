import type { ChipTone } from "../ui/primitives";

const STATUS_TONE: Record<string, ChipTone> = {
  placed: "pos",
  filled: "pos",
  paper: "pos",
  completed: "pos",
  proposed: "accent",
  pending: "accent",
  blocked: "warn",
  withdrawn: "muted",
  expired: "muted",
  rejected: "muted",
  rejected_by_broker: "neg",
  placing_failed: "neg",
  pending_reconciliation: "warn",
  unreconcilable: "muted",
  failed: "neg",
  sent: "pos",
  skipped: "warn",
  skipped_budget: "warn",
  skipped_market_closed: "warn",
  skipped_broker_unhealthy: "warn"
};

export function activityStatusTone(status: string | undefined): ChipTone {
  if (!status) return "muted";
  return STATUS_TONE[status.toLowerCase()] ?? "muted";
}
