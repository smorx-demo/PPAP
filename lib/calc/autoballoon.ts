/**
 * Maps the AutoBalloon service's inspection-report rows onto PPAP's
 * `Balloon` rows (element 1), which feed the Dimensional Report (element 9).
 * Pure: lib/autoballoon-sync.ts fetches the job and writes the result.
 */

export type ReportRowInput = {
  balloon: number;
  reference?: string;
  nominal?: string;
  tol_low?: string;
  tol_high?: string;
  page?: number;
};

export type BalloonInput = { balloon: number; category?: string };

export type BalloonFields = {
  balloonNo: number;
  viewSection: string | null;
  description: string | null;
  nominal: string | null;
  tolerance: string | null;
};

const clean = (v: string | undefined | null) => (v ?? "").trim();

/** "+0.1" for positive numbers without a sign; leaves signed / non-numeric text as typed. */
function signed(v: string): string {
  if (/^[+-]/.test(v) || !/^\d*\.?\d+$/.test(v)) return v;
  return `+${v}`;
}

/**
 * Tolerance text from the report's lower / upper deviation: "±0.10" when
 * symmetric (-0.10 / 0.10), else "+0.2 / -0.0"; one side only gives just
 * that side; none gives null.
 */
export function formatTolerance(tolLow?: string, tolHigh?: string): string | null {
  const low = clean(tolLow);
  const high = clean(tolHigh);
  if (!low && !high) return null;
  if (low && high) {
    const lowAbs = low.replace(/^[+-]/, "");
    const highAbs = high.replace(/^[+-]/, "");
    if (low.startsWith("-") && !high.startsWith("-") && lowAbs === highAbs) return `±${highAbs}`;
    return `${signed(high)} / ${signed(low)}`;
  }
  return signed(high || low);
}

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** One Balloon row per report row, in balloon order; balloons without a number are skipped. */
export function reportRowsToBalloons(rows: ReportRowInput[], balloons: BalloonInput[] = []): BalloonFields[] {
  const category = new Map(balloons.map((b) => [b.balloon, clean(b.category)]));
  const seen = new Set<number>();
  return rows
    .filter((r) => Number.isInteger(r.balloon) && r.balloon > 0)
    .filter((r) => (seen.has(r.balloon) ? false : (seen.add(r.balloon), true)))
    .sort((a, b) => a.balloon - b.balloon)
    .map((r) => ({
      balloonNo: r.balloon,
      viewSection: clean(r.reference) || (r.page ? `P${r.page}` : null),
      description: category.get(r.balloon) ? titleCase(category.get(r.balloon)!) : null,
      nominal: clean(r.nominal) || null,
      tolerance: formatTolerance(r.tol_low, r.tol_high),
    }));
}
