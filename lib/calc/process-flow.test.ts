import { describe, expect, it } from "vitest";
import { deriveProcessStepList, type RouteInput } from "./process-flow";

// Fixtures drawn from the real seeded "5. PFC" sample: item 1 (LIFTING
// RING, 4100016) and item 2 (HINGE,BATTERY DOOR, 9207506), plus the
// main-assembly route template — see lib/pfc-import.ts.
const item1: RouteInput = {
  childPartItemNo: 1,
  steps: [
    { operationCode: "PLASMA_CUTTING", operationName: "Plasma cutting", symbol: "OPERATION", sequence: 0 },
    { operationCode: "INSPECTION", operationName: "Inspection", symbol: "INSPECTION", sequence: 1 },
    { operationCode: "CHAMFERING", operationName: "Chamfering", symbol: "OPERATION", sequence: 2 },
    { operationCode: "INSPECTION", operationName: "Inspection", symbol: "INSPECTION", sequence: 3 },
  ],
};

const item2: RouteInput = {
  childPartItemNo: 2,
  steps: [
    { operationCode: "PLASMA_CUTTING", operationName: "Plasma cutting", symbol: "OPERATION", sequence: 0 },
    { operationCode: "INSPECTION", operationName: "Inspection", symbol: "INSPECTION", sequence: 1 },
    { operationCode: "MACHINING", operationName: "Machining", symbol: "OPERATION", sequence: 2 },
    { operationCode: "INSPECTION", operationName: "Inspection", symbol: "INSPECTION", sequence: 3 },
  ],
};

const mainAssembly: RouteInput = {
  childPartItemNo: null,
  steps: [
    { operationCode: "MATERIAL_RECEIPT", operationName: "Material Receipt", symbol: "TRANSPORT", sequence: 0 },
    { operationCode: "INSPECTION", operationName: "Inspection", symbol: "INSPECTION", sequence: 1 },
    { operationCode: "STORAGE", operationName: "Storage", symbol: "STORAGE", sequence: 2 },
    { operationCode: "PACKING", operationName: "Packing", symbol: "OPERATION", sequence: 3 },
    { operationCode: "DISPATCH", operationName: "Dispatch", symbol: "TRANSPORT", sequence: 4 },
  ],
};

describe("deriveProcessStepList", () => {
  it("lists steps in child-part item-no order, main-assembly last", () => {
    const steps = deriveProcessStepList([mainAssembly, item2, item1]);
    expect(steps.map((s) => s.operationCode)).toEqual([
      "PLASMA_CUTTING",
      "INSPECTION",
      "CHAMFERING",
      "MACHINING",
      "MATERIAL_RECEIPT",
      "STORAGE",
      "PACKING",
      "DISPATCH",
    ]);
  });

  it("includes each distinct operation only once, keeping first-seen order", () => {
    const steps = deriveProcessStepList([item1, item2]);
    const inspectionCount = steps.filter((s) => s.operationCode === "INSPECTION").length;
    expect(inspectionCount).toBe(1);
    expect(steps[1]).toEqual({ operationCode: "INSPECTION", operationName: "Inspection", symbol: "INSPECTION" });
  });

  it("orders steps within a route by sequence, not input array order", () => {
    const shuffled: RouteInput = {
      childPartItemNo: 1,
      steps: [...item1.steps].reverse(),
    };
    const steps = deriveProcessStepList([shuffled]);
    expect(steps.map((s) => s.operationCode)).toEqual(["PLASMA_CUTTING", "INSPECTION", "CHAMFERING"]);
  });

  it("puts the before-stages steps first and sub-assembly steps between child parts and the main assembly", () => {
    const step = (operationCode: string, sequence: number): RouteInput["steps"][number] => ({
      operationCode,
      operationName: operationCode,
      symbol: "OPERATION",
      sequence,
    });
    const steps = deriveProcessStepList([
      { childPartItemNo: null, steps: [step("PACKING", 0)] },
      { childPartItemNo: null, structure: { kind: "SUB_ASSEMBLY", rank: 2 }, steps: [step("FULL_WELDING", 0)] },
      { childPartItemNo: null, structure: { kind: "SUB_ASSEMBLY", rank: 1 }, steps: [step("TACK_WELDING", 0)] },
      { childPartItemNo: 1, steps: [step("PLASMA_CUTTING", 0)] },
      { childPartItemNo: null, structure: { kind: "PRE_STAGE" }, steps: [step("RAW_MATERIAL", 0), step("KITTING", 1)] },
    ]);
    expect(steps.map((s) => s.operationCode)).toEqual(["RAW_MATERIAL", "KITTING", "PLASMA_CUTTING", "TACK_WELDING", "FULL_WELDING", "PACKING"]);
  });

  it("returns an empty list for no routes", () => {
    expect(deriveProcessStepList([])).toEqual([]);
  });
});
