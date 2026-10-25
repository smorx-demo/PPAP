"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import ExcelJS from "exceljs";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { assertSupplierUser } from "@/lib/permissions";
import { assertPpapOpen } from "@/lib/psw-lifecycle";
import { importPfcWorkbook, ensureMainAssemblyRoute } from "@/lib/pfc-import";
import { deriveProcessStepList, type ProcessStep } from "@/lib/calc/process-flow";

async function assertEditable(ppapElementId: string) {
  await assertSupplierUser();
  const element = await prisma.ppapElement.findUniqueOrThrow({ where: { id: ppapElementId } });
  if (element.status === "APPROVED") {
    throw new Error("This page is approved and locked. Use Revise to edit it.");
  }
  return element;
}

function revalidatePfc(ppapId: string) {
  revalidatePath(`/ppap/${ppapId}/5`);
  revalidatePath(`/ppap/${ppapId}/5/print`);
  revalidatePath(`/ppap/${ppapId}`);
}

const childPartSchema = z.object({
  // Optional: child parts added from the assembly structure are auto-numbered
  // ("Child part 1.1.1") and get their part no. / description filled in later.
  partNo: z.string().trim(),
  description: z.string().trim(),
  qtyPerAssembly: z.coerce.number().int().min(0),
  side: z.enum(["LEFT", "RIGHT"]),
  type: z.enum(["MAKE", "BOP"]),
  parentChildPartId: z.string().optional(),
  subAssemblyId: z.string().optional(),
});
export type ChildPartInput = z.input<typeof childPartSchema>;

export async function createChildPart(ppapElementId: string, input: ChildPartInput) {
  const element = await assertEditable(ppapElementId);
  const data = childPartSchema.parse(input);
  const subAssemblyId = data.subAssemblyId ? (await subAssemblyOf(ppapElementId, data.subAssemblyId)).id : null;

  const maxItemNo = await prisma.childPart.aggregate({
    where: { ppapElementId },
    _max: { itemNo: true, sortOrder: true },
  });
  const itemNo = (maxItemNo._max.itemNo ?? 0) + 1;

  const childPart = await prisma.childPart.create({
    data: {
      ppapElementId,
      itemNo,
      partNo: data.partNo,
      description: data.description,
      qtyPerAssembly: data.qtyPerAssembly,
      side: data.side,
      type: data.type,
      parentChildPartId: data.parentChildPartId || null,
      subAssemblyId,
      sortOrder: (maxItemNo._max.sortOrder ?? 0) + 1,
    },
  });
  await prisma.route.create({ data: { ppapElementId, childPartId: childPart.id } });

  revalidatePfc(element.ppapId);
  return childPart;
}

export async function updateChildPart(childPartId: string, ppapElementId: string, input: ChildPartInput) {
  const element = await assertEditable(ppapElementId);
  const data = childPartSchema.parse(input);

  await prisma.childPart.update({
    where: { id: childPartId },
    data: {
      partNo: data.partNo,
      description: data.description,
      qtyPerAssembly: data.qtyPerAssembly,
      side: data.side,
      type: data.type,
      parentChildPartId: data.parentChildPartId || null,
    },
  });

  revalidatePfc(element.ppapId);
}

export async function deleteChildPart(childPartId: string, ppapElementId: string) {
  const element = await assertEditable(ppapElementId);

  const children = await prisma.childPart.count({ where: { parentChildPartId: childPartId } });
  if (children > 0) {
    throw new Error("Cannot delete a child part that has sub-parts. Delete or reassign them first.");
  }

  const route = await prisma.route.findUnique({ where: { childPartId } });
  if (route) {
    await prisma.routeStep.deleteMany({ where: { routeId: route.id } });
    await prisma.route.delete({ where: { id: route.id } });
  }
  await prisma.childPart.delete({ where: { id: childPartId } });

  revalidatePfc(element.ppapId);
}

export async function moveChildPart(childPartId: string, ppapElementId: string, direction: "up" | "down") {
  const element = await assertEditable(ppapElementId);

  const all = await prisma.childPart.findMany({ where: { ppapElementId }, orderBy: { sortOrder: "asc" } });
  const index = all.findIndex((c) => c.id === childPartId);
  if (index === -1) return;
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return;

  const a = all[index];
  const b = all[swapIndex];
  await prisma.$transaction([
    prisma.childPart.update({ where: { id: a.id }, data: { sortOrder: b.sortOrder } }),
    prisma.childPart.update({ where: { id: b.id }, data: { sortOrder: a.sortOrder } }),
  ]);

  revalidatePfc(element.ppapId);
}

// ---------------------------------------------------------------------------
// Route steps
// ---------------------------------------------------------------------------

/// Adding a non-inspection operation auto-inserts an Inspection step right
/// after it (per spec); the user can remove it like any other step.
export async function addRouteStep(ppapElementId: string, routeId: string, operationId: string) {
  const element = await assertEditable(ppapElementId);
  await appendRouteStep(routeId, operationId);
  revalidatePfc(element.ppapId);
}

async function appendRouteStep(routeId: string, operationId: string) {
  const operation = await prisma.operation.findUniqueOrThrow({ where: { id: operationId } });
  const count = await prisma.routeStep.count({ where: { routeId } });

  await prisma.routeStep.create({ data: { routeId, operationId, sequence: count } });

  if (operation.symbol !== "INSPECTION") {
    const inspection = await prisma.operation.findFirst({ where: { symbol: "INSPECTION" } });
    if (inspection) {
      await prisma.routeStep.create({ data: { routeId, operationId: inspection.id, sequence: count + 1 } });
    }
  }
}

export type StructureStepTarget =
  | { kind: "PRE_STAGE" }
  | { kind: "SUB_ASSEMBLY"; subAssemblyId: string }
  | { kind: "CHILD_PART"; childPartId: string };

/// "+ Add step" on the assembly structure: appends an operation to the
/// steps before the stages, a sub-assembly, or a child part (its normal BOM
/// route). The before-stages / sub-assembly route is created on first use.
export async function addStructureStep(ppapElementId: string, target: StructureStepTarget, operationId: string) {
  const element = await assertStructureEditable(ppapElementId);

  let route;
  if (target.kind === "PRE_STAGE") {
    route =
      (await prisma.route.findFirst({ where: { ppapElementId, preStage: true } })) ??
      (await prisma.route.create({ data: { ppapElementId, preStage: true, label: "Before stages" } }));
  } else if (target.kind === "SUB_ASSEMBLY") {
    const sub = await subAssemblyOf(ppapElementId, target.subAssemblyId);
    route =
      (await prisma.route.findUnique({ where: { subAssemblyId: sub.id } })) ??
      (await prisma.route.create({ data: { ppapElementId, subAssemblyId: sub.id } }));
  } else {
    const part = await prisma.childPart.findUnique({ where: { id: target.childPartId } });
    if (!part || part.ppapElementId !== ppapElementId) throw new Error("Child part not found.");
    route =
      (await prisma.route.findUnique({ where: { childPartId: part.id } })) ??
      (await prisma.route.create({ data: { ppapElementId, childPartId: part.id } }));
  }

  const before = await prisma.routeStep.findMany({ where: { routeId: route.id }, orderBy: { sequence: "asc" } });
  await appendRouteStep(route.id, operationId);
  const after = await prisma.routeStep.findMany({ where: { routeId: route.id }, orderBy: { sequence: "asc" } });
  await audit({ ppapId: element.ppapId, action: "UPDATE", entityType: "Route", entityId: route.id, before, after });
  revalidatePfc(element.ppapId);
}

export async function removeRouteStep(ppapElementId: string, stepId: string) {
  const element = await assertEditable(ppapElementId);

  const step = await prisma.routeStep.findUniqueOrThrow({ where: { id: stepId } });
  await prisma.routeStep.delete({ where: { id: stepId } });

  const remaining = await prisma.routeStep.findMany({
    where: { routeId: step.routeId },
    orderBy: { sequence: "asc" },
  });
  await prisma.$transaction(
    remaining.map((s, i) => prisma.routeStep.update({ where: { id: s.id }, data: { sequence: i } })),
  );

  revalidatePfc(element.ppapId);
}

export async function moveRouteStep(ppapElementId: string, stepId: string, direction: "up" | "down") {
  const element = await assertEditable(ppapElementId);

  const step = await prisma.routeStep.findUniqueOrThrow({ where: { id: stepId } });
  const all = await prisma.routeStep.findMany({ where: { routeId: step.routeId }, orderBy: { sequence: "asc" } });
  const index = all.findIndex((s) => s.id === stepId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return;

  const a = all[index];
  const b = all[swapIndex];
  await prisma.$transaction([
    prisma.routeStep.update({ where: { id: a.id }, data: { sequence: b.sequence } }),
    prisma.routeStep.update({ where: { id: b.id }, data: { sequence: a.sequence } }),
  ]);

  revalidatePfc(element.ppapId);
}

export async function importPfcExcel(ppapElementId: string, formData: FormData) {
  const element = await assertEditable(ppapElementId);

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    throw new Error("Select a file to import.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  const result = await importPfcWorkbook(workbook, ppapElementId);
  await ensureMainAssemblyRoute(ppapElementId);

  revalidatePfc(element.ppapId);
  return result;
}

/// Used by PFMEA (element 6) and Control Plan (element 7) to build their
/// row lists from this part's actual manufacturing process.
export async function getProcessStepList(ppapElementId: string): Promise<ProcessStep[]> {
  const routes = await prisma.route.findMany({
    where: { ppapElementId },
    include: {
      childPart: { select: { itemNo: true } },
      subAssembly: { select: { sortOrder: true, stage: { select: { sortOrder: true } } } },
      steps: { include: { operation: true } },
    },
  });

  return deriveProcessStepList(
    routes.map((route) => ({
      childPartItemNo: route.childPart?.itemNo ?? null,
      structure: route.preStage
        ? { kind: "PRE_STAGE" as const }
        : route.subAssembly
          ? { kind: "SUB_ASSEMBLY" as const, rank: route.subAssembly.stage.sortOrder * 10_000 + route.subAssembly.sortOrder }
          : undefined,
      steps: route.steps.map((s) => ({
        operationCode: s.operation.code,
        operationName: s.operation.name,
        symbol: s.operation.symbol,
        sequence: s.sequence,
      })),
    })),
  );
}

export async function updateRouteStepDetails(
  ppapElementId: string,
  stepId: string,
  input: { machine?: string; note?: string },
) {
  const element = await assertEditable(ppapElementId);
  await prisma.routeStep.update({
    where: { id: stepId },
    data: { machine: input.machine || null, note: input.note || null },
  });
  revalidatePfc(element.ppapId);
}

// ---------------------------------------------------------------------------
// Assembly structure: Stage → Sub-assembly → Child part, and the main
// assembly built from the ticked sub-assemblies.
// ---------------------------------------------------------------------------

async function audit(params: {
  ppapId: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }
  await prisma.auditLog.create({
    data: {
      ppapId: params.ppapId,
      userId: session.user.id,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before as never,
      after: params.after as never,
    },
  });
}

async function assertStructureEditable(ppapElementId: string) {
  const element = await assertEditable(ppapElementId);
  await assertPpapOpen(element.ppapId);
  return element;
}

/** Loads a stage, refusing ids that belong to another PPAP's flow chart. */
async function stageOf(ppapElementId: string, stageId: string) {
  const stage = await prisma.pfcStage.findUnique({ where: { id: stageId } });
  if (!stage || stage.ppapElementId !== ppapElementId) throw new Error("Stage not found.");
  return stage;
}

async function subAssemblyOf(ppapElementId: string, subAssemblyId: string) {
  const sub = await prisma.pfcSubAssembly.findUnique({ where: { id: subAssemblyId }, include: { stage: true } });
  if (!sub || sub.stage.ppapElementId !== ppapElementId) throw new Error("Sub-assembly not found.");
  const { stage: _stage, ...row } = sub;
  void _stage;
  return row;
}

/// Stages carry no typed name: they're shown as "Stage 1", "Stage 2"… from
/// their position (lib/calc/pfc-numbering.ts), so reordering renumbers them.
export async function createStage(ppapElementId: string) {
  const element = await assertStructureEditable(ppapElementId);
  const max = await prisma.pfcStage.aggregate({ where: { ppapElementId }, _max: { sortOrder: true } });
  const stage = await prisma.pfcStage.create({
    data: { ppapElementId, name: "", sortOrder: (max._max.sortOrder ?? 0) + 1 },
  });
  await audit({ ppapId: element.ppapId, action: "CREATE", entityType: "PfcStage", entityId: stage.id, before: null, after: stage });
  revalidatePfc(element.ppapId);
}

/// Deleting a stage removes its sub-assemblies; their child parts stay in
/// the BOM, just unassigned.
export async function deleteStage(ppapElementId: string, stageId: string) {
  const element = await assertStructureEditable(ppapElementId);
  const before = await stageOf(ppapElementId, stageId);
  await prisma.pfcStage.delete({ where: { id: stageId } });
  await audit({ ppapId: element.ppapId, action: "DELETE", entityType: "PfcStage", entityId: stageId, before, after: null });
  revalidatePfc(element.ppapId);
}

export async function moveStage(ppapElementId: string, stageId: string, direction: "up" | "down") {
  const element = await assertStructureEditable(ppapElementId);
  const all = await prisma.pfcStage.findMany({ where: { ppapElementId }, orderBy: { sortOrder: "asc" } });
  const index = all.findIndex((s) => s.id === stageId);
  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || swapIndex < 0 || swapIndex >= all.length) return;

  const reordered = [...all];
  [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];
  await prisma.$transaction(reordered.map((s, i) => prisma.pfcStage.update({ where: { id: s.id }, data: { sortOrder: i + 1 } })));
  revalidatePfc(element.ppapId);
}

/// Likewise auto-numbered ("1.1", "1.2"… under stage 1), so nothing is typed.
export async function createSubAssembly(ppapElementId: string, stageId: string) {
  const element = await assertStructureEditable(ppapElementId);
  await stageOf(ppapElementId, stageId);
  const max = await prisma.pfcSubAssembly.aggregate({ where: { stageId }, _max: { sortOrder: true } });
  const sub = await prisma.pfcSubAssembly.create({
    data: { stageId, partNo: "", description: "", sortOrder: (max._max.sortOrder ?? 0) + 1 },
  });
  await audit({ ppapId: element.ppapId, action: "CREATE", entityType: "PfcSubAssembly", entityId: sub.id, before: null, after: sub });
  revalidatePfc(element.ppapId);
}

/// Child parts of a deleted sub-assembly stay in the BOM, unassigned.
export async function deleteSubAssembly(ppapElementId: string, subAssemblyId: string) {
  const element = await assertStructureEditable(ppapElementId);
  const before = await subAssemblyOf(ppapElementId, subAssemblyId);
  await prisma.pfcSubAssembly.delete({ where: { id: subAssemblyId } });
  await audit({ ppapId: element.ppapId, action: "DELETE", entityType: "PfcSubAssembly", entityId: subAssemblyId, before, after: null });
  revalidatePfc(element.ppapId);
}

/// The main-assembly checkbox: whether this sub-assembly is used in the main assembly.
export async function setSubAssemblyInMainAssembly(ppapElementId: string, subAssemblyId: string, inMainAssembly: boolean) {
  const element = await assertStructureEditable(ppapElementId);
  const before = await subAssemblyOf(ppapElementId, subAssemblyId);
  const after = await prisma.pfcSubAssembly.update({ where: { id: subAssemblyId }, data: { inMainAssembly } });
  await audit({ ppapId: element.ppapId, action: "UPDATE", entityType: "PfcSubAssembly", entityId: subAssemblyId, before, after });
  revalidatePfc(element.ppapId);
}

/// Moves an existing BOM child part into a sub-assembly (or out of it, with null).
export async function assignChildPartToSubAssembly(ppapElementId: string, childPartId: string, subAssemblyId: string | null) {
  const element = await assertStructureEditable(ppapElementId);
  const before = await prisma.childPart.findUnique({ where: { id: childPartId } });
  if (!before || before.ppapElementId !== ppapElementId) throw new Error("Child part not found.");
  if (subAssemblyId) await subAssemblyOf(ppapElementId, subAssemblyId);
  const after = await prisma.childPart.update({ where: { id: childPartId }, data: { subAssemblyId } });
  await audit({ ppapId: element.ppapId, action: "UPDATE", entityType: "ChildPart", entityId: childPartId, before, after });
  revalidatePfc(element.ppapId);
}
