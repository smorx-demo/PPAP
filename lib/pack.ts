import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, PageSizes } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { resolveStoredFilePath } from "@/lib/storage";
import { autoballoonFetch } from "@/lib/autoballoon";
import { renderPrintRoutesToPdfs } from "@/lib/pdf";
import { addOutline, type OutlineItem } from "@/lib/pdf-outline";
import { getCheckingAidsForPpap } from "@/lib/instruments";
import { exportFullWorkbook } from "@/lib/workbook-export";
import { PPAP_ELEMENT_NAMES, PORTRAIT_ELEMENT_NOS } from "@/lib/constants/ppap-elements";
import { submissionElementNos } from "@/lib/calc/submission-level";

/**
 * PPAP pack: one bookmarked PDF in element order (only applicable
 * elements — N/A ones are left out; the checklist cover is always in), each
 * element's print view followed by its attachments, plus a ZIP with the
 * same files in the 4 reference folders of PPAP_Document_List.xlsx.
 */

/** The 4 reference folders (PPAP_Document_List.xlsx, column "Referance Folder"); the checklist cover sits at the root. */
export function packFolder(elementNo: number): string | null {
  if (elementNo === 0) return null;
  if (elementNo <= 3) return "Drawing & Engineering";
  if (elementNo <= 7) return "Manufacturing Process & Risk";
  if (elementNo <= 10) return "Inspection & Testing";
  return "Validation & Approval";
}

export type PackAttachment = { name: string; url: string; source: string };
export type PackElement = { elementNo: number; name: string; docNo: string | null; attachments: PackAttachment[] };

/** Applicable elements and each one's attached files (drawings, MTCs, certificates, signed copies, evidence…). */
export async function getPackManifest(ppapId: string): Promise<{ included: PackElement[]; excluded: { elementNo: number; reason: string | null }[] }> {
  const elements = await prisma.ppapElement.findMany({ where: { ppapId }, orderBy: { elementNo: "asc" }, include: { customerDisposition: true } });
  const id = (n: number) => elements.find((e) => e.elementNo === n)!.id;

  const att = new Map<number, PackAttachment[]>();
  const add = (n: number, name: string | null | undefined, url: string | null | undefined, source: string) => {
    if (!url) return;
    const list = att.get(n) ?? [];
    if (!list.some((a) => a.url === url)) list.push({ name: name || path.basename(url), url, source });
    att.set(n, list);
  };

  for (const f of await prisma.drawingFile.findMany({ where: { ppapElementId: id(1), status: "ACTIVE" }, orderBy: { uploadedAt: "asc" } })) add(1, f.fileName, f.fileUrl, `Drawing (Rev ${f.revision})`);
  const dr = await prisma.designRecordDetail.findUnique({ where: { ppapElementId: id(1) } });
  add(1, dr?.ballooningImageName, dr?.ballooningImageUrl, "Ballooned drawing");
  // Design Records' AutoBalloon workspace: ballooned drawing + inspection report,
  // fetched from the service when the pack is built (readStored); the links
  // go through the PPAP proxy so they also open from the pack page.
  if (dr?.autoballoonJobId) {
    const base = `/api/ppap/${encodeURIComponent(ppapId)}/autoballoon/api/jobs/${encodeURIComponent(dr.autoballoonJobId)}`;
    add(1, "Ballooned drawing.pdf", `${base}/download/ballooned`, "Ballooned drawing");
    add(1, "Inspection report.pdf", `${base}/report/pdf`, "Inspection report");
  }
  for (const a of await prisma.ceaAttachment.findMany({ where: { ppapElementId: id(3) }, orderBy: { uploadedAt: "asc" } })) add(3, a.fileName, a.fileUrl, "CEA attachment");
  for (const r of await prisma.rmtcReportRow.findMany({ where: { rmtcReportDetail: { ppapElementId: id(10) } }, orderBy: { sortOrder: "asc" } })) {
    add(10, r.mtcFileName ?? `MTC ${r.millTcNo ?? r.slNo}`, r.mtcFileUrl, `Mill test certificate${r.heatNo ? ` — heat ${r.heatNo}` : ""}`);
  }
  for (const l of await prisma.labReport.findMany({ where: { ppapElementId: id(12) }, orderBy: { sortOrder: "asc" }, include: { lab: true } })) {
    add(12, l.labPdfName, l.labPdfUrl, `Signed lab report ${l.reportNo ?? ""}`.trim());
    add(12, l.lab?.certificatePdfName, l.lab?.certificatePdfUrl, `Accreditation — ${l.lab?.name}`);
  }
  const aids = await getCheckingAidsForPpap(ppapId);
  for (const i of aids.instruments) {
    const cert = await prisma.calibrationRecord.findFirst({ where: { instrumentId: i.id, certificateFileUrl: { not: null } }, orderBy: { calibratedOn: "desc" } });
    add(16, cert?.certificateFileName, cert?.certificateFileUrl, `Calibration certificate — ${i.ieIdNo ?? i.description}`);
  }
  for (const f of aids.fixtures) {
    add(16, f.drawingFileName, f.drawingFileUrl, `Fixture drawing — ${f.code}`);
    add(16, f.validationRecordName, f.validationRecordUrl, `Fixture validation — ${f.code}`);
  }
  for (const c of await prisma.csrCompliance.findMany({ where: { ppapElementId: id(17), evidenceFileUrl: { not: null } } })) add(17, c.evidenceFileName, c.evidenceFileUrl, "CSR evidence");
  for (const e of elements) add(e.elementNo, e.customerDisposition?.signedFileName, e.customerDisposition?.signedFileUrl, "Customer-signed copy");

  return {
    included: elements
      .filter((e) => e.elementNo === 0 || e.applicability !== "NA")
      .map((e) => ({ elementNo: e.elementNo, name: PPAP_ELEMENT_NAMES[e.elementNo], docNo: e.docNo, attachments: att.get(e.elementNo) ?? [] })),
    excluded: elements.filter((e) => e.elementNo !== 0 && e.applicability === "NA").map((e) => ({ elementNo: e.elementNo, reason: e.naReason })),
  };
}

/** AutoBalloon proxy URL (see getPackManifest) → the service path it forwards to. */
const AUTOBALLOON_PACK_URL = /^\/api\/ppap\/[^/]+\/autoballoon(\/api\/jobs\/[^/]+\/(download\/ballooned|report\/pdf))$/;

async function readStored(url: string): Promise<Buffer | null> {
  const autoballoon = AUTOBALLOON_PACK_URL.exec(url);
  if (autoballoon) {
    // Already authorised by the pack route; a stopped service or a job without
    // balloons just leaves these two files out, like a missing stored file.
    try {
      const res = await autoballoonFetch(autoballoon[1]);
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }
  if (!url.startsWith("/api/files/")) return null;
  try {
    return await readFile(resolveStoredFilePath(url.slice("/api/files/".length).split("/").map(decodeURIComponent)));
  } catch {
    return null;
  }
}

const kindOf = (name: string, buf: Buffer) =>
  buf.subarray(0, 4).toString("latin1") === "%PDF" ? "pdf" : buf[0] === 0x89 && buf[1] === 0x50 ? "png" : buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : path.extname(name).slice(1).toLowerCase() || "file";

export type BuiltPack = {
  pdf: Uint8Array;
  elementPdfs: { elementNo: number; fileName: string; bytes: Buffer }[];
  attachments: { elementNo: number; name: string; bytes: Buffer; appended: boolean }[];
  outline: OutlineItem[];
};

/** The final-submission choice (pack page): saved level, level 2/4 picks, and the PDF's element order — PSW first. */
export async function getSubmissionPlan(ppapId: string) {
  const ppap = await prisma.ppap.findUniqueOrThrow({
    where: { id: ppapId },
    select: { level: true, submissionElementNos: true, submissionLevelSetAt: true, elements: { select: { elementNo: true, applicability: true } } },
  });
  // Same rule as getPackManifest: the checklist cover is always applicable.
  const applicable = new Set(ppap.elements.filter((e) => e.elementNo === 0 || e.applicability !== "NA").map((e) => e.elementNo));
  return {
    level: ppap.level,
    picks: ppap.submissionElementNos,
    confirmed: ppap.submissionLevelSetAt !== null,
    elementNos: submissionElementNos(ppap.level, ppap.submissionElementNos, applicable),
  };
}

/**
 * Renders every included element's print view and merges it with its
 * attachments into one bookmarked PDF — in element order, or in `order`
 * (element numbers; the final submission puts the PSW first).
 */
export async function buildPack(ppapId: string, origin: string, cookie: string | null, order?: number[]): Promise<BuiltPack> {
  const manifest = await getPackManifest(ppapId);
  const included = order ? order.flatMap((n) => manifest.included.filter((e) => e.elementNo === n)) : manifest.included;
  const rendered = await renderPrintRoutesToPdfs(
    included.map((e) => ({ url: `${origin}/ppap/${encodeURIComponent(ppapId)}/${e.elementNo}/print`, landscape: !PORTRAIT_ELEMENT_NOS.has(e.elementNo) })),
    cookie,
  );

  const pack = await PDFDocument.create();
  pack.setTitle("PPAP submission pack");
  pack.setCreator("PPAP Management — Ingenious Engineering");
  const outline: OutlineItem[] = [];
  const elementPdfs: BuiltPack["elementPdfs"] = [];
  const attachments: BuiltPack["attachments"] = [];

  for (const [i, e] of included.entries()) {
    const title = `${e.elementNo}. ${e.name}`;
    const fileName = `${String(e.elementNo).padStart(2, "0")} ${e.name}.pdf`;
    elementPdfs.push({ elementNo: e.elementNo, fileName, bytes: rendered[i] });

    const item: OutlineItem = { title, pageIndex: pack.getPageCount(), children: [] };
    const src = await PDFDocument.load(rendered[i]);
    for (const p of await pack.copyPages(src, src.getPageIndices())) pack.addPage(p);

    for (const a of e.attachments) {
      const bytes = await readStored(a.url);
      if (!bytes) continue;
      const kind = kindOf(a.name, bytes);
      const start = pack.getPageCount();
      let appended = false;
      try {
        if (kind === "pdf") {
          const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          for (const p of await pack.copyPages(doc, doc.getPageIndices())) pack.addPage(p);
          appended = true;
        } else if (kind === "png" || kind === "jpg") {
          const img = kind === "png" ? await pack.embedPng(bytes) : await pack.embedJpg(bytes);
          const [pw, ph] = img.width > img.height ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;
          const page = pack.addPage([pw, ph]);
          const margin = 28;
          const scale = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height, 1);
          page.drawImage(img, { x: (pw - img.width * scale) / 2, y: (ph - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
          appended = true;
        }
      } catch {
        appended = false; // unreadable / encrypted file — still shipped in the ZIP
      }
      if (appended) item.children!.push({ title: `${a.source}: ${a.name}`, pageIndex: start });
      attachments.push({ elementNo: e.elementNo, name: a.name, bytes, appended });
    }
    outline.push(item);
  }
  addOutline(pack, outline);
  return { pdf: await pack.save(), elementPdfs, attachments, outline };
}

/** The same files in the 4 reference folders, plus the bookmarked pack and the 20-sheet workbook at the root. */
export async function buildPackZip(ppapId: string, pack: BuiltPack, packFileName: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(packFileName, pack.pdf);
  const workbook = await exportFullWorkbook(ppapId);
  zip.file("PPAP Workbook.xlsx", new Uint8Array(await workbook.xlsx.writeBuffer()));

  for (const e of pack.elementPdfs) {
    const folder = packFolder(e.elementNo);
    zip.file(folder ? `${folder}/${e.fileName}` : e.fileName, e.bytes);
    const used = new Set<string>();
    for (const a of pack.attachments.filter((x) => x.elementNo === e.elementNo)) {
      let name = a.name.replace(/[\\/:*?"<>|]/g, "_");
      for (let n = 2; used.has(name); n++) name = `${path.parse(a.name).name} (${n})${path.extname(a.name)}`;
      used.add(name);
      const dir = `${e.fileName.replace(/\.pdf$/, "")} - attachments`;
      zip.file(folder ? `${folder}/${dir}/${name}` : `${dir}/${name}`, a.bytes);
    }
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
