import { describe, expect, it } from "vitest";
import {
  buildMcrGroups,
  cleanCell,
  enclosureHeightMm,
  groupHeightMm,
  groupKeyFor,
  MCR_LAYOUT,
  mcrEnclosures,
  mcrFooter,
  nablLine,
  paginateMcr,
  type McrGroup,
} from "./mcr";

// Values from "MCR 109300003635- NEW REV-9 (Updated)1.xlsx", sheet "Material Clearance record".
const group1Doc = {
  id: "d1",
  materialSpec: " IS513 CRCA",
  heatNo: "24B1471",
  plateNo: null,
  sizeText: "1.6 MM",
  tests: [{ type: "C", reportNo: "TRH/24-25/7122-8", date: "19-11-2024" }],
};
const group3Codes = ["1.1A", "1.1G", "1.1H", "1.1I", "1.2A", "1.2D", "1.2E", "3.3", "3.9", "3.13", "3.29", "17", "18", "19"].map(
  (c) => `109300003635 - ${c}`,
);

const group = (over: Partial<McrGroup>): McrGroup => ({
  key: "k",
  itemCodes: [],
  itemDescription: "PLATE",
  size: "4 MM",
  materialSpec: "S890QL(WELDOX 900E)",
  materialIdNo: "06-24-24",
  heatPlateNo: "N/A",
  testCertificate: "N/A",
  nablReports: "C-TRH/25-26/11283-6 11-03-2026\nM-TRH/25-26/11283-4 11-03-2026",
  ...over,
});

describe("cleanCell", () => {
  it("trims tabs / stray spaces, keeps line breaks, keeps N/A", () => {
    expect(cleanCell("INGENIOUS ENGINEERING PVT LTD\t")).toBe("INGENIOUS ENGINEERING PVT LTD");
    expect(cleanCell("C-TRH/24-25/7122-8 19-11-2024    \n        ")).toBe("C-TRH/24-25/7122-8 19-11-2024");
    expect(cleanCell("3 MM\n5 mm Machined to 3 mm")).toBe("3 MM\n5 mm Machined to 3 mm");
    expect(cleanCell("N/A")).toBe("N/A");
    expect(cleanCell(null)).toBe("");
  });
});

describe("nablLine", () => {
  it("prefixes the test type unless the report no. already carries it", () => {
    expect(nablLine({ type: "c", reportNo: "TRH/24-25/7122-8", date: "19-11-2024" })).toBe("C-TRH/24-25/7122-8 19-11-2024");
    expect(nablLine({ type: "UT", reportNo: "UT-IE-UT-15", date: "11-11-2024" })).toBe("UT-IE-UT-15 11-11-2024");
    expect(nablLine({ type: "", reportNo: "IE-UT-17", date: "" })).toBe("IE-UT-17");
  });
});

describe("buildMcrGroups", () => {
  it("groups reports of the same heat + spec and stacks their NABL lines", () => {
    const docs = [
      { id: "a", materialSpec: "S890QL(WELDOX 900E)", heatNo: "529437 1", plateNo: null, sizeText: "10 MM", tests: [{ type: "C", reportNo: "TRH/24-25/7122-5", date: "19-11-2024" }] },
      { id: "b", materialSpec: "S890QL (WELDOX 900E)", heatNo: "5294371", plateNo: null, sizeText: null, tests: [{ type: "M", reportNo: "TRH/24-25/7122-5", date: "19-11-2024" }] },
      group1Doc,
    ];
    const groups = buildMcrGroups(docs, []);
    expect(groups).toHaveLength(2);
    expect(groups[0].nablReports).toBe("C-TRH/24-25/7122-5 19-11-2024\nM-TRH/24-25/7122-5 19-11-2024");
    expect(groups[0].size).toBe("10 MM");
    expect(groups[1]).toMatchObject({ materialSpec: "IS513 CRCA", heatPlateNo: "24B1471", size: "1.6 MM", nablReports: "C-TRH/24-25/7122-8 19-11-2024" });
  });

  it("takes material ID and mill TC no. & date from the RM Test Report row with the same heat no.", () => {
    const [g] = buildMcrGroups([group1Doc], [{ heatNo: "24b1471", plateNo: null, materialIdNo: "11-24-01", millTcNo: "906140321", millTcDate: "12-06-2024" }]);
    expect(g.materialIdNo).toBe("11-24-01");
    expect(g.testCertificate).toBe("906140321\n12-06-2024");
  });

  it("keeps what the user typed, adds new NABL lines, keeps manual groups, appends new groups", () => {
    const key = groupKeyFor(group1Doc);
    const existing = [
      group({ key: "manual:1", itemCodes: ["X-1"] }),
      group({ key, itemCodes: ["109300003635 - 1P", "109300003635 - 1R"], itemDescription: "PLATE", size: "1.6 MM (typed)", materialSpec: "", nablReports: "C-TRH/24-25/7122-8 19-11-2024" }),
    ];
    const extra = { ...group1Doc, id: "d2", tests: [{ type: "M", reportNo: "TRH/24-25/7122-8", date: "19-11-2024" }] };
    const other = { ...group1Doc, id: "d3", heatNo: "623533", materialSpec: "S 700 MC" };
    const groups = buildMcrGroups([group1Doc, extra, other], [], existing);
    expect(groups.map((g) => g.key)).toEqual(["manual:1", key, groupKeyFor(other)]);
    expect(groups[1]).toMatchObject({
      itemCodes: ["109300003635 - 1P", "109300003635 - 1R"],
      size: "1.6 MM (typed)",
      materialSpec: "IS513 CRCA", // blank typed value falls back to the document
      nablReports: "C-TRH/24-25/7122-8 19-11-2024\nM-TRH/24-25/7122-8 19-11-2024",
    });
  });

  it("treats a blank or N/A heat no. as no material identity", () => {
    expect(groupKeyFor({ ...group1Doc, heatNo: "N/A" })).toBe("doc:d1");
    expect(groupKeyFor({ ...group1Doc, heatNo: null, plateNo: "3414100/2" })).toMatch(/^plate:/);
  });
});

describe("paginateMcr", () => {
  // The real record: 21 groups covering ~105 item codes.
  const sizes = [2, 5, 14, 13, 2, 3, 4, 6, 5, 7, 3, 2, 4, 6, 2, 1, 1, 2, 1, 1, 1];
  const groups = sizes.map((n, i) => group({ key: `g${i}`, itemCodes: Array.from({ length: n }, (_, j) => `109300003635 - ${i}.${j}`) }));

  it("puts every item code on exactly one page, in order, and ends with the sign-off", () => {
    const pages = paginateMcr(groups);
    expect(pages.length).toBeGreaterThan(1);
    const codes = pages.flatMap((p) => p.groups.flatMap((g) => g.itemCodes));
    expect(codes).toEqual(groups.flatMap((g) => g.itemCodes));
    expect(pages.filter((p) => p.signOff)).toHaveLength(1);
    expect(pages.at(-1)!.signOff).toBe(true);
  });

  it("never overfills a page; small groups stay together, big ones split only with enough rows left", () => {
    for (const page of paginateMcr(groups)) {
      const used = page.groups.reduce((h, g) => h + groupHeightMm(g.group, g.itemCodes), 0);
      expect(used).toBeLessThanOrEqual(MCR_LAYOUT.bodyMm);
    }
    // Small groups never split; a big group that continues leaves ≥ splitMinRows rows on the page it starts on.
    const slices = paginateMcr(groups).flatMap((p) => p.groups);
    for (const g of groups.filter((g) => g.itemCodes.length < MCR_LAYOUT.splitMinCodes)) {
      expect(slices.filter((s) => s.group.key === g.key)).toHaveLength(1);
    }
    for (const s of slices.filter((s) => !s.continued && s.itemCodes.length < s.group.itemCodes.length)) {
      expect(s.itemCodes.length).toBeGreaterThanOrEqual(MCR_LAYOUT.splitMinRows);
    }
  });

  it("splits only a group taller than a page, between rows, marking the continuation", () => {
    const huge = group({ key: "huge", itemCodes: Array.from({ length: 60 }, (_, j) => `CODE-${j}`) });
    const pages = paginateMcr([huge]);
    const slices = pages.flatMap((p) => p.groups);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices[0].continued).toBe(false);
    expect(slices.slice(1).every((s) => s.continued)).toBe(true);
    expect(slices.flatMap((s) => s.itemCodes)).toEqual(huge.itemCodes);
  });

  it("keeps the real 14-item-code group 3 on one page", () => {
    const g3 = group({ key: "g3", itemCodes: group3Codes });
    const slices = paginateMcr([group({ key: "g1", itemCodes: ["109300003635 - 1P", "109300003635 - 1R"] }), g3]).flatMap((p) => p.groups);
    expect(slices.filter((s) => s.group.key === "g3")).toHaveLength(1);
  });

  it("returns a single sign-off page when there are no groups", () => {
    expect(paginateMcr([])).toEqual([{ groups: [], enclosures: [], signOff: true }]);
  });

  it("lists the enclosed lab reports after the groups, in print order, before the sign-off", () => {
    const encs = mcrEnclosures(
      [
        { ...group1Doc, fileName: "chem.pdf", labName: "TRH" },
        { id: "d2", fileName: "mech.pdf", labName: "TRH", materialSpec: "S890QL", heatNo: "N/A", plateNo: "3414100/2", sizeText: null, tests: [{ type: "M", reportNo: "TRH/24-25/7122-5", date: "19-11-2024" }] },
      ],
      [2, null],
    );
    expect(encs[0]).toMatchObject({ no: 1, heatPlateNo: "24B1471", tests: "C-TRH/24-25/7122-8 19-11-2024", pages: 2 });
    expect(encs[1]).toMatchObject({ no: 2, heatPlateNo: "3414100/2", pages: null });
    const pages = paginateMcr(groups, encs);
    expect(pages.flatMap((p) => p.enclosures.map((e) => e.no))).toEqual([1, 2]);
    expect(pages.at(-1)!.signOff).toBe(true);
    for (const page of pages) {
      const used =
        page.groups.reduce((h, g) => h + groupHeightMm(g.group, g.itemCodes), 0) +
        page.enclosures.reduce((h, e) => h + enclosureHeightMm(e), 0) +
        (page.enclosures.length ? 12 : 0);
      expect(used).toBeLessThanOrEqual(MCR_LAYOUT.bodyMm);
    }
  });

  it("carries a long enclosure list over to further pages", () => {
    const many = mcrEnclosures(Array.from({ length: 40 }, (_, i) => ({ ...group1Doc, id: `d${i}`, fileName: `r${i}.pdf`, labName: "TRH" })));
    const pages = paginateMcr([], many);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.enclosures.map((e) => e.no))).toEqual(many.map((e) => e.no));
  });
});

describe("mcrFooter", () => {
  it("formats the cover-page footer", () => {
    expect(mcrFooter("IE-MCR-TB-RH-01", 2, 5)).toBe("MCR IE-MCR-TB-RH-01 – Page 2 of 5");
    expect(mcrFooter(null, 1, 1)).toBe("MCR – Page 1 of 1");
  });
});
