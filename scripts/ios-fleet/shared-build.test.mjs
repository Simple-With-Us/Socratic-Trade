import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSharedBuild as next} from './shared-build.mjs';
const input = {iosBuilds: [], macBuilds: [], complete: true};
test('empty inventory starts at smallest four-digit integer', () => {
  assert.deepEqual(next(input), {build: '1000', ignoredIos: 0});
});
test('dotted and sub-floor builds stay at the four-digit floor', () => {
  assert.deepEqual(next({...input, iosBuilds: ['0.1.3', '1.1.2']}), {build: '1000', ignoredIos: 0});
  assert.deepEqual(next({...input, iosBuilds: ['101']}), {build: '1000', ignoredIos: 0});
  assert.deepEqual(next({...input, macBuilds: ['0.1.3']}), {build: '1000', ignoredIos: 0});
});
test('iOS four-digit build continues above it', () => {
  assert.deepEqual(next({...input, iosBuilds: ['2394']}), {build: '2395', ignoredIos: 0});
});
test('shared counter takes the max across iOS and macOS', () => {
  assert.deepEqual(next({...input, iosBuilds: ['1100'], macBuilds: ['1200']}), {build: '1201', ignoredIos: 0});
  assert.deepEqual(next({...input, iosBuilds: ['1300'], macBuilds: ['1200']}), {build: '1301', ignoredIos: 0});
});
test('extra floors raise the counter above 999', () => {
  assert.deepEqual(next({...input, extraFloors: [986]}), {build: '1000', ignoredIos: 0});
  assert.deepEqual(next({...input, extraFloors: [1500]}), {build: '1501', ignoredIos: 0});
  assert.deepEqual(next({...input, iosBuilds: ['1100'], extraFloors: [1500]}), {build: '1501', ignoredIos: 0});
});
test('iOS timestamp builds are ignored and counted', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '202610180127']}),
    {build: '1000', ignoredIos: 2}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '2394']}),
    {build: '2395', ignoredIos: 1}
  );
});
test('macOS timestamp build cannot fit the four-digit range', () => {
  assert.throws(
    () => next({...input, macBuilds: ['202610190645']}),
    /four-digit build unavailable on macOS: existing 202610190645 requires >= 202610190646/
  );
});
test('9999 exhausts the range on either platform', () => {
  assert.throws(() => next({...input, iosBuilds: ['9999']}), /four-digit build range exhausted/);
  assert.throws(() => next({...input, macBuilds: ['9999']}), /four-digit build unavailable on macOS/);
  assert.throws(() => next({...input, extraFloors: [9999]}), /four-digit build range exhausted/);
  assert.deepEqual(next({...input, iosBuilds: ['9998']}), {build: '9999', ignoredIos: 0});
});
test('malformed inventory throws before computing', () => {
  for (const bad of [null, 'NaN', '1.2.3.4', 42, '', ' 1000', 'v1']) {
    assert.throws(() => next({...input, iosBuilds: [bad]}), /malformed build inventory/);
    assert.throws(() => next({...input, macBuilds: [bad]}), /malformed build inventory/);
  }
  for (const bad of [-1, 1.5, NaN, '1500', null]) {
    assert.throws(() => next({...input, extraFloors: [bad]}), /malformed build inventory/);
  }
  // A malformed entry is reported even when a range error would also apply.
  assert.throws(() => next({...input, iosBuilds: ['9999', 'NaN']}), /malformed build inventory/);
});
test('incomplete inventory refuses', () => {
  assert.throws(() => next({...input, complete: false}), /complete build inventory required/);
  assert.throws(() => next({...input, complete: undefined}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: [], complete: true}), /complete build inventory required/);
  assert.throws(() => next({macBuilds: [], complete: true}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: '1000', macBuilds: [], complete: true}), /complete build inventory required/);
});
