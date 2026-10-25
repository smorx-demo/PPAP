import { describe, expect, it } from "vitest";
import { numberAssemblyStructure } from "./pfc-numbering";

describe("numberAssemblyStructure", () => {
  it("numbers stages, sub-assemblies and child parts hierarchically", () => {
    const result = numberAssemblyStructure([
      {
        name: "Stage 1",
        subAssemblies: [
          { partNo: "SU 1", childParts: [{ partNo: "CP 1" }, { partNo: "CP 2" }] },
          { partNo: "SU 2", childParts: [{ partNo: "CP 3" }] },
        ],
      },
      { name: "Stage 2", subAssemblies: [] },
      { name: "Stage 3", subAssemblies: [{ partNo: "SU 3", childParts: [] }] },
    ]);

    expect(result.map((s) => s.no)).toEqual(["1", "2", "3"]);
    expect(result[0].subAssemblies.map((s) => s.no)).toEqual(["1.1", "1.2"]);
    expect(result[0].subAssemblies[0].childParts.map((c) => c.no)).toEqual(["1.1.1", "1.1.2"]);
    expect(result[0].subAssemblies[1].childParts.map((c) => c.no)).toEqual(["1.2.1"]);
    expect(result[2].subAssemblies[0].no).toBe("3.1");
    expect(result[0].subAssemblies[0].partNo).toBe("SU 1");
  });
});
