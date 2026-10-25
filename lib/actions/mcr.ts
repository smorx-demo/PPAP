"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertSupplierUser } from "@/lib/permissions";
import { assertPpapOpen } from "@/lib/psw-lifecycle";
import { saveUploadedFile } from "@/lib/storage";
import { extractLabDocument, labDocumentMediaType, LabExtractionError } from "@/lib/lab-document-extract";
import { buildMcrGroups, cleanCell, mcrGroupsSchema, mcrTestSchema } from "@/lib/calc/mcr";
import { getMcrData, MCR_HEADER_FIELDS } from "@/lib/data/mcr";

/// Element 12 — uploaded lab report files (LabDocument) and the Material
/// Clearance Record cover page (McrRecord). Every change needs a supplier
/// user, an unapproved element 12 and an open PPAP.

async function assertEditable(ppapElementId: string) {
  const user = await assertSupplierUser();
  const element = await prisma.ppapElement.findUniqueOrThrow({ where: { id: ppapElementId } });
  if (element.elementNo !== 12) throw new Error("Not the lab reports page.");
  if (element.status === "APPROVED") throw new Error("This page is approved and locked. Use Revise to edit it.");
  await assertPpapOpen(element.ppapId);
  return { user, element };
}

async function documentOf(documentId: string) {
  const doc = await prisma.labDocument.findUniqueOrThrow({ where: { id: documentId } });
  const { user, element } = await assertEditable(doc.ppapElementId);
  return { user, element, doc };
}

async function audit(params: { ppapId: string; userId: string; action: "CREATE" | "UPDATE" | "DELETE"; entityType: string; entityId: string; before: unknown; after: unknown }) {
  await prisma.auditLog.create({
    data: {
      ppapId: params.ppapId,
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before as never,
      after: params.after as never,
    },
  });
}

function revalidateLab(ppapId: string) {
  revalidatePath(`/ppap/${ppapId}/12`);
  revalidatePath(`/ppap/${ppapId}`);
}

// ---------------------------------------------------------------------------
// Lab documents
// ---------------------------------------------------------------------------

/** Saves the chosen files (PDF / PNG / JPG) after the existing ones, in the order picked; returns their ids for reading. */
export async function uploadLabDocuments(ppapElementId: string, formData: FormData): Promise<string[]> {
  const { user, element } = await assertEditable(ppapElementId);
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) throw new Error("Choose one or more lab report files.");
  const wrong = files.filter((f) => !labDocumentMediaType(f.name)).map((f) => f.name);
  if (wrong.length) throw new Error(`Only PDF, PNG and JPG files can be uploaded: ${wrong.join(", ")}`);

  const last = await prisma.labDocument.aggregate({ where: { ppapElementId }, _max: { sortOrder: true } });
  let sortOrder = (last._max.sortOrder ?? 0) + 1;
  const ids: string[] = [];
  for (const file of files) {
    const saved = await saveUploadedFile(file, `ppap-elements/${ppapElementId}/lab-documents`);
    const doc = await prisma.labDocument.create({
      data: { ppapElementId, fileUrl: saved.url, fileName: saved.fileName, fileType: saved.fileType, sortOrder: sortOrder++, uploadedById: user.id },
    });
    await audit({ ppapId: element.ppapId, userId: user.id, action: "CREATE", entityType: "LabDocument", entityId: doc.id, before: null, after: doc });
    ids.push(doc.id);
  }
  revalidateLab(element.ppapId);
  return ids;
}

/** Reads one file with Claude and stores what it found; a failure is stored too, with a message the user can act on. */
export async function readLabDocument(documentId: string): Promise<{ ok: boolean; message: string }> {
  const { user, element, doc } = await documentOf(documentId);
  let after;
  let result: { ok: boolean; message: string };
  try {
    const read = await extractLabDocument(doc);
    after = await prisma.labDocument.update({
      where: { id: documentId },
      data: {
        extractionStatus: "READ",
        extractionError: null,
        labName: cleanCell(read.labName) || null,
        materialSpec: cleanCell(read.materialSpec) || null,
        heatNo: cleanCell(read.heatNo) || null,
        plateNo: cleanCell(read.plateNo) || null,
        sizeText: cleanCell(read.sizeText) || null,
        tests: read.tests.map((t) => ({ type: cleanCell(t.type).toUpperCase(), reportNo: cleanCell(t.reportNo), date: cleanCell(t.date) })),
      },
    });
    result = { ok: true, message: `${doc.fileName}: ${read.tests.length} test report(s) read.` };
  } catch (err) {
    const message = err instanceof LabExtractionError ? err.message : `Reading failed: ${err instanceof Error ? err.message : String(err)}`;
    after = await prisma.labDocument.update({ where: { id: documentId }, data: { extractionStatus: "FAILED", extractionError: message } });
    result = { ok: false, message: `${doc.fileName}: ${message}` };
  }
  await audit({ ppapId: element.ppapId, userId: user.id, action: "UPDATE", entityType: "LabDocument", entityId: documentId, before: doc, after });
  revalidateLab(element.ppapId);
  return result;
}

const documentFieldsSchema = z.object({
  labName: z.string(),
  materialSpec: z.string(),
  heatNo: z.string(),
  plateNo: z.string(),
  sizeText: z.string(),
  tests: z.array(mcrTestSchema),
});

/** The user's corrections on the review screen. */
export async function updateLabDocument(documentId: string, input: z.input<typeof documentFieldsSchema>) {
  const { user, element, doc } = await documentOf(documentId);
  const data = documentFieldsSchema.parse(input);
  const after = await prisma.labDocument.update({
    where: { id: documentId },
    data: {
      labName: cleanCell(data.labName) || null,
      materialSpec: cleanCell(data.materialSpec) || null,
      heatNo: cleanCell(data.heatNo) || null,
      plateNo: cleanCell(data.plateNo) || null,
      sizeText: cleanCell(data.sizeText) || null,
      tests: data.tests
        .map((t) => ({ type: cleanCell(t.type).toUpperCase(), reportNo: cleanCell(t.reportNo), date: cleanCell(t.date) }))
        .filter((t) => t.reportNo),
      // Hand-checked values count as read.
      extractionStatus: "READ",
      extractionError: null,
    },
  });
  await audit({ ppapId: element.ppapId, userId: user.id, action: "UPDATE", entityType: "LabDocument", entityId: documentId, before: doc, after });
  revalidateLab(element.ppapId);
}

export async function deleteLabDocument(documentId: string) {
  const { user, element, doc } = await documentOf(documentId);
  await prisma.labDocument.delete({ where: { id: documentId } });
  await audit({ ppapId: element.ppapId, userId: user.id, action: "DELETE", entityType: "LabDocument", entityId: documentId, before: doc, after: null });
  revalidateLab(element.ppapId);
}

/** Moves a file one place earlier / later in the print order. */
export async function moveLabDocument(documentId: string, direction: "up" | "down") {
  const { element, doc } = await documentOf(documentId);
  const all = await prisma.labDocument.findMany({ where: { ppapElementId: doc.ppapElementId }, orderBy: [{ sortOrder: "asc" }, { uploadedAt: "asc" }] });
  const i = all.findIndex((d) => d.id === documentId);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= all.length) return;
  [all[i], all[j]] = [all[j], all[i]];
  await prisma.$transaction(all.map((d, n) => prisma.labDocument.update({ where: { id: d.id }, data: { sortOrder: n + 1 } })));
  revalidateLab(element.ppapId);
}

// ---------------------------------------------------------------------------
// MCR record
// ---------------------------------------------------------------------------

const headerSchema = z.object(Object.fromEntries(MCR_HEADER_FIELDS.map((f) => [f, z.string()])) as Record<(typeof MCR_HEADER_FIELDS)[number], z.ZodString>);

export async function saveMcrHeader(ppapElementId: string, input: z.input<typeof headerSchema>) {
  const { user, element } = await assertEditable(ppapElementId);
  const data = Object.fromEntries(Object.entries(headerSchema.parse(input)).map(([k, v]) => [k, cleanCell(v) || null]));
  const before = await prisma.mcrRecord.findUnique({ where: { ppapElementId } });
  const after = await prisma.mcrRecord.upsert({ where: { ppapElementId }, create: { ppapElementId, ...data }, update: data });
  await audit({ ppapId: element.ppapId, userId: user.id, action: before ? "UPDATE" : "CREATE", entityType: "McrRecord", entityId: after.id, before, after });
  revalidateLab(element.ppapId);
}

export async function saveMcrGroups(ppapElementId: string, input: unknown) {
  const { user, element } = await assertEditable(ppapElementId);
  const groups = mcrGroupsSchema.parse(input).map((g) => ({
    ...g,
    itemCodes: g.itemCodes.map(cleanCell).filter(Boolean),
    ...Object.fromEntries(
      (["itemDescription", "size", "materialSpec", "materialIdNo", "heatPlateNo", "testCertificate", "nablReports"] as const).map((k) => [k, cleanCell(g[k])]),
    ),
  }));
  const before = await prisma.mcrRecord.findUnique({ where: { ppapElementId } });
  const after = await prisma.mcrRecord.upsert({ where: { ppapElementId }, create: { ppapElementId, groups }, update: { groups } });
  await audit({ ppapId: element.ppapId, userId: user.id, action: before ? "UPDATE" : "CREATE", entityType: "McrRecord", entityId: after.id, before, after });
  revalidateLab(element.ppapId);
}

/** Builds / refreshes the material groups from the lab documents, keeping everything already typed (lib/calc/mcr.ts). */
export async function rebuildMcrGroups(ppapElementId: string): Promise<{ groups: number }> {
  const { element } = await assertEditable(ppapElementId);
  const data = await getMcrData(element.ppapId);
  const groups = buildMcrGroups(data.documentFields, data.rmtcFacts, data.groups);
  await saveMcrGroups(ppapElementId, groups);
  return { groups: groups.length };
}
