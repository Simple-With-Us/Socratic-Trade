/** Drawdown math for the equity curve (W30 / OD-11). Pure and windowed: the
 *  running peak is computed over the VISIBLE window only, matching what the
 *  chart's own shading draws — never over a fabricated all-time baseline.
 *  `drawdown` is a fraction (0 at the running peak, negative below it) and
 *  null when the peak is not positive (an all-zero curve has no meaningful
 *  drawdown). */

export interface DrawdownSeriesPoint {
  value: number;
  /** Running peak over the window up to and including this index. */
  peak: number;
  /** Fraction below the running peak: 0 at peaks, negative otherwise. */
  drawdown: number | null;
}

export function drawdownSeries(values: number[]): DrawdownSeriesPoint[] {
  let peak = -Infinity;
  return values.map((value) => {
    peak = value > peak ? value : peak;
    const drawdown = peak > 0 ? (value - peak) / peak : null;
    return { value, peak, drawdown };
  });
}

/** Deepest drawdown of the window as a negative fraction, or null when the
 *  window never draws down (or has no positive peak). */
export function maxDrawdownFraction(series: DrawdownSeriesPoint[]): number | null {
  let worst: number | null = null;
  for (const point of series) {
    if (point.drawdown === null) continue;
    if (worst === null || point.drawdown < worst) worst = point.drawdown;
  }
  return worst;
}