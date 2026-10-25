import { describe, expect, it } from "vitest";
import { formatTolerance, reportRowsToBalloons } from "./autoballoon";

// Rows as the AutoBalloon service returned them for a test bracket drawing
// (R5, Ø25 ±0.1, 30.0 +0.2/-0.0, 2.5 x 45°, 50.00 ±0.10).
const rows = [
  { balloon: 2, page: 1, reference: "P1", nominal: "25", tol_low: "-0.1", tol_high: "0.1" },
  { balloon: 1, page: 1, reference: "P1", nominal: "5", tol_low: "", tol_high: "" },
  { balloon: 3, page: 1, reference: "B3", nominal: "30.0", tol_low: "-0.0", tol_high: "+0.2" },
  { balloon: 5, page: 1, reference: "", nominal: "50.00", tol_low: "-0.10", tol_high: "0.10" },
];

describe("formatTolerance", () => {
  it("collapses symmetric deviations to ±", () => {
    expect(formatTolerance("-0.10", "0.10")).toBe("±0.10");
  });
  it("shows asymmetric deviations upper first", () => {
    expect(formatTolerance("-0.0", "+0.2")).toBe("+0.2 / -0.0");
    expect(formatTolerance("0", "0.3")).toBe("+0.3 / +0");
  });
  it("handles one side or none", () => {
    expect(formatTolerance("", "0.05")).toBe("+0.05");
    expect(formatTolerance("-0.05", "")).toBe("-0.05");
    expect(formatTolerance("", "")).toBeNull();
    expect(formatTolerance(undefined, undefined)).toBeNull();
  });
});

describe("reportRowsToBalloons", () => {
  it("maps report rows to Balloon fields in balloon order", () => {
    const result = reportRowsToBalloons(rows, [{ balloon: 2, category: "diameter" }]);
    expect(result).toEqual([
      { balloonNo: 1, viewSection: "P1", description: null, nominal: "5", tolerance: null },
      { balloonNo: 2, viewSection: "P1", description: "Diameter", nominal: "25", tolerance: "±0.1" },
      { balloonNo: 3, viewSection: "B3", description: null, nominal: "30.0", tolerance: "+0.2 / -0.0" },
      { balloonNo: 5, viewSection: "P1", description: null, nominal: "50.00", tolerance: "±0.10" },
    ]);
  });

  it("skips rows without a balloon number and duplicate numbers", () => {
    const result = reportRowsToBalloons([{ balloon: 0 }, { balloon: 4, nominal: "1" }, { balloon: 4, nominal: "2" }]);
    expect(result.map((b) => [b.balloonNo, b.nominal])).toEqual([[4, "1"]]);
  });
});
