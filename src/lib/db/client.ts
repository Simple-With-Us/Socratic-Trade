import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDb } from "../db";
import * as schema from "./schema";

// We lazily instantiate the Drizzle client to ensure it wraps the correctly
// configured connection from getDb(), which sets up WAL mode, busy_timeout, etc.
let drizzleDb: ReturnType<typeof drizzle> | undefined;

export function getDrizzle() {
  if (drizzleDb) return drizzleDb;
  drizzleDb = drizzle(getDb(), { schema });
  return drizzleDb;
}
