// Pure build planner.  No network, uploads or release state changes.
// One shared merge-timestamp build number per release across iOS and macOS
// (owner, Oct 29 2026): build = max(S, M + 1), a plain integer, where S is
// the merge stamp (the committer date of the commit being built, in
// America/Chicago as YYYYMMDDHHMM) and M is the highest first numeric
// component among EVERY build of the app on iOS and of its paired macOS app
// (expired builds included, all version trains, old timestamp-style builds
// included) plus every extra floor.  No floor and no cap:  a rebuild of the
// same commit still goes up, because the first upload already holds S.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete, mergeStamp}) {
  if (complete !== true || !Array.isArray(iosBuilds) || !Array.isArray(macBuilds)) {
    throw new Error('complete build inventory required');
  }
  if (typeof mergeStamp !== 'string' || !/^[1-9][0-9]{11}$/.test(mergeStamp)) {
    throw new Error('malformed merge stamp');
  }
  if (!Array.isArray(extraFloors)) throw new Error('malformed build inventory');
  // Floors arrive as CLI strings (a Sparkle feed max can exceed the safe
  // integer range) or as plain numbers; both are validated, never coerced
  // silently.
  const floorValues = [];
  for (const floor of extraFloors) {
    if (typeof floor === 'number') {
      if (!Number.isSafeInteger(floor) || floor < 0) {
        throw new Error('malformed build inventory');
      }
      floorValues.push(BigInt(floor));
    } else if (typeof floor === 'string' && /^[0-9]+$/.test(floor)) {
      floorValues.push(BigInt(floor));
    } else {
      throw new Error('malformed build inventory');
    }
  }
  // Validate everything before computing; malformed evidence is never ignored.
  const re = /^[0-9]+(\.[0-9]+){0,2}$/;
  for (const value of [...iosBuilds, ...macBuilds]) {
    if (typeof value !== 'string' || !re.test(value)) throw new Error('malformed build inventory');
  }
  const stamp = BigInt(mergeStamp);
  let highest = -1n;
  for (const value of [...iosBuilds, ...macBuilds]) {
    const first = BigInt(value.split('.')[0]);
    if (first > highest) highest = first;
  }
  for (const floor of floorValues) {
    if (floor > highest) highest = floor;
  }
  const next = highest + 1n > stamp ? highest + 1n : stamp;
  return {build: String(next)};
}
