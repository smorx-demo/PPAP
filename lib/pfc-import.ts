import ExcelJS from "exceljs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Shared import logic for element 5 (Process Flow Chart). Used both by
 * prisma/seed.ts (importing the reference sample directly) and by the
 * real "Import Excel" server action (lib/actions/pfc.ts) — one code path,
 * so the seeded demo data and the tested import feature never drift.
 *
 * Reproduces the "5. PFC" sheet's mirrored layout: left items (1-40) read
 * left-to-right in columns 6-13, right items (41-N) read right-to-left in
 * columns 21-26, with item no / part no / description / qty / sketch
 * mirrored in columns 1-5 and 27-31 respectively.
 */

const LEFT_PROCESS_COLS = [6, 7, 8, 9, 10, 11, 12, 13];
const RIGHT_PROCESS_COLS = [26, 25, 24, 23, 22, 21];

// Canonical Operation.name lookup for raw sheet text, keyed by the
// normalized (whitespace-collapsed, uppercased) cell text. Deliberately
// narrow — includes the 3 known typos (INSPCETION, CHMAFERING,
// BANDSAWCUTTING) call out in the spec. Compound cells like "TAPPING &
// COUNTER DRILLING" are handled separately (split on "&") unless the
// whole phrase matches a canonical compound operation like
// "Drilling & tapping" exactly.
const OPERATION_NAME_MAP: Record<string, string> = {
  "PLASMA CUTTING": "Plasma cutting",
  "LASER CUTTING": "Laser cutting",
  "BANDSAW CUTTING": "Bandsaw cutting",
  "BANDSAWCUTTING": "Bandsaw cutting",
  "CHAMFERING": "Chamfering",
  "CHMAFERING": "Chamfering",
  "MACHINING": "Machining",
  "DRILLING": "Drilling",
  "TAPPING": "Tapping",
  "COUNTER DRILLING": "Counter drilling",
  "DRILLING & TAPPING": "Drilling & tapping",
  "BENDING": "Bending",
  "ROLLING": "Rolling",
  "SUB ASSEMBLY": "Sub assembly",
  "TACK WELDING": "Tack welding",
  "WELDING": "Welding",
  "GRINDING/DRESSING": "Grinding/Dressing",
  "GRINDING": "Grinding/Dressing",
  "SHOT BLASTING": "Shot blasting",
  "PAINTING": "Painting",
  "INSPECTION": "Inspection",
  "INSPCETION": "Inspection",
  "PACKING": "Packing",
  "DISPATCH": "Dispatch",
  "MATERIAL RECEIPT": "Material Receipt",
  "STORAGE": "Storage",
  "NESTING": "Nesting",
};

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const rt = v as { richText?: { text: string }[]; text?: string };
    if (rt.richText) return rt.richText.map((r) => r.text).join("");
    if (rt.text) return rt.text;
    return "";
  }
  return String(v).trim();
}

function normalizeStepTokens(raw: string): string[] {
  const cleaned = raw.replace(/\s+/g, " ").trim().toUpperCase();
  if (!cleaned) return [];
  const direct = OPERATION_NAME_MAP[cleaned];
  if (direct) return [direct];
  // Not a direct/compound match — split on "&" and map each piece.
  return cleaned
    .split(/\s*&\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const mapped = OPERATION_NAME_MAP[part];
      if (!mapped) throw new Error(`Unrecognized process step text: "${part}" (from "${raw}")`);
      return mapped;
    });
}

type ParsedItem = {
  itemNo: number;
  partNo: string;
  description: string;
  qty: number;
  side: "LEFT" | "RIGHT";
  type: "MAKE" | "BOP";
  stepNames: string[];
  sketch: { buffer: Buffer; extension: string } | null;
};

function findPfcSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const sheet = workbook.worksheets.find((s) => /PFC/i.test(s.name));
  if (!sheet) throw new Error('No "PFC" sheet found in the uploaded workbook.');
  return sheet;
}

function parsePfcSheet(sheet: ExcelJS.Worksheet): ParsedItem[] {
  const items: ParsedItem[] = [];

  const images = sheet.getImages();
  const imageByAnchor = new Map<string, { buffer: Buffer; extension: string }>();
  for (const img of images) {
    const tl = (img.range as unknown as { tl: { nativeCol: number; nativeRow: number } }).tl;
    const media = (sheet.workbook.model.media as unknown as { index: number; buffer: Buffer; extension: string }[]).find(
      (m) => m.index === Number(img.imageId),
    );
    if (!media) continue;
    imageByAnchor.set(`${tl.nativeCol}:${tl.nativeRow}`, {
      buffer: media.buffer,
      extension: media.extension === "jpeg" ? "jpg" : media.extension,
    });
  }

  for (let r = 4; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);

    const leftItemNoText = cellText(row.getCell(1).value);
    if (leftItemNoText && Number.isInteger(Number(leftItemNoText)) && Number(leftItemNoText) > 0) {
      const rawSteps: string[] = [];
      for (const c of LEFT_PROCESS_COLS) {
        const t = cellText(row.getCell(c).value);
        if (t) rawSteps.push(t);
      }
      const isBop = rawSteps[0]?.trim().toUpperCase() === "BOP";
      const stepNames = (isBop ? rawSteps.slice(1) : rawSteps).flatMap(normalizeStepTokens);
      items.push({
        itemNo: Number(leftItemNoText),
        partNo: cellText(row.getCell(2).value),
        description: cellText(row.getCell(3).value).replace(/\s+/g, " ").trim(),
        qty: Number(cellText(row.getCell(4).value)) || 0,
        side: "LEFT",
        type: isBop ? "BOP" : "MAKE",
        stepNames,
        sketch: imageByAnchor.get(`4:${r - 1}`) ?? null, // col E is index 4 (0-based)
      });
    }

    const rightItemNoText = cellText(row.getCell(31).value);
    if (rightItemNoText && Number.isInteger(Number(rightItemNoText)) && Number(rightItemNoText) > 0) {
      const rawSteps: string[] = [];
      for (const c of RIGHT_PROCESS_COLS) {
        const t = cellText(row.getCell(c).value);
        if (t) rawSteps.push(t);
      }
      const isBop = rawSteps[0]?.trim().toUpperCase() === "BOP";
      const stepNames = (isBop ? rawSteps.slice(1) : rawSteps).flatMap(normalizeStepTokens);
      items.push({
        itemNo: Number(rightItemNoText),
        partNo: cellText(row.getCell(30).value),
        description: cellText(row.getCell(29).value).replace(/\s+/g, " ").trim(),
        qty: Number(cellText(row.getCell(28).value)) || 0,
        side: "RIGHT",
        type: isBop ? "BOP" : "MAKE",
        stepNames,
        sketch: imageByAnchor.get(`26:${r - 1}`) ?? null, // col AA is index 26 (0-based)
      });
    }
  }

  items.sort((a, b) => a.itemNo - b.itemNo);
  return items;
}

async function wipeExistingChildParts(ppapElementId: string) {
  const existing = await prisma.childPart.findMany({ where: { ppapElementId }, select: { id: true } });
  const ids = existing.map((c) => c.id);
  if (ids.length === 0) return;

  const routes = await prisma.route.findMany({ where: { childPartId: { in: ids } }, select: { id: true } });
  const routeIds = routes.map((r) => r.id);
  await prisma.routeStep.deleteMany({ where: { routeId: { in: routeIds } } });
  await prisma.route.deleteMany({ where: { id: { in: routeIds } } });
  // Children (those with a parentChildPartId) before parents, to satisfy the FK.
  await prisma.childPart.deleteMany({ where: { ppapElementId, parentChildPartId: { not: null } } });
  await prisma.childPart.deleteMany({ where: { ppapElementId } });
}

export async function importPfcWorkbook(workbook: ExcelJS.Workbook, ppapElementId: string): Promise<{ imported: number }> {
  const sheet = findPfcSheet(workbook);
  const items = parsePfcSheet(sheet);

  const operations = await prisma.operation.findMany();
  const operationIdByName = new Map(operations.map((o) => [o.name, o.id]));

  await wipeExistingChildParts(ppapElementId);

  const sketchDir = path.join(process.cwd(), "storage", "pfc-sketches", ppapElementId);
  await mkdir(sketchDir, { recursive: true });

  // IDs are generated up front (rather than relying on the DB to hand them
  // back) so every row — ChildPart, Route, RouteStep, and the
  // parent/child sub-assembly links — can be built in memory and written
  // with 3 createMany calls total instead of ~500+ sequential creates
  // (81 items × childPart + route + several steps each). That sequential
  // version was slow enough to matter for real users, not just tests.
  const idByPartNo = new Map<string, string>();
  for (const item of items) idByPartNo.set(item.partNo, randomUUID());

  const childPartRows: NonNullable<Parameters<typeof prisma.childPart.createMany>[0]>["data"] = [];
  const routeIdByChildPartId = new Map<string, string>();
  const routeRows: NonNullable<Parameters<typeof prisma.route.createMany>[0]>["data"] = [];
  const routeStepRows: NonNullable<Parameters<typeof prisma.routeStep.createMany>[0]>["data"] = [];

  await Promise.all(
    items.map(async (item) => {
      const id = idByPartNo.get(item.partNo)!;
      let sketchImageUrl: string | null = null;
      let sketchFileName: string | null = null;
      if (item.sketch) {
        sketchFileName = `item-${item.itemNo}.${item.sketch.extension}`;
        await writeFile(path.join(sketchDir, sketchFileName), item.sketch.buffer);
        sketchImageUrl = `/api/files/pfc-sketches/${ppapElementId}/${sketchFileName}`;
      }

      const parentMatch = item.partNo.match(/^(.+)-(\d+)$/);
      const parentChildPartId = parentMatch ? idByPartNo.get(parentMatch[1]) ?? null : null;

      childPartRows.push({
        id,
        ppapElementId,
        itemNo: item.itemNo,
        partNo: item.partNo,
        description: item.description,
        qtyPerAssembly: item.qty,
        side: item.side,
        type: item.type,
        sketchImageUrl,
        sketchFileName,
        parentChildPartId,
        sortOrder: item.itemNo,
      });

      const routeId = randomUUID();
      routeIdByChildPartId.set(id, routeId);
      routeRows.push({ id: routeId, ppapElementId, childPartId: id });

      for (let i = 0; i < item.stepNames.length; i++) {
        const operationId = operationIdByName.get(item.stepNames[i]);
        if (!operationId) {
          throw new Error(`Operation "${item.stepNames[i]}" not found in the operation library (item ${item.itemNo}).`);
        }
        routeStepRows.push({ id: randomUUID(), routeId, operationId, sequence: i });
      }
    }),
  );

  await prisma.childPart.createMany({ data: childPartRows });
  await prisma.route.createMany({ data: routeRows });
  await prisma.routeStep.createMany({ data: routeStepRows });

  return { imported: items.length };
}

/// Standard main-assembly route template described in the spec: material
/// receipt through packing & dispatch. Created once per element — does
/// nothing if a main-assembly route (childPartId null) already exists, so
/// re-running a child-part import never duplicates or resets it.
export async function ensureMainAssemblyRoute(ppapElementId: string): Promise<void> {
  const existing = await prisma.route.findFirst({ where: { ppapElementId, childPartId: null, subAssemblyId: null, preStage: false } });
  if (existing) return;

  const operations = await prisma.operation.findMany();
  const operationIdByName = new Map(operations.map((o) => [o.name, o.id]));

  const template = [
    "Material Receipt",
    "Inspection",
    "Storage",
    "Nesting",
    "Inspection",
    "Sub assembly",
    "Inspection",
    "Welding",
    "Inspection",
    "Grinding/Dressing",
    "Inspection",
    "Shot blasting",
    "Inspection",
    "Painting",
    "Inspection",
    "Packing",
    "Dispatch",
  ];

  const route = await prisma.route.create({
    data: { ppapElementId, childPartId: null, label: "Main Assembly" },
  });

  for (let i = 0; i < template.length; i++) {
    const operationId = operationIdByName.get(template[i]);
    if (!operationId) throw new Error(`Operation "${template[i]}" not found in the operation library.`);
    await prisma.routeStep.create({ data: { routeId: route.id, operationId, sequence: i } });
  }
}

/// Reproduces the "5. PFC" sheet's column layout from the current
/// ChildPart/Route data, for download. Round-trips with importPfcWorkbook
/// (same column positions, same left-to-right / right-to-left step order).
export async function exportPfcWorkbook(ppapElementId: string): Promise<ExcelJS.Workbook> {
  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { id: ppapElementId },
    include: { ppap: { include: { partRevision: { include: { part: true } } } } },
  });
  const childParts = await prisma.childPart.findMany({
    where: { ppapElementId },
    orderBy: { itemNo: "asc" },
    include: { route: { include: { steps: { orderBy: { sequence: "asc" }, include: { operation: true } } } } },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("5. PFC", { pageSetup: { orientation: "landscape" } });

  const title = `FLOW CHART FOR -${element.ppap.partRevision.part.projectModel ?? ""} CHASSIS -${element.ppap.partRevision.part.partNumber} Rev ${element.ppap.partRevision.revision}`;
  sheet.getCell(2, 1).value = title;

  const headerRow = sheet.getRow(3);
  headerRow.getCell(1).value = "Item No";
  headerRow.getCell(2).value = "Part No";
  headerRow.getCell(3).value = "Description";
  headerRow.getCell(4).value = "Qtr/Str";
  headerRow.getCell(5).value = "Sketch";
  for (const c of LEFT_PROCESS_COLS) headerRow.getCell(c).value = "PROCESS";
  for (const c of RIGHT_PROCESS_COLS) headerRow.getCell(c).value = "PROCESS";
  headerRow.getCell(27).value = "Sketch";
  headerRow.getCell(28).value = "Qtr/Str";
  headerRow.getCell(29).value = "Description";
  headerRow.getCell(30).value = "Part No";
  headerRow.getCell(31).value = "Item No";

  const left = childParts.filter((c) => c.side === "LEFT");
  const right = childParts.filter((c) => c.side === "RIGHT");
  const maxRows = Math.max(left.length, right.length);

  for (let i = 0; i < maxRows; i++) {
    const r = 4 + i;
    const row = sheet.getRow(r);

    const lcp = left[i];
    if (lcp) {
      row.getCell(1).value = lcp.itemNo;
      row.getCell(2).value = lcp.partNo;
      row.getCell(3).value = lcp.description;
      row.getCell(4).value = lcp.qtyPerAssembly;
      const stepNames = lcp.type === "BOP" ? ["BOP", ...(lcp.route?.steps.map((s) => s.operation.name) ?? [])] : (lcp.route?.steps.map((s) => s.operation.name) ?? []);
      for (let s = 0; s < stepNames.length && s < LEFT_PROCESS_COLS.length; s++) {
        row.getCell(LEFT_PROCESS_COLS[s]).value = stepNames[s].toUpperCase();
      }
      if (lcp.sketchImageUrl) {
        const buffer = await readSketchBuffer(lcp.sketchImageUrl);
        if (buffer) {
          const ext = path.extname(lcp.sketchFileName ?? "").replace(".", "");
          const imageId = workbook.addImage({ buffer, extension: ext === "jpg" ? "jpeg" : ext } as unknown as ExcelJS.Image);
          sheet.addImage(imageId, { tl: { col: 4, row: r - 1 }, ext: { width: 32, height: 32 } });
        }
      }
    }

    const rcp = right[i];
    if (rcp) {
      row.getCell(31).value = rcp.itemNo;
      row.getCell(30).value = rcp.partNo;
      row.getCell(29).value = rcp.description;
      row.getCell(28).value = rcp.qtyPerAssembly;
      const stepNames = rcp.type === "BOP" ? ["BOP", ...(rcp.route?.steps.map((s) => s.operation.name) ?? [])] : (rcp.route?.steps.map((s) => s.operation.name) ?? []);
      for (let s = 0; s < stepNames.length && s < RIGHT_PROCESS_COLS.length; s++) {
        row.getCell(RIGHT_PROCESS_COLS[s]).value = stepNames[s].toUpperCase();
      }
      if (rcp.sketchImageUrl) {
        const buffer = await readSketchBuffer(rcp.sketchImageUrl);
        if (buffer) {
          const ext = path.extname(rcp.sketchFileName ?? "").replace(".", "");
          const imageId = workbook.addImage({ buffer, extension: ext === "jpg" ? "jpeg" : ext } as unknown as ExcelJS.Image);
          sheet.addImage(imageId, { tl: { col: 26, row: r - 1 }, ext: { width: 32, height: 32 } });
        }
      }
    }
  }

  const footerRow = 4 + maxRows + 2;
  sheet.getCell(footerRow, 1).value = `Date - ${new Date().toISOString().slice(0, 10)}`;
  sheet.getCell(footerRow, 19).value = `Doc Description : ${element.ppap.partRevision.part.partName}`;
  sheet.getCell(footerRow + 1, 19).value = `Doc No : ${element.docNo ?? ""}`;
  sheet.getCell(footerRow + 1, 30).value = "Sheet 1 of 1";

  return workbook;
}

async function readSketchBuffer(url: string): Promise<Buffer | null> {
  const prefix = "/api/files/";
  if (!url.startsWith(prefix)) return null;
  const segments = url.slice(prefix.length).split("/");
  const filePath = path.join(process.cwd(), "storage", ...segments);
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}
