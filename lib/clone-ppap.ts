import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown> & { id: string };

/** Copyable fields of a row with a fresh id; `set` overrides (re-pointed foreign keys). */
function copyOf(row: Row, newId: string, set: Record<string, unknown> = {}): Record<string, unknown> {
  const { createdAt: _c, updatedAt: _u, ...rest } = row as Record<string, unknown>;
  void _c;
  void _u;
  const out: Record<string, unknown> = { ...rest, id: newId, ...set };
  // Nullable Json columns can't be written as plain null — leave them unset.
  if (out.crop === null) delete out.crop;
  return out;
}

/** Fresh ids for a set of rows: old id → new id. Ids are generated here so whole tables copy in one createMany. */
function idsFor(rows: { id: string }[]): Map<string, string> {
  return new Map(rows.map((r) => [r.id, randomUUID()]));
}

export type CloneTarget =
  | { mode: "revision"; revision: string; drawingNo: string | null }
  | {
      mode: "part";
      customerId: string | null;
      newCustomerName: string | null;
      partName: string;
      partNumber: string;
      revision: string;
      drawingNo: string | null;
    };

/**
 * Deep-clones a PPAP to a new revision of the same part, or to a new part
 * (optionally for another / new customer). Copies every element's page
 * data with all cross-element links re-pointed (balloons, special
 * characteristics, Control Plan rows, RMTC lots, child parts/routes).
 * Element applicability and Doc Nos. carry over; status, sign-offs and
 * revision start fresh.
 *
 * Deliberately NOT copied: the ECN log (element 2 — the source revision's
 * change history), customer dispositions (a new submission needs new
 * ones), master samples (element 15 — physical samples of the source
 * revision), the PSW signature, and CSR compliance when the customer
 * changes (the CSR library is per customer). Uploaded files are shared by
 * reference, not duplicated.
 *
 * New ids are generated up front so each table is one createMany — the
 * row-by-row version took minutes against the hosted DB.
 */
export async function clonePpap(sourcePpapId: string, target: CloneTarget, opts: { approvalMode?: "CUSTOMER_PORTAL" | "SUPPLIER_UPLOAD"; userId: string | null }) {
  const source = await prisma.ppap.findUniqueOrThrow({
    where: { id: sourcePpapId },
    include: { partRevision: { include: { part: true } }, elements: true },
  });
  const from = (n: number) => source.elements.find((e) => e.elementNo === n)!.id;

  // ---- Read everything first (outside the transaction, sequentially — pg warns on overlapping queries) ----
  const checklist = await prisma.checklistRow.findMany({ where: { ppapId: source.id } });
  const designRecord = await prisma.designRecordDetail.findUnique({ where: { ppapElementId: from(1) } });
  const specialChars = await prisma.specialCharacteristic.findMany({ where: { ppapElementId: from(1) } });
  const drawings = await prisma.drawingFile.findMany({ where: { ppapElementId: from(1) } });
  const balloons = await prisma.balloon.findMany({ where: { ppapElementId: from(1) } });
  const cea = await prisma.ceaDetail.findUnique({ where: { ppapElementId: from(3) } });
  const ceaAttachments = await prisma.ceaAttachment.findMany({ where: { ppapElementId: from(3) } });
  const dfmea = await prisma.dfmeaDetail.findUnique({ where: { ppapElementId: from(4) }, include: { rows: true } });
  const pfcStages = await prisma.pfcStage.findMany({ where: { ppapElementId: from(5) }, include: { subAssemblies: true } });
  const childParts = await prisma.childPart.findMany({ where: { ppapElementId: from(5) } });
  const routes = await prisma.route.findMany({ where: { ppapElementId: from(5) }, include: { steps: true } });
  const pfmeaSteps = await prisma.pfmeaProcessStep.findMany({ where: { ppapElementId: from(6) }, include: { rows: true } });
  const controlPlan = await prisma.controlPlanDetail.findUnique({ where: { ppapElementId: from(7) }, include: { rows: true } });
  const msa = await prisma.msaStudy.findMany({ where: { ppapElementId: from(8) }, include: { dataPoints: true } });
  const dimensional = await prisma.dimensionalReportDetail.findUnique({
    where: { ppapElementId: from(9) },
    include: { sampleColumns: true, rows: { include: { readings: true } } },
  });
  const rmtc = await prisma.rmtcReportDetail.findUnique({ where: { ppapElementId: from(10) }, include: { rows: true } });
  const spc = await prisma.spcStudy.findMany({ where: { ppapElementId: from(11) }, include: { readings: true } });
  const labs = await prisma.labReport.findMany({
    where: { ppapElementId: from(12) },
    include: { testDetails: true, mechanicalResults: true, chemicalResults: true, paintResults: true },
  });
  const aarDetail = await prisma.aarDetail.findUnique({ where: { ppapElementId: from(13) } });
  const aarRows = await prisma.aarCriteriaRow.findMany({ where: { ppapElementId: from(13) }, include: { photos: true } });
  const sppDetail = await prisma.sppDetail.findUnique({ where: { ppapElementId: from(14) } });
  const sppSamples = await prisma.sppSample.findMany({ where: { ppapElementId: from(14) } });
  const sppTests = await prisma.sppFunctionalTest.findMany({ where: { ppapElementId: from(14) } });
  const sppPhotos = await prisma.sppPackagingPhoto.findMany({ where: { ppapElementId: from(14) } });
  const checkingAids = await prisma.ppapCheckingAid.findMany({ where: { ppapElementId: from(16) } });
  const zonePages = await prisma.csrZoneMapPage.findMany({ where: { ppapElementId: from(17) }, include: { views: true } });
  const compliances = await prisma.csrCompliance.findMany({ where: { ppapElementId: from(17) } });
  const psw = await prisma.pswDetail.findUnique({ where: { ppapElementId: from(18) } });

  return prisma.$transaction(
    async (tx: Tx) => {
      // ---- Part / revision / customer ----
      let customerId = source.customerId;
      let partId = source.partRevision.partId;
      if (target.mode === "part") {
        if (target.newCustomerName) {
          customerId = (await tx.customer.create({ data: { name: target.newCustomerName, approvalMode: opts.approvalMode ?? source.approvalMode } })).id;
        } else if (target.customerId) {
          customerId = target.customerId;
        }
        const sp = source.partRevision.part;
        partId = (
          await tx.part.create({
            data: { partName: target.partName, partNumber: target.partNumber, customerId, projectModel: sp.projectModel, weightKg: sp.weightKg, materialSpecId: sp.materialSpecId, application: sp.application },
          })
        ).id;
      }
      const clash = await tx.partRevision.findUnique({ where: { partId_revision: { partId, revision: target.revision } } });
      if (clash) throw new Error(`Revision ${target.revision} already exists for this part.`);
      const partRevision = await tx.partRevision.create({
        data: { partId, revision: target.revision, drawingNo: target.drawingNo ?? source.partRevision.drawingNo, status: "ACTIVE" },
      });
      const ppap = await tx.ppap.create({
        data: {
          partRevisionId: partRevision.id,
          customerId,
          level: source.level,
          // The picked documents carry over; the level must be confirmed again on the clone.
          submissionElementNos: source.submissionElementNos,
          reasonForSubmission: target.mode === "revision" ? "Engineering change" : source.reasonForSubmission,
          approvalMode: opts.approvalMode ?? source.approvalMode,
        },
      });

      // ---- Elements (fresh workflow) ----
      const elementIds = new Map(source.elements.map((e) => [e.elementNo, randomUUID()]));
      const to = (n: number) => elementIds.get(n)!;
      await tx.ppapElement.createMany({
        data: source.elements.map((e) => ({
          id: to(e.elementNo),
          ppapId: ppap.id,
          elementNo: e.elementNo,
          applicability: e.applicability,
          naReason: e.naReason,
          docNo: e.docNo,
          status: "NOT_STARTED" as const,
        })),
      });

      const many = async (model: keyof Tx, data: Record<string, unknown>[]) => {
        if (data.length) await (tx[model] as unknown as { createMany: (a: unknown) => Promise<unknown> }).createMany({ data });
      };

      // 0 — checklist overrides
      await many("checklistRow", checklist.map((r) => copyOf(r, randomUUID(), { ppapId: ppap.id })));

      // 1 — design record, special characteristics, drawings, balloons
      const scMap = idsFor(specialChars);
      const balloonMap = idsFor(balloons);
      if (designRecord) await many("designRecordDetail", [copyOf(designRecord, randomUUID(), { ppapElementId: to(1) })]);
      await many("specialCharacteristic", specialChars.map((r) => copyOf(r, scMap.get(r.id)!, { ppapElementId: to(1) })));
      await many("drawingFile", drawings.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(1) })));
      await many("balloon", balloons.map((r) => copyOf(r, balloonMap.get(r.id)!, { ppapElementId: to(1) })));

      // 3 — CEA
      if (cea) await many("ceaDetail", [copyOf(cea, randomUUID(), { ppapElementId: to(3) })]);
      await many("ceaAttachment", ceaAttachments.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(3) })));

      // 4 — DFMEA
      if (dfmea) {
        const { rows, ...d } = dfmea;
        const detailId = randomUUID();
        await many("dfmeaDetail", [copyOf(d as Row, detailId, { ppapElementId: to(4) })]);
        await many("dfmeaRow", rows.map((r) => copyOf(r, randomUUID(), { dfmeaDetailId: detailId })));
      }

      // 5 — PFC: stages, sub-assemblies, child parts (parents before children), routes, steps
      const stageMap = idsFor(pfcStages);
      await many("pfcStage", pfcStages.map(({ subAssemblies: _s, ...s }) => copyOf(s as Row, stageMap.get(s.id)!, { ppapElementId: to(5) })));
      const subAssemblies = pfcStages.flatMap((s) => s.subAssemblies);
      const subMap = idsFor(subAssemblies);
      await many("pfcSubAssembly", subAssemblies.map((r) => copyOf(r, subMap.get(r.id)!, { stageId: stageMap.get(r.stageId)! })));
      const cpMap = idsFor(childParts);
      const remapChild = (r: (typeof childParts)[number]) =>
        copyOf(r, cpMap.get(r.id)!, {
          ppapElementId: to(5),
          parentChildPartId: r.parentChildPartId ? cpMap.get(r.parentChildPartId) ?? null : null,
          subAssemblyId: r.subAssemblyId ? subMap.get(r.subAssemblyId) ?? null : null,
        });
      await many("childPart", childParts.filter((c) => !c.parentChildPartId).map(remapChild));
      await many("childPart", childParts.filter((c) => c.parentChildPartId).map(remapChild));
      const routeMap = idsFor(routes);
      await many(
        "route",
        routes.map(({ steps: _s, ...r }) => copyOf(r as Row, routeMap.get(r.id)!, {
            ppapElementId: to(5),
            childPartId: r.childPartId ? cpMap.get(r.childPartId) ?? null : null,
            subAssemblyId: r.subAssemblyId ? subMap.get(r.subAssemblyId) ?? null : null,
          })),
      );
      await many("routeStep", routes.flatMap((r) => r.steps.map((s) => copyOf(s, randomUUID(), { routeId: routeMap.get(r.id)! }))));

      // 6 — PFMEA
      const stepMap = idsFor(pfmeaSteps);
      await many("pfmeaProcessStep", pfmeaSteps.map(({ rows: _r, ...s }) => copyOf(s as Row, stepMap.get(s.id)!, { ppapElementId: to(6) })));
      await many("pfmeaRow", pfmeaSteps.flatMap((s) => s.rows.map((r) => copyOf(r, randomUUID(), { pfmeaProcessStepId: stepMap.get(s.id)! }))));

      // 7 — Control Plan (rows → special characteristics re-pointed)
      const cpRowMap = idsFor(controlPlan?.rows ?? []);
      if (controlPlan) {
        const { rows, ...d } = controlPlan;
        const detailId = randomUUID();
        await many("controlPlanDetail", [copyOf(d as Row, detailId, { ppapElementId: to(7) })]);
        await many(
          "controlPlanRow",
          rows.map((r) =>
            copyOf(r, cpRowMap.get(r.id)!, {
              controlPlanDetailId: detailId,
              specialCharacteristicId: r.specialCharacteristicId ? scMap.get(r.specialCharacteristicId) ?? null : null,
            }),
          ),
        );
      }

      // 8 — MSA (studies → Control Plan rows re-pointed)
      const msaMap = idsFor(msa);
      await many(
        "msaStudy",
        msa.map(({ dataPoints: _d, ...s }) =>
          copyOf(s as Row, msaMap.get(s.id)!, { ppapElementId: to(8), controlPlanRowId: s.controlPlanRowId ? cpRowMap.get(s.controlPlanRowId) ?? null : null }),
        ),
      );
      await many("msaDataPoint", msa.flatMap((s) => s.dataPoints.map((p) => copyOf(p, randomUUID(), { msaStudyId: msaMap.get(s.id)! }))));

      // 9 — Dimensional (rows → balloons, readings → sample columns)
      if (dimensional) {
        const { sampleColumns, rows, ...d } = dimensional;
        const detailId = randomUUID();
        const colMap = idsFor(sampleColumns);
        const rowMap = idsFor(rows);
        await many("dimensionalReportDetail", [copyOf(d as Row, detailId, { ppapElementId: to(9) })]);
        await many("dimensionalReportSampleColumn", sampleColumns.map((c) => copyOf(c, colMap.get(c.id)!, { dimensionalReportDetailId: detailId })));
        await many(
          "dimensionalReportRow",
          rows.map(({ readings: _x, ...r }) =>
            copyOf(r as Row, rowMap.get(r.id)!, { dimensionalReportDetailId: detailId, balloonId: r.balloonId ? balloonMap.get(r.balloonId) ?? null : null }),
          ),
        );
        await many(
          "dimensionalReportReading",
          rows.flatMap((r) => r.readings.map((x) => copyOf(x, randomUUID(), { dimensionalReportRowId: rowMap.get(r.id)!, sampleColumnId: colMap.get(x.sampleColumnId)! }))),
        );
      }

      // 10 — RMTC
      const lotMap = idsFor(rmtc?.rows ?? []);
      if (rmtc) {
        const { rows, ...d } = rmtc;
        const detailId = randomUUID();
        await many("rmtcReportDetail", [copyOf(d as Row, detailId, { ppapElementId: to(10) })]);
        await many("rmtcReportRow", rows.map((r) => copyOf(r, lotMap.get(r.id)!, { rmtcReportDetailId: detailId })));
      }

      // 11 — SPC (studies → special characteristics re-pointed)
      const spcMap = idsFor(spc);
      await many(
        "spcStudy",
        spc.map(({ readings: _r, ...s }) =>
          copyOf(s as Row, spcMap.get(s.id)!, {
            ppapElementId: to(11),
            specialCharacteristicId: s.specialCharacteristicId ? scMap.get(s.specialCharacteristicId) ?? null : null,
          }),
        ),
      );
      await many("spcReading", spc.flatMap((s) => s.readings.map((r) => copyOf(r, randomUUID(), { spcStudyId: spcMap.get(s.id)! }))));

      // 12 — Lab reports (→ RMTC lots re-pointed)
      const labMap = idsFor(labs);
      await many(
        "labReport",
        labs.map(({ testDetails: _a, mechanicalResults: _b, chemicalResults: _c, paintResults: _d, ...r }) =>
          copyOf(r as Row, labMap.get(r.id)!, { ppapElementId: to(12), rmtcReportRowId: r.rmtcReportRowId ? lotMap.get(r.rmtcReportRowId) ?? null : null }),
        ),
      );
      for (const [key, model] of [
        ["testDetails", "labTestDetail"],
        ["mechanicalResults", "labMechanicalResult"],
        ["chemicalResults", "labChemicalResult"],
        ["paintResults", "labPaintResult"],
      ] as const) {
        await many(model, labs.flatMap((l) => (l[key] as Row[]).map((x) => copyOf(x, randomUUID(), { labReportId: labMap.get(l.id)! }))));
      }

      // 13 — AAR
      if (aarDetail) await many("aarDetail", [copyOf(aarDetail, randomUUID(), { ppapElementId: to(13) })]);
      const aarMap = idsFor(aarRows);
      await many("aarCriteriaRow", aarRows.map(({ photos: _p, ...r }) => copyOf(r as Row, aarMap.get(r.id)!, { ppapElementId: to(13) })));
      await many("aarPhoto", aarRows.flatMap((r) => r.photos.map((p) => copyOf(p, randomUUID(), { aarCriteriaRowId: aarMap.get(r.id)! }))));

      // 14 — Sample Production Part
      if (sppDetail) await many("sppDetail", [copyOf(sppDetail, randomUUID(), { ppapElementId: to(14) })]);
      await many("sppSample", sppSamples.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(14) })));
      await many("sppFunctionalTest", sppTests.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(14) })));
      await many("sppPackagingPhoto", sppPhotos.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(14) })));

      // 16 — manual checking-aid additions
      await many("ppapCheckingAid", checkingAids.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(16) })));

      // 17 — zone maps; compliance only for the same customer (library is per customer)
      const pageMap = idsFor(zonePages);
      await many("csrZoneMapPage", zonePages.map(({ views: _v, ...p }) => copyOf(p as Row, pageMap.get(p.id)!, { ppapElementId: to(17) })));
      await many("csrZoneMapView", zonePages.flatMap((p) => p.views.map((v) => copyOf(v, randomUUID(), { pageId: pageMap.get(p.id)! }))));
      if (customerId === source.customerId) {
        await many("csrCompliance", compliances.map((r) => copyOf(r, randomUUID(), { ppapElementId: to(17) })));
      }

      // 18 — PSW warrant values, never the signature
      if (psw) await many("pswDetail", [copyOf(psw, randomUUID(), { ppapElementId: to(18), signedById: null, signedAt: null })]);

      await tx.auditLog.create({
        data: { ppapId: ppap.id, userId: opts.userId, action: "CREATE", entityType: "Ppap", entityId: ppap.id, after: { clonedFrom: source.id, target } as never },
      });
      return ppap;
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
}
