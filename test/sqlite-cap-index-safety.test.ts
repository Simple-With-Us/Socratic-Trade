import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
const index = 'CREATE INDEX cap_test ON proposals(user_id, account_number, datetime(coalesce(placed_at, created_at)))';
function db() { const d = new Database(':memory:'); d.exec('CREATE TABLE proposals(user_id TEXT, account_number TEXT, placed_at TEXT, created_at TEXT)'); return d; }
describe('SQLite stored relative-time expression-index safety', () => {
  it('accepts ordinary timestamp data in an expression index', () => {
    const d=db(); try { d.prepare('INSERT INTO proposals VALUES(?,?,?,?)').run('u','a','2026-11-26 14:30:00',null); expect(()=>d.exec(index)).not.toThrow(); } finally { d.close(); }
  });
  it('rejects index construction over a stored now value, not only a literal expression', () => {
    const d=db(); try { d.prepare('INSERT INTO proposals VALUES(?,?,?,?)').run('u','a','now',null); expect(d.prepare('SELECT datetime(coalesce(placed_at,created_at)) value FROM proposals').get()).toHaveProperty('value'); expect(()=>d.exec(index)).toThrow(/non-deterministic use of datetime/); } finally { d.close(); }
  });
  it('rejects a future stored now write after empty-table index construction', () => {
    const d=db(); try { d.exec(index); expect(()=>d.prepare('INSERT INTO proposals VALUES(?,?,?,?)').run('u','a','now',null)).toThrow(/non-deterministic use of datetime/); } finally { d.close(); }
  });
});
