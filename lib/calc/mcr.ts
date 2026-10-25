/**
 * Material Clearance Record (MCR) — the cover page printed in front of the
 * uploaded lab reports on element 12 (layout from "MCR 109300003635- NEW
 * REV-9", sheet "Material Clearance record"). Pure functions: grouping the
 * read lab reports into material rows, cell text clean-up, and splitting the
 * table into A4-landscape pages. Data access is in lib/data/mcr.ts.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One test certified in a lab report file, e.g. { type: "C", reportNo: "TRH/24-25/7122-8", date: "19-11-2024" }. */
export const mcrTestSchema = z.object({
  type: z.string(),
  reportNo: z.string(),
  date: z.string(),
});
export type McrTest = z.infer<typeof mcrTestSchema>;

/** One Sr.No. on the MCR: a material that covers one or more item codes. */
export const mcrGroupSchema = z.object({
  /** Stable identity used to merge rebuilt groups with what the user typed ("heat:…|spec:…", or "manual:…"). */
  key: z.string(),
  itemCodes: z.array(z.string()),
  itemDescription: z.string(),
  size: z.string(),
  materialSpec: z.string(),
  materialIdNo: z.string(),
  heatPlateNo: z.string(),
  testCertificate: z.string(),
  /** One NABL report per line, e.g. "C-TRH/24-25/7122-8 19-11-2024". */
  nablReports: z.string(),
});
export type McrGroup = z.infer<typeof mcrGroupSchema>;
export const mcrGroupsSchema = z.array(mcrGroupSchema);

/** What was read (and reviewed) from one uploaded lab report file. */
export type LabDocumentFields = {
  id: string;
  materialSpec: string | null;
  heatNo: string | null;
  plateNo: string | null;
  sizeText: string | null;
  tests: McrTest[];
};

/** The RM Test Report (element 10) row facts the MCR reuses when the heat no. matches. */
export type RmtcFacts = {
  heatNo: string | null;
  plateNo: string | null;
  materialIdNo: string | null;
  millTcNo: string | null;
  /** DD-MM-YYYY */
  millTcDate: string | null;
};

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Cell text as printed: tabs and runs of spaces collapse to one space, each
 * line is trimmed, blank lines dropped, line breaks kept. "N/A" stays as typed.
 */
export function cleanCell(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** "C-TRH/24-25/7122-8 19-11-2024" — the type letter is not repeated when the report no. already starts with it. */
export function nablLine(test: McrTest): string {
  const type = cleanCell(test.type).toUpperCase();
  const reportNo = cleanCell(test.reportNo);
  const prefixed = !type || reportNo.toUpperCase().startsWith(`${type}-`) ? reportNo : `${type}-${reportNo}`;
  return [prefixed, cleanCell(test.date)].filter(Boolean).join(" ");
}

const norm = (v: string | null | undefined) => (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A heat / plate value that identifies a material ("N/A", "-", blank don't). */
const identifying = (v: string | null | undefined) => {
  const n = norm(v);
  return n !== "" && n !== "NA";
};

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/** Lab reports of the same material (heat or plate no. + spec) share one Sr.No.; one with neither stands alone. */
export function groupKeyFor(doc: LabDocumentFields): string {
  const id = identifying(doc.heatNo) ? `heat:${norm(doc.heatNo)}` : identifying(doc.plateNo) ? `plate:${norm(doc.plateNo)}` : null;
  return id ? `${id}|spec:${norm(doc.materialSpec)}` : `doc:${doc.id}`;
}

const emptyGroup = (key: string): McrGroup => ({
  key,
  itemCodes: [],
  itemDescription: "",
  size: "",
  materialSpec: "",
  materialIdNo: "",
  heatPlateNo: "",
  testCertificate: "",
  nablReports: "",
});

function mergeLines(...blocks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of blocks.flatMap((b) => cleanCell(b).split("\n")).filter(Boolean)) {
    const k = norm(line);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(line);
    }
  }
  return out.join("\n");
}

/**
 * Groups built from the lab documents (in upload order), merged into the
 * user's existing groups: anything the user typed wins over what the
 * documents say, NABL lines are added (never removed), groups the user added
 * by hand or whose documents were deleted are kept, and new groups go last.
 */
export function buildMcrGroups(docs: LabDocumentFields[], rmtc: RmtcFacts[], existing: McrGroup[] = []): McrGroup[] {
  const rmtcByHeat = new Map<string, RmtcFacts>();
  for (const r of rmtc) {
    for (const id of [r.heatNo, r.plateNo]) if (identifying(id) && !rmtcByHeat.has(norm(id))) rmtcByHeat.set(norm(id), r);
  }

  const built = new Map<string, McrGroup>();
  for (const doc of docs) {
    const key = groupKeyFor(doc);
    const g = built.get(key) ?? emptyGroup(key);
    g.materialSpec ||= cleanCell(doc.materialSpec);
    g.size ||= cleanCell(doc.sizeText);
    g.heatPlateNo ||= [doc.heatNo, doc.plateNo].map(cleanCell).filter((v) => identifying(v)).join(" / ");
    const facts = rmtcByHeat.get(norm(doc.heatNo)) ?? rmtcByHeat.get(norm(doc.plateNo));
    if (facts) {
      g.materialIdNo ||= cleanCell(facts.materialIdNo);
      g.testCertificate ||= cleanCell([facts.millTcNo, facts.millTcDate].filter(Boolean).join("\n"));
    }
    g.nablReports = mergeLines(g.nablReports, ...doc.tests.map(nablLine));
    built.set(key, g);
  }

  const result: McrGroup[] = existing.map((old) => {
    const fresh = built.get(old.key);
    built.delete(old.key);
    if (!fresh) return old;
    return {
      ...fresh,
      ...Object.fromEntries(Object.entries(old).filter(([k, v]) => k !== "nablReports" && (Array.isArray(v) ? v.length > 0 : v !== ""))),
      itemCodes: old.itemCodes,
      nablReports: mergeLines(old.nablReports, fresh.nablReports),
    } as McrGroup;
  });
  return [...result, ...built.values()];
}

// ---------------------------------------------------------------------------
// Pagination (A4 landscape)
// ---------------------------------------------------------------------------

/** Column widths in mm (sum 277 = A4 landscape minus 10 mm margins), in print order. */
export const MCR_COLUMNS = [
  { key: "srNo", label: "Sr.No.", mm: 12 },
  { key: "itemCode", label: "Item Code", mm: 36 },
  { key: "itemDescription", label: "Item Description", mm: 24 },
  { key: "size", label: "Size/ Qty (Nos)", mm: 30 },
  { key: "materialSpec", label: "Material Spec", mm: 36 },
  { key: "materialIdNo", label: "Material Identification No.", mm: 28 },
  { key: "heatPlateNo", label: "Heat No./ Plate No.", mm: 28 },
  { key: "testCertificate", label: "Test Certificate No & Date", mm: 32 },
  { key: "nablReports", label: "NABL Reports No.", mm: 51 },
] as const;

/** Layout constants (mm) shared with the print component so estimate and render agree. */
export const MCR_LAYOUT = {
  /** Height available to table body rows on one page, after title, header block, table header and footer (measured ≈137 mm). */
  bodyMm: 134,
  /** One item-code row. */
  rowMm: 5.2,
  /** One wrapped text line in a merged cell (8 pt). */
  lineMm: 3.6,
  /** Cell top + bottom padding. */
  padMm: 1.6,
  /** 8 pt Arial digit width (the widest common character in these cells), so wrapping is never under-estimated. */
  charMm: 1.6,
  /** A group with at least this many item codes may continue on the next page instead of leaving a half-empty page… */
  splitMinCodes: 8,
  /** …provided at least this many of its rows fit in the space left on the current page. */
  splitMinRows: 4,
  /** Sign-off block (3 boxes). */
  signOffMm: 34,
};

function wrappedLines(text: string, widthMm: number): number {
  const perLine = Math.max(1, Math.floor((widthMm - 2) / MCR_LAYOUT.charMm));
  return Math.max(1, cleanCell(text).split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0));
}

/** Estimated height of a group whose item-code rows are `itemCodes`. */
export function groupHeightMm(group: McrGroup, itemCodes: string[] = group.itemCodes): number {
  const col = (k: string) => MCR_COLUMNS.find((c) => c.key === k)!.mm;
  const merged = Math.max(
    ...(["itemDescription", "size", "materialSpec", "materialIdNo", "heatPlateNo", "testCertificate", "nablReports"] as const).map((k) =>
      wrappedLines(group[k], col(k)),
    ),
  );
  const codeRows = Math.max(1, itemCodes.length);
  const codesMm = itemCodes.reduce((h, c) => h + Math.max(MCR_LAYOUT.rowMm, wrappedLines(c, col("itemCode")) * MCR_LAYOUT.lineMm + MCR_LAYOUT.padMm), 0);
  return Math.max(codesMm || MCR_LAYOUT.rowMm * codeRows, merged * MCR_LAYOUT.lineMm + MCR_LAYOUT.padMm);
}

// ---------------------------------------------------------------------------
// Enclosed lab reports (the files printed after the cover)
// ---------------------------------------------------------------------------

/** One uploaded lab report file as listed on the cover, in print order. */
export type McrEnclosure = {
  no: number;
  fileName: string;
  labName: string;
  materialSpec: string;
  heatPlateNo: string;
  /** NABL lines, one per test ("C-TRH/24-25/7122-8 19-11-2024"). */
  tests: string;
  /** Pages this file adds to the print (null when it can't be counted — it then gets an error page). */
  pages: number | null;
};

export const MCR_ENCLOSURE_COLUMNS = [
  { key: "no", label: "No.", mm: 10 },
  { key: "fileName", label: "Lab report file", mm: 62 },
  { key: "labName", label: "Laboratory", mm: 40 },
  { key: "materialSpec", label: "Material Spec", mm: 38 },
  { key: "heatPlateNo", label: "Heat No./ Plate No.", mm: 33 },
  { key: "tests", label: "Test Reports No. & Date", mm: 74 },
  { key: "pages", label: "Pages", mm: 20 },
] as const;

/** Heading + table header of the enclosures list (repeated on each page it continues on). */
const ENCLOSURE_HEAD_MM = 12;

export function enclosureHeightMm(e: McrEnclosure): number {
  const col = (k: string) => MCR_ENCLOSURE_COLUMNS.find((c) => c.key === k)!.mm;
  const lines = Math.max(
    wrappedLines(e.fileName, col("fileName")),
    wrappedLines(e.labName, col("labName")),
    wrappedLines(e.materialSpec, col("materialSpec")),
    wrappedLines(e.heatPlateNo, col("heatPlateNo")),
    wrappedLines(e.tests, col("tests")),
  );
  return Math.max(MCR_LAYOUT.rowMm, lines * MCR_LAYOUT.lineMm + MCR_LAYOUT.padMm);
}

/** The enclosure rows from the read lab documents, in print order. */
export function mcrEnclosures(
  docs: (LabDocumentFields & { fileName: string; labName: string | null })[],
  pageCounts: (number | null)[] = [],
): McrEnclosure[] {
  return docs.map((d, i) => ({
    no: i + 1,
    fileName: cleanCell(d.fileName),
    labName: cleanCell(d.labName),
    materialSpec: cleanCell(d.materialSpec),
    heatPlateNo: [d.heatNo, d.plateNo].map(cleanCell).filter((v) => identifying(v)).join(" / "),
    tests: d.tests.map(nablLine).join("\n"),
    pages: pageCounts[i] ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** A slice of one group on one page (a group too tall for a page continues on the next, rows never split). */
export type McrPageGroup = { srNo: number; group: McrGroup; itemCodes: string[]; continued: boolean };
export type McrPage = { groups: McrPageGroup[]; enclosures: McrEnclosure[]; signOff: boolean };

/**
 * Splits the cover into pages: the material groups, then the list of enclosed
 * lab reports, then the sign-off block. A group that doesn't fit moves whole to
 * the next page, except a big one (≥ splitMinCodes item codes) when at least
 * splitMinRows of its rows fit in the space left, and any group taller than a
 * page: those continue between item-code rows, merged cells repeated and marked
 * "contd.". Rows, enclosure rows and the sign-off never split.
 */
export function paginateMcr(groups: McrGroup[], enclosures: McrEnclosure[] = []): McrPage[] {
  const pages: McrPage[] = [];
  let current: McrPageGroup[] = [];
  let currentEnc: McrEnclosure[] = [];
  let used = 0;
  const flush = () => {
    pages.push({ groups: current, enclosures: currentEnc, signOff: false });
    current = [];
    currentEnc = [];
    used = 0;
  };

  groups.forEach((group, i) => {
    const srNo = i + 1;
    const whole = groupHeightMm(group);
    const splitHere =
      used + whole > MCR_LAYOUT.bodyMm &&
      group.itemCodes.length >= MCR_LAYOUT.splitMinCodes &&
      used + groupHeightMm(group, group.itemCodes.slice(0, MCR_LAYOUT.splitMinRows)) <= MCR_LAYOUT.bodyMm;
    if (whole <= MCR_LAYOUT.bodyMm && !splitHere) {
      if (used + whole > MCR_LAYOUT.bodyMm && current.length) flush();
      current.push({ srNo, group, itemCodes: group.itemCodes, continued: false });
      used += whole;
      return;
    }
    // Big or taller than a page: fill the rest of this page, then whole pages, row by row.
    let codes = group.itemCodes.length ? group.itemCodes : [""];
    let continued = false;
    while (codes.length) {
      let take = 0;
      while (take < codes.length && used + groupHeightMm(group, codes.slice(0, take + 1)) <= MCR_LAYOUT.bodyMm) take++;
      if (take === 0) {
        if (current.length) {
          flush();
          continue;
        }
        take = 1; // a single row taller than a page still has to go somewhere
      }
      current.push({ srNo, group, itemCodes: codes.slice(0, take).filter((c) => c !== ""), continued });
      used += groupHeightMm(group, codes.slice(0, take));
      codes = codes.slice(take);
      continued = true;
      if (codes.length) flush();
    }
  });

  for (const e of enclosures) {
    const h = enclosureHeightMm(e) + (currentEnc.length ? 0 : ENCLOSURE_HEAD_MM);
    if (used + h > MCR_LAYOUT.bodyMm && (current.length || currentEnc.length)) flush();
    used += enclosureHeightMm(e) + (currentEnc.length ? 0 : ENCLOSURE_HEAD_MM);
    currentEnc.push(e);
  }

  if (used + MCR_LAYOUT.signOffMm > MCR_LAYOUT.bodyMm && (current.length || currentEnc.length)) flush();
  pages.push({ groups: current, enclosures: currentEnc, signOff: true });
  return pages;
}

/** "MCR IE-MCR-TB-RH-01 – Page 2 of 5" */
export function mcrFooter(mcrNumber: string | null | undefined, page: number, total: number): string {
  const no = cleanCell(mcrNumber);
  return `${no ? `MCR ${no}` : "MCR"} – Page ${page} of ${total}`;
}
