import { sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const userSettings = sqliteTable("user_settings", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => [
  unique().on(t.user_id, t.key)
]);

export const marketDataDemands = sqliteTable("market_data_demands", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  symbol: text("symbol").notNull(),
  user_id: text("user_id").notNull(),
  status: text("status").notNull(),
  requested_at: text("requested_at").notNull(),
  last_requested_at: text("last_requested_at").notNull(),
  fulfilled_at: text("fulfilled_at"),
  expires_at: text("expires_at").notNull(),
}, (t) => [
  unique().on(t.kind, t.symbol, t.user_id)
]);

/** Revocable Auth.js session rows; JWT `sid` must match an active row. */
export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  created_at: text("created_at").notNull(),
  absolute_expires_at: text("absolute_expires_at").notNull(),
  revoked_at: text("revoked_at"),
  last_seen_at: text("last_seen_at").notNull(),
});
