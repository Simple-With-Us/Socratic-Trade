import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSharedBuild as next} from './shared-build.mjs';
const STAMP = '202610290930';
const input = {iosBuilds: [], macBuilds: [], complete: true, mergeStamp: STAMP};
test('fresh app plans the merge stamp', () => {
  assert.deepEqual(next(input), {build: STAMP});
});
test('existing builds below the stamp plan the stamp', () => {
  assert.deepEqual(next({...input, iosBuilds: ['1000', '2394']}), {build: STAMP});
  assert.deepEqual(next({...input, iosBuilds: ['202610280001']}), {build: STAMP});
  assert.deepEqual(next({...input, macBuilds: ['202610290929']}), {build: STAMP});
  assert.deepEqual(next({...input, extraFloors: [1500]}), {build: STAMP});
});
test('existing build at or above the stamp plans one higher', () => {
  assert.deepEqual(next({...input, iosBuilds: [STAMP]}), {build: '202610290931'});
  assert.deepEqual(next({...input, iosBuilds: ['209912312359']}), {build: '209912312360'});
  assert.deepEqual(next({...input, macBuilds: ['209912312359']}), {build: '209912312360'});
});
test('dotted builds count by first component', () => {
  assert.deepEqual(next({...input, iosBuilds: ['0.1.3', '1.1.2']}), {build: STAMP});
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290931.1']}),
    {build: '202610290932'}
  );
});
test('iOS timestamp builds count now', () => {
  // Below the stamp they lose to it, but they are inspected, not skipped:  a
  // stamp at or below one plans above it.
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '202610180127']}),
    {build: STAMP}
  );
  assert.deepEqual(
    next({...input, mergeStamp: '202610190000', iosBuilds: ['202610190645']}),
    {build: '202610190646'}
  );
});
test('shared plan takes the max across iOS and macOS', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290931'], macBuilds: ['202610290935']}),
    {build: '202610290936'}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290935'], macBuilds: ['202610290931']}),
    {build: '202610290936'}
  );
});
test('mac-only higher build wins', () => {
  assert.deepEqual(
    next({...input, macBuilds: ['202610291200']}),
    {build: '202610291201'}
  );
});
test('extra floors raise the plan above the stamp', () => {
  assert.deepEqual(next({...input, extraFloors: [986]}), {build: STAMP});
  assert.deepEqual(
    next({...input, extraFloors: [209912312359]}),
    {build: '209912312360'}
  );
  // CLI floors arrive as digit strings (a Sparkle max can exceed the safe
  // integer range); they count exactly.
  assert.deepEqual(
    next({...input, extraFloors: ['202610290930']}),
    {build: '202610290931'}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290931'], extraFloors: [202610290935]}),
    {build: '202610290936'}
  );
});
test('malformed inventory throws before computing', () => {
  for (const bad of [null, 'NaN', '1.2.3.4', 42, '', ' 1000', 'v1']) {
    assert.throws(() => next({...input, iosBuilds: [bad]}), /malformed build inventory/);
    assert.throws(() => next({...input, macBuilds: [bad]}), /malformed build inventory/);
  }
  for (const bad of [-1, 1.5, NaN, 'NaN', '', '1.2', null]) {
    assert.throws(() => next({...input, extraFloors: [bad]}), /malformed build inventory/);
  }
  // A malformed entry is reported even when a higher build would also apply.
  assert.throws(() => next({...input, iosBuilds: ['209912312359', 'NaN']}), /malformed build inventory/);
});
test('bad merge stamp throws before computing', () => {
  for (const bad of [undefined, null, 202610290930, '', '123', '20261029093', '2026102909301', '002610290930', '20261029093a', ' 202610290930']) {
    assert.throws(() => next({...input, mergeStamp: bad}), /malformed merge stamp/);
  }
});
test('incomplete inventory refuses', () => {
  assert.throws(() => next({...input, complete: false}), /complete build inventory required/);
  assert.throws(() => next({...input, complete: undefined}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: '1000', macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
});
