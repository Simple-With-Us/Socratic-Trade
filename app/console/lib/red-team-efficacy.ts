import type { RedTeamEfficacy } from "@/lib/performance";

export const RED_TEAM_EFFICACY_MIN_RESOLVED = 20;
export const RED_TEAM_EFFICACY_SOLID_RESOLVED = 50;
export const RED_TEAM_UNATTRIBUTED_MODEL = "unattributed";

export type RedTeamSampleTier = "hidden" | "caution" | "ready";
export type RedTeamReturnTone = "pos" | "neg" | "muted";

export interface RedTeamModelRow {
  model: string;
  maturedVetoes: number;
  vetoValueAddRate: number;
  survivorRiskHitRate: number;
  avgReturnPct: number;
}

export function redTeamSampleTier(resolvedVetoes: number): RedTeamSampleTier {
  if (resolvedVetoes < RED_TEAM_EFFICACY_MIN_RESOLVED) return "hidden";
  if (resolvedVetoes < RED_TEAM_EFFICACY_SOLID_RESOLVED) return "caution";
  return "ready";
}

export function redTeamSampleGate(resolvedVetoes: number): string {
  const tier = redTeamSampleTier(resolvedVetoes);
  if (tier === "ready") return `resolved n=${resolvedVetoes}`;
  if (tier === "caution") return `small sample (n=${resolvedVetoes})`;
  return `needs >=${RED_TEAM_EFFICACY_MIN_RESOLVED} resolved vetoes (n=${resolvedVetoes})`;
}

export function redTeamAttributionLabel(model: string | null | undefined): string {
  return model?.trim() ? model : RED_TEAM_UNATTRIBUTED_MODEL;
}

export function redTeamReturnTone(returnPct: number): RedTeamReturnTone {
  if (returnPct < 0) return "pos";
  if (returnPct > 0) return "neg";
  return "muted";
}

export function buildRedTeamModelRows(efficacy: RedTeamEfficacy | null | undefined): RedTeamModelRow[] {
  if (!efficacy) return [];
  return [...efficacy.byModel].sort((a, b) => b.maturedVetoes - a.maturedVetoes || a.model.localeCompare(b.model));
}
