import { describe, expect, it } from 'vitest';
import { snapshotFillTimingAmbiguities, inferTodayExternalFlow, computeDayPnlInferredHint } from '../src/lib/cash-flows';
import type { EquityCurvePoint, FillEvent } from '../src/lib/types';
const baseline: EquityCurvePoint = { timestamp:'2026-11-19T20:00:00Z',equity:100000,cash:60000,positionsValue:40000,source:'live' };
const execution = { id:'synthetic-fill',accountNumber:'synthetic-account',source:'live',executionMode:'broker/live',symbol:'SYNTH',side:'buy',quantity:1,price:2000,notional:2000,status:'filled',brokerOrderId:'synthetic-order',filledAt:'2026-11-19T19:30:00Z',runId:'synthetic-run' } as FillEvent;
const now = new Date('2026-11-20T20:00:00Z');
describe('unattributed cash endpoints require timing evidence',()=>{
 it('missing snapshot identity does not declare an overlapping receipt clean',()=>{
  expect(snapshotFillTimingAmbiguities([baseline],[execution])).toEqual([true]);
 });
 it('broker history remains outside local cash capture inference',()=>{
  expect(snapshotFillTimingAmbiguities([{...baseline,brokerHistory:true,cash:undefined}],[execution])).toEqual([false]);
 });
 it('no receipts remain clean without fabricating a run',()=>{
  expect(snapshotFillTimingAmbiguities([baseline],[])).toEqual([false]);
  expect(inferTodayExternalFlow({baseline,fills:[],currentEquity:100000,currentCash:60000,now})).toBe(0);
 });
 it('an explicit proven lower bound can exclude an earlier receipt without an identity',()=>{
  expect(snapshotFillTimingAmbiguities([{...baseline,cashRequestStartedAt:'2026-11-19T19:45:00Z'}],[execution])).toEqual([false]);
 });
 it('current endpoint cannot silently turn a withheld gap into zero flow',()=>{
  const knownBaseline={...baseline,runId:'baseline-run',cashRequestStartedAt:'2026-11-19T19:45:00Z'};
  const later={...execution,filledAt:'2026-11-20T19:30:00Z'};
  expect(inferTodayExternalFlow({baseline:knownBaseline,fills:[later],currentEquity:95000,currentCash:53000,now})).toBeUndefined();
  expect(computeDayPnlInferredHint({liveCurve:[knownBaseline],paperCurve:[],liveFills:[later],paperFills:[],mode:'live',portfolio:{totalMarketValue:95000,cash:53000},now})?.flow).toBeNull();
 });
});

it('run start alone cannot qualify historical cash that may come from an older adapter cache',()=>{
 const older={...execution,filledAt:'2026-11-19T18:00:00Z'};
 expect(snapshotFillTimingAmbiguities([{...baseline,runId:'different',runStartedAt:'2026-11-19T19:45:00Z'}],[older])).toEqual([true]);
 expect(snapshotFillTimingAmbiguities([{...baseline,runId:'different',cashRequestStartedAt:'2026-11-19T19:45:00Z'}],[older])).toEqual([false]);
});

it('a proven fresh current request recovers the genuine withdrawal without inventing a run',()=>{
 const knownBaseline={...baseline,cashRequestStartedAt:'2026-11-19T19:45:00Z'};
 const later={...execution,filledAt:'2026-11-20T18:00:00Z'};
 expect(inferTodayExternalFlow({baseline:knownBaseline,fills:[later],currentEquity:95000,currentCash:53000,currentCashRequestStartedAt:'2026-11-20T19:00:00Z',now})).toBe(-5000);
 expect(computeDayPnlInferredHint({liveCurve:[knownBaseline],paperCurve:[],liveFills:[later],paperFills:[],mode:'live',portfolio:{totalMarketValue:95000,cash:53000,cashRequestStartedAt:'2026-11-20T19:00:00Z'},now})?.flow).toBe(-5000);
});
