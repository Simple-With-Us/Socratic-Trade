// db-notifications.ts — notification events
import crypto from "crypto";
import { getDb } from "./db";
import type {
  NotificationEvent,
  NotificationEventType,
  NotificationStatus
} from "./types";

type RawNotificationEvent = {
  id: string;
  created_at: string;
  type: string;
  title: string;
  status: string;
  webhook_url: string | null;
  payload: string;
  error: string | null;
  connected_account_id: string | null;
};

export function insertNotificationEvent(input: {
  userId?: string;
  connectedAccountId?: string;
  type: NotificationEventType;
  title: string;
  status: NotificationStatus;
  webhookUrl?: string;
  payload: unknown;
  error?: string;
}): NotificationEvent {
  const event: NotificationEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type: input.type,
    title: input.title,
    status: input.status,
    webhookUrl: input.webhookUrl,
    payload: input.payload,
    error: input.error,
    connectedAccountId: input.connectedAccountId
  };
  getDb()
    .prepare("INSERT INTO notification_events (id, user_id, connected_account_id, created_at, type, title, status, webhook_url, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, input.userId ?? "local", input.connectedAccountId ?? null, event.createdAt, event.type, event.title, event.status, event.webhookUrl ?? null, JSON.stringify(event.payload), event.error ?? null);
  return event;
}

export function listNotificationEvents(userId: string = "local", limit: number = 50): NotificationEvent[] {
  const rows = getDb()
    .prepare("SELECT id, created_at, type, title, status, webhook_url, payload, error, connected_account_id FROM notification_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as RawNotificationEvent[];
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    type: row.type as NotificationEventType,
    title: row.title,
    status: row.status as NotificationStatus,
    webhookUrl: row.webhook_url ?? undefined,
    payload: JSON.parse(row.payload),
    error: row.error ?? undefined,
    connectedAccountId: row.connected_account_id ?? undefined
  }));
}
