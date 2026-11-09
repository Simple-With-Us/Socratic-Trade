// Mobile-wire compat for performance equity curves.
//
// The server's EquityCurvePoint (src/lib/types.ts) keys its points by `timestamp`,
// but every shipped iOS build's Swift `EquityCurvePoint` hard-requires `date` —
// and Swift's whole-snapshot decode aborts on the first missing key, so a single
// curve point without `date` blanks the entire app with "Couldn't load your
// workspace" (owner-reported 2026-08-27; verified against the live authenticated
// snapshot).  Alias every point with `date` on the mobile wire only — the console
// keeps consuming `timestamp` and this must not be "fixed" by renaming the shared
// type.

import type { EquityCurvePoint } from "./types";

type MobileCurvePoint = EquityCurvePoint & { date: string };

interface CurveCarrier {
  liveEquityCurve?: EquityCurvePoint[];
  paperEquityCurve?: EquityCurvePoint[];
}

function aliased(points: EquityCurvePoint[] | undefined): MobileCurvePoint[] | undefined {
  return points?.map((p) => ({ ...p, date: (p as Partial<MobileCurvePoint>).date ?? p.timestamp }));
}

export function withMobileEquityCurveCompat<T extends CurveCarrier | null | undefined>(
  performance: T
): T extends CurveCarrier
  ? Omit<T, "liveEquityCurve" | "paperEquityCurve"> & {
      liveEquityCurve?: MobileCurvePoint[];
      paperEquityCurve?: MobileCurvePoint[];
    }
  : T {
  if (!performance) return performance as never;
  return {
    ...performance,
    liveEquityCurve: aliased(performance.liveEquityCurve),
    paperEquityCurve: aliased(performance.paperEquityCurve)
  } as never;
}
