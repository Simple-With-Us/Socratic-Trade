// db-overlays.ts — owner-authored advisory strategy overlays (migration 81).
import "server-only";
import crypto from "crypto";
import { getDb } from "./db";
import { parseOverlayRegimes, type OverlayRegimeTag, type StrategyOverlay } from "./overlay-router";
import { OVERLAY_STARTER_TEMPLATES } from "./overlay-templates";

export interface StrategyOverlayRow extends StrategyOverlay {
  userId: string;
  createdAt: string;
  updatedAt: string;
}

function rowFromDb(row: {
  id: string;
  user_id: string;
  name: string;
  market_regimes: string;
  instructions: string;
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}): StrategyOverlayRow {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    marketRegimes: parseOverlayRegimes(row.market_regimes),
    instructions: row.instructions,
    priority: row.priority,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listStrategyOverlays(userId: string): StrategyOverlayRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, name, market_regimes, instructions, priority, enabled, created_at, updated_at
       FROM strategy_overlays WHERE user_id = ? ORDER BY priority ASC, name ASC`
    )
    .all(userId) as Array<{
    id: string;
    user_id: string;
    name: string;
    market_regimes: string;
    instructions: string;
    priority: number;
    enabled: number;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(rowFromDb);
}

export function createStrategyOverlay(input: {
  userId: string;
  name: string;
  marketRegimes?: OverlayRegimeTag[];
  instructions: string;
  priority?: number;
  enabled?: boolean;
}): StrategyOverlayRow {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const regimes = input.marketRegimes && input.marketRegimes.length > 0 ? input.marketRegimes : (["any"] as OverlayRegimeTag[]);
  getDb()
    .prepare(
      `INSERT INTO strategy_overlays (
         id, user_id, name, market_regimes, instructions, priority, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.userId,
      input.name.trim(),
      JSON.stringify(regimes),
      input.instructions,
      Math.floor(input.priority ?? 100),
      input.enabled === false ? 0 : 1,
      now,
      now
    );
  return {
    id,
    userId: input.userId,
    name: input.name.trim(),
    marketRegimes: regimes,
    instructions: input.instructions,
    priority: Math.floor(input.priority ?? 100),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now
  };
}

export function updateStrategyOverlay(
  userId: string,
  id: string,
  patch: Partial<Pick<StrategyOverlay, "name" | "marketRegimes" | "instructions" | "priority" | "enabled">>
): StrategyOverlayRow | undefined {
  const existing = listStrategyOverlays(userId).find((row) => row.id === id);
  if (!existing) return undefined;
  const next: StrategyOverlayRow = {
    ...existing,
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    marketRegimes: patch.marketRegimes ?? existing.marketRegimes,
    instructions: patch.instructions ?? existing.instructions,
    priority: patch.priority !== undefined ? Math.floor(patch.priority) : existing.priority,
    enabled: patch.enabled ?? existing.enabled,
    updatedAt: new Date().toISOString()
  };
  getDb()
    .prepare(
      `UPDATE strategy_overlays
       SET name = ?, market_regimes = ?, instructions = ?, priority = ?, enabled = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`
    )
    .run(
      next.name,
      JSON.stringify(next.marketRegimes),
      next.instructions,
      next.priority,
      next.enabled ? 1 : 0,
      next.updatedAt,
      userId,
      id
    );
  return next;
}

export function deleteStrategyOverlay(userId: string, id: string): boolean {
  const result = getDb().prepare(`DELETE FROM strategy_overlays WHERE user_id = ? AND id = ?`).run(userId, id);
  return Number(result.changes ?? 0) > 0;
}

export function seedStrategyOverlayTemplates(userId: string): StrategyOverlayRow[] {
  const existing = listStrategyOverlays(userId);
  const existingNames = new Set(existing.map((row) => row.name.toLowerCase()));
  const created: StrategyOverlayRow[] = [];
  for (const template of OVERLAY_STARTER_TEMPLATES) {
    if (existingNames.has(template.name.toLowerCase())) continue;
    created.push(
      createStrategyOverlay({
        userId,
        name: template.name,
        marketRegimes: template.marketRegimes,
        instructions: template.instructions,
        priority: template.priority,
        enabled: false
      })
    );
  }
  return created;
}
