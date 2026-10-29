// Pure build planner.  No network, uploads or release state changes.
// One shared four-digit counter per app across iOS and macOS (owner, Oct 28 2026).
// next = max(1000, every iOS candidate, every macOS candidate, every extraFloor + 1).
// A build N or N.x.y requires next >= N + 1.  iOS UTC timestamp builds
// (first component >= 100000000) are ignored because App Store Connect orders
// iOS builds only within a version train and those trains are closed; they are
// counted in ignoredIos.  macOS builds order across all trains, so every mac
// build counts.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete}) {
  if (complete !== true || !Array.isArray(iosBuilds) || !Array.isArray(macBuilds)) {
    throw new Error('complete build inventory required');
  }
  if (!Array.isArray(extraFloors)) throw new Error('malformed build inventory');
  for (const floor of extraFloors) {
    if (typeof floor !== 'number' || !Number.isSafeInteger(floor) || floor < 0) {
      throw new Error('malformed build inventory');
    }
  }
  // Validate everything before computing; malformed evidence is never ignored.
  const re = /^[0-9]+(\.[0-9]+){0,2}$/;
  for (const value of [...iosBuilds, ...macBuilds]) {
    if (typeof value !== 'string' || !re.test(value)) throw new Error('malformed build inventory');
  }
  const TIMESTAMP = 100000000n;
  const LIMIT = 9999n;
  let ignoredIos = 0;
  let next = 1000n;
  for (const value of iosBuilds) {
    const first = BigInt(value.split('.')[0]);
    if (first >= TIMESTAMP) {
      ignoredIos += 1;
      continue;
    }
    if (first >= LIMIT) throw new Error('four-digit build range exhausted');
    const candidate = first + 1n;
    if (candidate > next) next = candidate;
  }
  for (const value of macBuilds) {
    const first = BigInt(value.split('.')[0]);
    if (first >= LIMIT) {
      throw new Error(`four-digit build unavailable on macOS: existing ${value} requires >= ${first + 1n}`);
    }
    const candidate = first + 1n;
    if (candidate > next) next = candidate;
  }
  for (const floor of extraFloors) {
    const candidate = BigInt(floor) + 1n;
    if (candidate > next) next = candidate;
  }
  if (next > LIMIT) throw new Error('four-digit build range exhausted');
  return {build: String(next), ignoredIos};
}
