import { afterEach } from "vitest";
import { resetPeerLaneBackoffForTests } from "../src/lib/peer-lane-backoff";

// vitest maxWorkers is 1, so process-local peer-lane samples leak across files.
// This module is fetch-free and db-free — do not import congress/UM helpers here
// or setupFiles would open getDb() before a test file sets DATABASE_URL.
//
// Console intercept is disabled in vitest.config.ts (RPC teardown race).  Swallow
// log/info/debug here so strategy-suite stdout stays quiet without going through
// the spy.  Leave warn/error alone — several tests spy on those.
const noop = () => {};
console.log = noop;
console.info = noop;
console.debug = noop;

afterEach(() => {
  resetPeerLaneBackoffForTests();
});
