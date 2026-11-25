import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RawDatabase from 'better-sqlite3';
import { describe,it,expect } from 'vitest';
process.env.DATABASE_URL=`file:${join(tmpdir(),`cash-provenance-${randomUUID()}.db`)}`;

describe('forward-only cash provenance',()=>{
 it('adds nullable provenance to an old table without backfill, preserves old bytes and is idempotent',async()=>{
  const { applyVersionedMigrations }=await import('../src/lib/db');
  const d=new RawDatabase(':memory:');
  d.exec('CREATE TABLE portfolio_snapshots (id TEXT PRIMARY KEY,cash REAL); INSERT INTO portfolio_snapshots VALUES (\'legacy\',123.45); PRAGMA user_version=103;');
  applyVersionedMigrations(d);
  expect(d.prepare('SELECT * FROM portfolio_snapshots').all()).toEqual([{id:'legacy',cash:123.45,cash_request_started_at:null}]);
  applyVersionedMigrations(d);
  expect(d.prepare('SELECT count(*) AS n FROM portfolio_snapshots').get()).toEqual({n:1});
  d.close();
 });
 it('round trips only supplied provenance through scoped daily/all snapshot readers',async()=>{
  const { insertPortfolioSnapshot,listPortfolioSnapshots,listDailyPortfolioSnapshots }=await import('../src/lib/db');
  const base={accountNumber:'synthetic-account',source:'live' as const,equity:100000,cash:60000,buyingPower:60000,positionsValue:40000,positions:[]};
  insertPortfolioSnapshot({...base,userId:'synthetic-user',id:'old',createdAt:'2026-11-19T20:00:00Z'});
  insertPortfolioSnapshot({...base,userId:'synthetic-user',id:'new',createdAt:'2026-11-20T20:00:00Z',cashRequestStartedAt:'2026-11-20T19:00:00Z'});
  insertPortfolioSnapshot({...base,userId:'other-user',id:'other',createdAt:'2026-11-20T21:00:00Z',cashRequestStartedAt:'2026-11-20T20:00:00Z'});
  for(const rows of [listPortfolioSnapshots(base.accountNumber,'live',100,'synthetic-user'),listDailyPortfolioSnapshots(base.accountNumber,'live','synthetic-user'),listDailyPortfolioSnapshots(base.accountNumber,undefined,'synthetic-user')]){
   expect(rows.map(r=>r.id)).toEqual(['old','new']);
   expect(rows[0]?.cashRequestStartedAt).toBeUndefined();
   expect(rows[1]?.cashRequestStartedAt).toBe('2026-11-20T19:00:00Z');
  }
 });
});

it('ordinary future snapshot writer and performance curves keep the same producer bound',async()=>{
 const {recordPortfolioSnapshot,getPerformanceSummary}=await import('../src/lib/performance');
 const {listPortfolioSnapshots}=await import('../src/lib/db');
 const at='2026-11-20T19:00:00Z';
 recordPortfolioSnapshot({userId:'writer-user',accountNumber:'writer-account',source:'live',portfolio:{accountNumber:'writer-account',totalMarketValue:100000,cash:60000,buyingPower:60000,equityMarketValue:40000,optionMarketValue:0,cashRequestStartedAt:at},positions:[]});
 expect(listPortfolioSnapshots('writer-account','live',100,'writer-user')[0]?.cashRequestStartedAt).toBe(at);
 const summary=getPerformanceSummary('writer-account',{},'writer-user');
 expect(summary.liveEquityCurve[0]?.cashRequestStartedAt).toBe(at);
});

it('two ordinary future snapshots recover a real transfer through reader, curve and inference',async()=>{
 const {vi}=await import('vitest');
 const {recordPortfolioSnapshot,getPerformanceSummary}=await import('../src/lib/performance');
 const {inferExternalCashFlows}=await import('../src/lib/cash-flows');
 vi.useFakeTimers({toFake:['Date']});
 try {
  const portfolio={accountNumber:'recovery-account',totalMarketValue:100000,cash:60000,buyingPower:60000,equityMarketValue:40000,optionMarketValue:0,cashRequestStartedAt:'2026-11-19T19:00:00Z'};
  vi.setSystemTime(new Date('2026-11-19T20:00:00Z'));
  recordPortfolioSnapshot({userId:'recovery-user',accountNumber:portfolio.accountNumber,source:'live',portfolio,positions:[]});
  vi.setSystemTime(new Date('2026-11-20T20:00:00Z'));
  recordPortfolioSnapshot({userId:'recovery-user',accountNumber:portfolio.accountNumber,source:'live',portfolio:{...portfolio,totalMarketValue:95000,cash:53000,equityMarketValue:42000,cashRequestStartedAt:'2026-11-20T19:00:00Z'},positions:[]});
  const curve=getPerformanceSummary(portfolio.accountNumber,{},'recovery-user').liveEquityCurve;
  expect(curve).toHaveLength(2);
  const f={id:'recovery-fill',accountNumber:portfolio.accountNumber,source:'live',executionMode:'broker/live',symbol:'SYNTH',side:'buy',quantity:1,price:2000,notional:2000,status:'filled',brokerOrderId:'synthetic',filledAt:'2026-11-20T18:00:00Z'} as import('../src/lib/types').FillEvent;
  expect(inferExternalCashFlows(curve,[f]).get('2026-11-20')).toBe(-5000);
 } finally {vi.useRealTimers();}
});

it('self-heals a pre-stamped version or older restore idempotently without changing rows',async()=>{
 const {applyVersionedMigrations}=await import('../src/lib/db');
 const d=new RawDatabase(':memory:');
 d.exec("CREATE TABLE portfolio_snapshots (id TEXT PRIMARY KEY,cash REAL); INSERT INTO portfolio_snapshots VALUES ('restored',123.45); PRAGMA user_version=104;");
 expect(applyVersionedMigrations(d)).toBe(106);
 expect(applyVersionedMigrations(d)).toBe(106);
 expect(d.prepare('SELECT * FROM portfolio_snapshots').all()).toEqual([{id:'restored',cash:123.45,cash_request_started_at:null}]);
 d.close();
});

it.each([103,104])('waits for an outgoing WAL writer at schema %s, then upgrades or repairs and remains old-code compatible',async(schemaVersion)=>{
 const {spawn}=await import('node:child_process');
 const {createRequire}=await import('node:module');
 const require=createRequire(import.meta.url);
 const {applyVersionedMigrations}=await import('../src/lib/db');
 const file=join(tmpdir(),`cash-lock-${randomUUID()}.db`);
 const d=new RawDatabase(file);d.pragma('journal_mode=WAL');d.pragma('busy_timeout=3000');
 d.exec(`CREATE TABLE portfolio_snapshots (id TEXT PRIMARY KEY,cash REAL); INSERT INTO portfolio_snapshots VALUES ('old',123); PRAGMA user_version=${schemaVersion};`);
 const script=`const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const d=new D(${JSON.stringify(file)});d.exec('BEGIN IMMEDIATE');console.log('locked');setTimeout(()=>{if(${schemaVersion}===104)d.exec('ALTER TABLE portfolio_snapshots ADD COLUMN cash_request_started_at TEXT');d.exec('COMMIT');d.close()},250);`;
 const child=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject)});
 const start=Date.now();applyVersionedMigrations(d);const elapsed=Date.now()-start;
 expect(elapsed).toBeGreaterThanOrEqual(100);expect(elapsed).toBeLessThan(3000);
 d.exec("INSERT INTO portfolio_snapshots (id,cash) VALUES ('old-writer',456)");
 expect(d.prepare('SELECT id,cash,cash_request_started_at FROM portfolio_snapshots ORDER BY id').all()).toEqual([{id:'old',cash:123,cash_request_started_at:null},{id:'old-writer',cash:456,cash_request_started_at:null}]);
 // An older reader explicitly selecting its columns still sees unchanged amounts.
 expect(d.prepare('SELECT sum(cash) AS cash FROM portfolio_snapshots').get()).toEqual({cash:579});
 d.close();
});
