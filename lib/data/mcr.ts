import { prisma } from "@/lib/prisma";
import { formatDateIndia } from "@/lib/format";
import { buildMcrGroups, cleanCell, mcrGroupsSchema, mcrTestSchema, type LabDocumentFields, type McrGroup, type RmtcFacts } from "@/lib/calc/mcr";

/** MCR header as printed (row 1–3 of "Material Clearance record"). */
export type McrHeader = {
  partNumber: string;
  issueNumber: string;
  partName: string;
  qty: string;
  projectName: string;
  poNumber: string;
  serialNumbers: string;
  location: string;
  mcrNumber: string;
  supplierName: string;
  mcrDate: string;
};

/** Header fields the user can type; the rest of McrHeader comes from the part master. */
export const MCR_HEADER_FIELDS = [
  "issueNumber",
  "qty",
  "projectName",
  "poNumber",
  "serialNumbers",
  "location",
  "mcrNumber",
  "supplierName",
  "mcrDate",
] as const;
export type McrHeaderField = (typeof MCR_HEADER_FIELDS)[number];

const tests = (json: unknown) => {
  const parsed = mcrTestSchema.array().safeParse(json);
  return parsed.success ? parsed.data : [];
};

/** dd/mm/yyyy, as on the reference sheet. */
const todaySlashed = () => formatDateIndia(new Date()).replaceAll("-", "/");

/**
 * Everything element 12's MCR needs for one PPAP: the uploaded lab documents
 * (upload order), the saved MCR record, header defaults from other pages
 * (part master, PSW PO no., RM Test Report project / supplier) and the RM
 * Test Report rows used to fill material ID and mill TC per heat no.
 */
export async function getMcrData(ppapId: string) {
  // All independent, so one parallel batch: each Neon round trip is ~0.3 s.
  const inElement = (elementNo: number) => ({ ppapElement: { ppapId, elementNo } });
  const [lab, labDocuments, mcrRecord, psw, rmtc, ppap, supplier] = await Promise.all([
    prisma.ppapElement.findUnique({ where: { ppapId_elementNo: { ppapId, elementNo: 12 } }, select: { id: true, status: true } }),
    prisma.labDocument.findMany({ where: inElement(12), orderBy: [{ sortOrder: "asc" }, { uploadedAt: "asc" }] }),
    prisma.mcrRecord.findFirst({ where: inElement(12) }),
    prisma.pswDetail.findFirst({ where: inElement(18), select: { poNumber: true } }),
    prisma.rmtcReportDetail.findFirst({
      where: inElement(10),
      select: { projectName: true, supplierName: true, rows: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.ppap.findUniqueOrThrow({
      where: { id: ppapId },
      select: { status: true, partRevision: { select: { part: { select: { partNumber: true, partName: true, projectModel: true } } } } },
    }),
    prisma.supplier.findFirst({ orderBy: { createdAt: "asc" }, select: { name: true } }),
  ]);
  if (!lab) throw new Error("This PPAP has no element 12.");

  const defaults: Record<McrHeaderField, string> = {
    issueNumber: "",
    qty: "",
    projectName: cleanCell(rmtc?.projectName || ppap.partRevision.part.projectModel),
    poNumber: cleanCell(psw?.poNumber),
    serialNumbers: "",
    location: "",
    mcrNumber: "",
    supplierName: cleanCell(rmtc?.supplierName || supplier?.name),
    mcrDate: todaySlashed(),
  };
  const record = mcrRecord;
  const header: McrHeader = {
    partNumber: cleanCell(ppap.partRevision.part.partNumber),
    partName: cleanCell(ppap.partRevision.part.partName),
    ...(Object.fromEntries(MCR_HEADER_FIELDS.map((f) => [f, cleanCell(record?.[f]) || defaults[f]])) as Record<McrHeaderField, string>),
  };

  const groupsParsed = mcrGroupsSchema.safeParse(record?.groups ?? []);
  const groups: McrGroup[] = groupsParsed.success ? groupsParsed.data : [];

  const documents = labDocuments.map((d) => ({ ...d, tests: tests(d.tests) }));
  const documentFields: LabDocumentFields[] = documents.map((d) => ({
    id: d.id,
    materialSpec: d.materialSpec,
    heatNo: d.heatNo,
    plateNo: d.plateNo,
    sizeText: d.sizeText,
    tests: d.tests,
  }));
  const rmtcFacts: RmtcFacts[] = (rmtc?.rows ?? []).map((r) => ({
    heatNo: r.heatNo,
    plateNo: r.plateNo,
    materialIdNo: r.materialIdNo,
    millTcNo: r.millTcNo,
    millTcDate: r.millTcDate ? formatDateIndia(r.millTcDate) : null,
  }));

  return {
    elementId: lab.id,
    elementStatus: lab.status,
    ppapStatus: ppap.status,
    header,
    defaults,
    savedHeader: record ? (Object.fromEntries(MCR_HEADER_FIELDS.map((f) => [f, record[f] ?? ""])) as Record<McrHeaderField, string>) : null,
    groups,
    /**
     * What the cover prints: the saved groups with every read lab report folded
     * in (same merge as "Build groups"), so the cover always describes the
     * reports that follow it, even before anyone presses Build.
     */
    printGroups: buildMcrGroups(documentFields, rmtcFacts, groups),
    documents,
    documentFields,
    rmtcFacts,
  };
}
