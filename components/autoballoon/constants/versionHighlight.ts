/** Version highlight follows the dimension (position), not the balloon number. */
import type { Balloon, DrawingVersionInfo } from "../api";

type Box = { page?: number; x: number; y: number; width?: number; height?: number };

const centre = (b: Box) => ({ x: b.x + (b.width || 0) / 2, y: b.y + (b.height || 0) / 2 });

/** Original highlighted balloon no. → current balloon no. on the same dimension (same rule as the backend). */
export function currentHighlightMap(info: DrawingVersionInfo | undefined, balloons: Balloon[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!info?.version || info.pending) return out;
  if (!info.highlight_features) {
    // Jobs versioned before positions were stored: fall back to the saved numbers.
    for (const n of info.highlighted || []) out.set(n, n);
    return out;
  }
  const used = new Set<number>();
  for (const f of info.highlight_features) {
    const fc = centre(f);
    let best: number | null = null;
    let bestD = Math.max(3, 0.6 * Math.min(f.height || 12, f.width || 12));
    for (const b of balloons || []) {
      if (used.has(b.balloon) || (b.page || 1) !== f.page) continue;
      const bc = centre(b);
      const d = Math.hypot(bc.x - fc.x, bc.y - fc.y);
      if (d <= bestD) {
        best = b.balloon;
        bestD = d;
      }
    }
    if (best !== null) {
      used.add(best);
      out.set(f.balloon, best);
    }
  }
  return out;
}

export function highlightedBalloonNumbers(info: DrawingVersionInfo | undefined, balloons: Balloon[] | undefined): number[] {
  return Array.from(currentHighlightMap(info, balloons).values());
}
