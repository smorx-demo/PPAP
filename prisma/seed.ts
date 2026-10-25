import "dotenv/config";
import bcrypt from "bcryptjs";
import path from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../lib/prisma";
import { ApplicabilityRule } from "../app/generated/prisma/enums";
import { importPfcWorkbook, ensureMainAssemblyRoute } from "../lib/pfc-import";
import { importPfmeaWorkbook } from "../lib/pfmea-import";
import { importDimensionalReportWorkbook } from "../lib/dimensional-report-import";
import { importRmtcWorkbook } from "../lib/rmtc-import";
import { importInstrumentWorkbook } from "../lib/instrument-import";
import { seedAarFromReferenceSheet } from "./seed-aar";
import { seedMasterSampleFromReferenceSheet } from "./seed-master-sample";
import { seedCsrFromReferenceSheet } from "./seed-csr";
import { seedPswFromReferenceSheet } from "./seed-psw";

// AIAG 4th-edition PPAP level-applicability matrix (elements 1-18).
// R = Retain at supplier, S = Submit to customer, * = customer decides.
// Element 0 (checklist cover, not an official AIAG element) is always
// REQUIRED since it's generated whenever a PPAP exists.
const AIAG_MATRIX: Record<number, [ApplicabilityRule, ApplicabilityRule, ApplicabilityRule, ApplicabilityRule, ApplicabilityRule]> = {
  // elementNo: [level1, level2, level3, level4, level5]
  1: ["RETAIN", "REQUIRED", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  2: ["RETAIN", "REQUIRED", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  3: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  4: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  5: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  6: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  7: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  8: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  9: ["RETAIN", "REQUIRED", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  10: ["RETAIN", "REQUIRED", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  11: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  12: ["RETAIN", "REQUIRED", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  13: ["RETAIN", "REQUIRED", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  14: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  15: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  16: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  17: ["RETAIN", "RETAIN", "REQUIRED", "CUSTOMER_DECIDES", "RETAIN"],
  18: ["REQUIRED", "REQUIRED", "REQUIRED", "REQUIRED", "REQUIRED"],
};

// Doc No. per element, exactly as found in the client's PPAP_Checklist.xlsx
// sheet headers (see /reference and CLAUDE.md "known data quirks").
const ELEMENT_DOC_NO: Partial<Record<number, string>> = {
  0: "F-PPAP/CHECK LIST-NBL-1170750-01",
  1: "F-ENG-8.3.2-01",
  2: "F-ENG-8.5.6-01",
  3: "F-ENG-8.6-01",
  4: "F-ENG-6.1-01",
  5: "IE/FC/1170750-R01",
  6: "F-ENG-6.1-02",
  7: "IE/CP/TLD-NBL/1170750",
  8: "F-QC-7.5.1-01",
  9: "F-8.6-02/R0",
  10: "F-QC-8.4.2-03",
  11: "F-QC-9.1.1-02",
  12: "F-QC-7.5.1-03",
  13: "F-PPAP-AAR-NBL-01",
  14: "F-PPAP-SPP-NBL-01",
  15: "F-QC-7.5.1-04",
  16: "F-QC-9.1.1-01",
  17: "F-PPAP-CSR-NBL-01",
  // 18 (PSW) intentionally omitted — the source PSW sheet carries no Doc No. box.
};

async function main() {
  // ---- Level-applicability matrix -----------------------------------
  for (const [elementNoStr, rulesByLevel] of Object.entries(AIAG_MATRIX)) {
    const elementNo = Number(elementNoStr);
    for (let level = 1; level <= 5; level++) {
      await prisma.levelApplicabilityRule.upsert({
        where: { level_elementNo: { level, elementNo } },
        update: { rule: rulesByLevel[level - 1] },
        create: { level, elementNo, rule: rulesByLevel[level - 1] },
      });
    }
  }
  // Element 0 (checklist cover) is always required, at every level.
  for (let level = 1; level <= 5; level++) {
    await prisma.levelApplicabilityRule.upsert({
      where: { level_elementNo: { level, elementNo: 0 } },
      update: { rule: "REQUIRED" },
      create: { level, elementNo: 0, rule: "REQUIRED" },
    });
  }

  // ---- Operation library (element 5, Process Flow Chart) -------------
  // The 20 operations named in the spec, plus three more (Material
  // Receipt, Storage, Nesting) needed for the main-assembly route
  // template, which the "5. PFC" sheet's per-child-part columns don't
  // cover on their own. Raw material, Kitting and Full welding were added
  // for the assembly-structure step dropdowns (migration
  // 20261025120000_pfc_structure_process_steps).
  const OPERATIONS: { code: string; name: string; symbol: "OPERATION" | "INSPECTION" | "STORAGE" | "TRANSPORT" | "DELAY"; defaultInspectionAfter?: boolean }[] = [
    { code: "MATERIAL_RECEIPT", name: "Material Receipt", symbol: "TRANSPORT" },
    { code: "RAW_MATERIAL", name: "Raw material", symbol: "STORAGE", defaultInspectionAfter: true },
    { code: "STORAGE", name: "Storage", symbol: "STORAGE" },
    { code: "NESTING", name: "Nesting", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "PLASMA_CUTTING", name: "Plasma cutting", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "LASER_CUTTING", name: "Laser cutting", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "BANDSAW_CUTTING", name: "Bandsaw cutting", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "CHAMFERING", name: "Chamfering", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "MACHINING", name: "Machining", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "DRILLING", name: "Drilling", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "TAPPING", name: "Tapping", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "COUNTER_DRILLING", name: "Counter drilling", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "DRILLING_TAPPING", name: "Drilling & tapping", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "BENDING", name: "Bending", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "ROLLING", name: "Rolling", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "KITTING", name: "Kitting", symbol: "OPERATION" },
    { code: "SUB_ASSEMBLY", name: "Sub assembly", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "TACK_WELDING", name: "Tack welding", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "WELDING", name: "Welding", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "FULL_WELDING", name: "Full welding", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "GRINDING_DRESSING", name: "Grinding/Dressing", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "SHOT_BLASTING", name: "Shot blasting", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "PAINTING", name: "Painting", symbol: "OPERATION", defaultInspectionAfter: true },
    { code: "INSPECTION", name: "Inspection", symbol: "INSPECTION" },
    { code: "PACKING", name: "Packing", symbol: "OPERATION" },
    { code: "DISPATCH", name: "Dispatch", symbol: "TRANSPORT" },
  ];
  for (let i = 0; i < OPERATIONS.length; i++) {
    const op = OPERATIONS[i];
    await prisma.operation.upsert({
      where: { code: op.code },
      update: { sortOrder: i * 10 },
      create: { ...op, sortOrder: i * 10 },
    });
  }

  // ---- Material spec (IS 2062 E250 BR, standard published limits) ---
  const materialSpec = await prisma.materialSpec.upsert({
    where: { standard_grade: { standard: "IS 2062", grade: "E250 BR" } },
    update: {},
    create: {
      standard: "IS 2062",
      grade: "E250 BR",
      cMax: 0.22,
      mnMax: 1.5,
      siMax: 0.4,
      sMax: 0.045,
      pMax: 0.045,
      ysMinMpa: 250,
      utsMinMpa: 410,
      utsMaxMpa: 540,
      elongationMinPct: 23,
      impactMinJ: 27,
      hardnessNote: null,
      otherNote: "Standard IS 2062:2011 published limits for grade E250 BR (thickness <= 20mm); not customer lab-report values — the source workbook's LAB Report sheet for this PPAP is an unfilled template.",
    },
  });

  // ---- Master data ----------------------------------------------------
  const customer = await prisma.customer.upsert({
    where: { code: "TLD-STL" },
    update: {},
    create: {
      name: "TLD STL",
      code: "TLD-STL",
      defaultPpapLevel: 3,
      approvalMode: "SUPPLIER_UPLOAD",
    },
  });

  await prisma.supplier.upsert({
    where: { supplierCode: "IEPL" },
    update: {},
    create: {
      name: "Ingenious Engineering Pvt Ltd",
      supplierCode: "IEPL",
      addressLine1: "Plot No. 49-P2, Jakkasandra Industrial Area",
      city: "Kolar District",
      state: "Karnataka",
      zip: "563130",
    },
  });

  const part = await prisma.part.upsert({
    where: { customerId_partNumber: { customerId: customer.id, partNumber: "1170750-RAW" } },
    update: {},
    create: {
      partName: "Chassis Brut, NBL Raw Frame, NBL",
      partNumber: "1170750-RAW",
      customerId: customer.id,
      projectModel: "NBL",
      weightKg: 831,
      materialSpecId: materialSpec.id,
      application: "Heavy Fabrication - Industrial",
    },
  });

  const partRevision = await prisma.partRevision.upsert({
    where: { partId_revision: { partId: part.id, revision: "H" } },
    update: {},
    create: {
      partId: part.id,
      revision: "H",
      drawingNo: "1170750-RAW",
      status: "ACTIVE",
    },
  });

  const passwordHash = await bcrypt.hash("ChangeMe123!", 10);

  const santhosh = await prisma.user.upsert({
    where: { email: "santhosh.bg@ingenious-engineering.local" },
    update: {},
    create: {
      name: "Santhosh BG",
      email: "santhosh.bg@ingenious-engineering.local",
      passwordHash,
      designation: "QA Manager",
      roles: ["QA_MANAGER"],
    },
  });

  const rajesh = await prisma.user.upsert({
    where: { email: "rajesh.goel@ingenious-engineering.local" },
    update: {},
    create: {
      name: "Rajesh Goel",
      email: "rajesh.goel@ingenious-engineering.local",
      passwordHash,
      designation: "Approver",
      roles: ["ADMIN"],
    },
  });

  // ---- PPAP -------------------------------------------------------------
  const ppap = await prisma.ppap.upsert({
    where: { id: "seed-ppap-1170750-raw-h" },
    update: {},
    create: {
      id: "seed-ppap-1170750-raw-h",
      partRevisionId: partRevision.id,
      customerId: customer.id,
      level: 3,
      reasonForSubmission: "Initial Submission",
      submissionDate: new Date("2026-01-04T00:00:00.000Z"),
      approvalMode: customer.approvalMode,
    },
  });

  const rules = await prisma.levelApplicabilityRule.findMany({ where: { level: 3 } });
  const ruleByElement = new Map(rules.map((r) => [r.elementNo, r.rule]));

  // Per-PPAP overrides from the client's actual PPAP Checklist sheet, which
  // marks these "N" (not required) for reasons specific to this submission
  // even though the generic Level-3 matrix would otherwise say REQUIRED.
  // Don't let the generic matrix silently override real source data.
  const APPLICABILITY_OVERRIDES: Record<number, { naReason: string }> = {
    2: { naReason: "No changes applicable — this is the initial submission" },
    4: { naReason: "Not in our scope (customer design) — supplier has no design responsibility for this part" },
  };

  const finalApplicability: string[] = [];

  for (let elementNo = 0; elementNo <= 18; elementNo++) {
    const rule = ruleByElement.get(elementNo) ?? "NA";
    const override = APPLICABILITY_OVERRIDES[elementNo];
    const applicability = override ? "NA" : rule === "CUSTOMER_DECIDES" ? "NA" : rule;
    const naReason = override?.naReason
      ?? (rule === "CUSTOMER_DECIDES" ? "Customer to confirm applicability for this level" : null);
    finalApplicability.push(applicability);

    await prisma.ppapElement.upsert({
      where: { ppapId_elementNo: { ppapId: ppap.id, elementNo } },
      update: {},
      create: {
        ppapId: ppap.id,
        elementNo,
        applicability,
        naReason,
        docNo: ELEMENT_DOC_NO[elementNo] ?? null,
        // Element 11 (SPC) is deliberately left NOT_STARTED: the source
        // workbook's SPC sheets describe an unrelated part — see CLAUDE.md.
        status: "NOT_STARTED",
        preparedById: override ? null : santhosh.id,
        preparedAt: override ? null : new Date("2026-01-04T00:00:00.000Z"),
      },
    });
  }

  // ---- Element 1 (Design Record) detail, matching sheet "1. Design Record" ----
  const designRecordElement = await prisma.ppapElement.update({
    where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: 1 } },
    data: { status: "IN_PROGRESS" },
  });

  await prisma.designRecordDetail.upsert({
    where: { ppapElementId: designRecordElement.id },
    update: {},
    create: {
      ppapElementId: designRecordElement.id,
      partNameRemarks: "As per drawing",
      partNumberRemarks: "As per drawing",
      customerNameRemarks: "As per drawing",
      drawingNumberRemarks: "As per drawing",
      drawingRevisionRemarks: "As per drawing",
      materialSpecId: materialSpec.id,
      materialSpecRemarks: "As per drawing",
      heatTreatment: "-",
      heatTreatmentRemarks: "-",
      surfaceFinish: "Painting",
      surfaceFinishRemarks: "As per drawing",
      specialCharacteristicsRemarks: "-",
    },
  });

  // A small illustrative sample — the real Dimensional Report (element 9)
  // will import its full 143-row set from Excel directly; these few rows
  // just prove the balloon list -> Dimensional Report plumbing works.
  const sampleBalloons: { balloonNo: number; viewSection: string; description: string; nominal: string; tolerance: string }[] = [
    { balloonNo: 1, viewSection: "Coupe A-A", description: "Ref.Dimension", nominal: "415", tolerance: "±3" },
    { balloonNo: 17, viewSection: "Coupe A-A", description: "Ref.Dimension", nominal: "590", tolerance: "±3" },
    { balloonNo: 25, viewSection: "Coupe B-B", description: "Ref.Dimension", nominal: "1239 Int", tolerance: "±4" },
    { balloonNo: 129, viewSection: "Detail F", description: "Angle", nominal: "45°", tolerance: "±1°" },
    { balloonNo: 131, viewSection: "Detail F", description: "Ref. Dimension", nominal: "1.5°", tolerance: "±1°" },
  ];
  for (const [i, b] of sampleBalloons.entries()) {
    await prisma.balloon.upsert({
      where: { ppapElementId_balloonNo: { ppapElementId: designRecordElement.id, balloonNo: b.balloonNo } },
      update: {},
      create: { ppapElementId: designRecordElement.id, sortOrder: i, ...b },
    });
  }

  // ---- Element 0 (PPAP Checklist) rows — only the ones we have confident
  // extracted values for from the source "PPAP Checklist" cover sheet;
  // left blank for the rest rather than fabricating text. Element 0's
  // fields are fully free-editable overrides, not derived — see CLAUDE.md.
  const checklistSeed: { elementNo: number; requiredOverride: string; statusOverride: string; remarks: string; docRefLabel: string }[] = [
    { elementNo: 1, requiredOverride: "Y", statusOverride: "OK", remarks: "Latest rev H drawing approved", docRefLabel: "1170750-RAW Rev.H" },
    { elementNo: 2, requiredOverride: "N", statusOverride: "OK", remarks: "No changes applicable", docRefLabel: "-" },
    { elementNo: 4, requiredOverride: "N", statusOverride: "OK", remarks: "Not in our scope (Customer design)", docRefLabel: "-" },
    { elementNo: 8, requiredOverride: "Y", statusOverride: "OK", remarks: "GRR < 10%", docRefLabel: "MSA-NBL-001" },
    { elementNo: 11, requiredOverride: "Y", statusOverride: "OK", remarks: "Cpk > 1.67 achieved", docRefLabel: "SPC-NBL-001" },
    { elementNo: 18, requiredOverride: "Y", statusOverride: "OK", remarks: "Signed and submitted", docRefLabel: "PSW-NBL-001" },
  ];
  for (const row of checklistSeed) {
    await prisma.checklistRow.upsert({
      where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: row.elementNo } },
      update: {},
      create: { ppapId: ppap.id, ...row },
    });
  }

  // ---- Element 5 (Process Flow Chart) — import the real 81-row sample
  // directly from the source workbook's "5. PFC" sheet, using the same
  // import path the UI's "Import Excel" action calls. See lib/pfc-import.ts.
  const pfcElement = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: 5 } },
  });
  const pfcWorkbook = new ExcelJS.Workbook();
  await pfcWorkbook.xlsx.readFile(path.join(__dirname, "..", "reference", "PPAP_Checklist.xlsx"));
  const pfcResult = await importPfcWorkbook(pfcWorkbook, pfcElement.id);
  await ensureMainAssemblyRoute(pfcElement.id);
  console.log(`Seeded element 5 (PFC): ${pfcResult.imported} child parts + main-assembly route.`);

  // ---- Element 6 (PFMEA) — import the real 26-step / 68-row sample from
  // the source workbook's "6. PFMEA" sheet. See lib/pfmea-import.ts.
  const pfmeaElement = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: 6 } },
  });
  const pfmeaWorkbook = new ExcelJS.Workbook();
  await pfmeaWorkbook.xlsx.readFile(path.join(__dirname, "..", "reference", "PPAP_Checklist.xlsx"));
  const pfmeaResult = await importPfmeaWorkbook(pfmeaWorkbook, pfmeaElement.id);
  console.log(
    `Seeded element 6 (PFMEA): ${pfmeaResult.imported} rows, ${pfmeaResult.apMismatches} typed-AP disagreements flagged.`,
  );

  // ---- Instrument master data ("16. Checking Aids") — imported from the
  // sheet (27 instruments, incl. the magnetic V blocks' text dates
  // "22/07/2025"). See lib/instrument-import.ts. Least count isn't on the
  // sheet; it's set only for the 2 instruments a Control Plan row names
  // with a real recorded least count.
  const instrumentWorkbook = new ExcelJS.Workbook();
  await instrumentWorkbook.xlsx.readFile(path.join(__dirname, "..", "reference", "PPAP_Checklist.xlsx"));
  const { imported: instrumentCount, idBySlNo: instrumentsBySlNo } = await importInstrumentWorkbook(instrumentWorkbook);
  await prisma.instrument.update({ where: { ieIdNo: "IE-VC-01" }, data: { leastCount: "0.02 mm" } });
  await prisma.instrument.update({ where: { ieIdNo: "IE-DCG-02" }, data: { leastCount: "1.0 micron" } });
  console.log(`Seeded ${instrumentCount} instruments (Checking Aids master list).`);

  // ---- Lab master (element 12 picker) — one currently-accredited lab and
  // one with an expired certificate, so "expired lab cannot be selected"
  // is directly testable without inventing extra UI.
  const LAB_MASTERS = [
    { name: "Bureau Veritas Metallurgical Lab", accreditationBody: "NABL", certificateNo: "NABL-TC-1234", scope: "Chemical & Mechanical testing of ferrous metals", validUntil: new Date("2027-12-31") },
    { name: "Expired Testing Services", accreditationBody: "ISO/IEC 17025", certificateNo: "ISO-9876", scope: "Coating thickness & adhesion testing", validUntil: new Date("2025-01-01") },
  ];
  for (const lab of LAB_MASTERS) {
    const existing = await prisma.labMaster.findFirst({ where: { name: lab.name } });
    if (existing) await prisma.labMaster.update({ where: { id: existing.id }, data: lab });
    else await prisma.labMaster.create({ data: lab });
  }
  console.log(`Seeded ${LAB_MASTERS.length} lab masters (1 accredited, 1 expired).`);

  // ---- Element 7 (Control Plan) — header + 27-row / 16-stage sample from
  // "7. Control Plan", transcribed directly (header fields are spread
  // across a heavily-merged block that isn't worth a generic parser for
  // a one-time seed). Quirks preserved as typed: "1OO%" (letter O, not
  // zero) and 3 Painting rows with no Control Method are both really in
  // the source sheet.
  const controlPlanElement = await prisma.ppapElement.update({
    where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: 7 } },
    data: {
      status: "CHECKED",
      checkedById: santhosh.id,
      checkedAt: new Date("2026-10-04"),
      approvedById: rajesh.id,
      approvedAt: new Date("2026-10-04"),
    },
  });

  const controlPlanDetail = await prisma.controlPlanDetail.upsert({
    where: { ppapElementId: controlPlanElement.id },
    update: {},
    create: {
      ppapElementId: controlPlanElement.id,
      phasePrototype: true,
      phasePreLaunch: false,
      phaseProduction: false,
      controlPlanNo: "IE/CP/TLD-NBL/1170750",
      revisionNo: "R00",
      dateOrig: new Date("2026-04-10"),
      dateRev: null,
      partDescription: "Chassis Brut, NBL Raw Frame",
      customerPartNo: "1170750-H",
      customerPartRevision: "H",
      partNo: "1170750-NBL CHASSIS",
      partRevision: "H",
      supplier: "Ingenious Engineering Pvt. Ltd.",
      plant: "Ingenious Engineering Pvt. Ltd.",
      material: "As per drw/equ grade",
      keyContactPhone: "Santhosh Kumar BG 9449116311",
      coreTeamText: "Rajesh Goel, Santhosh BG, Jeevan Kumar, Subramani, Narayanswamy, Alexander, Nawaz Pasha,",
      supplierPlantApprovalDate: new Date("2026-10-04"),
      customerEngineeringApprovalDate: null,
      customerQualityApprovalDate: new Date("2026-10-04"),
    },
  });

  type ControlPlanRowSeed = {
    processNameOperation?: string;
    machineDeviceJigTools?: string;
    stageNo: number;
    productCharacteristic?: string;
    processCharacteristic?: string;
    productProcessSpecification?: string;
    evaluationMeasurementTechnique?: string;
    instrumentSlNo?: number;
    leastCountText?: string;
    controlInCharge?: string;
    sampleSize?: string;
    sampleFrequency?: string;
    recordingRequired?: boolean;
    controlMethod?: string;
    reactionPlan?: string;
  };
  const CONTROL_PLAN_ROWS: ControlPlanRowSeed[] = [
    { processNameOperation: "Receipts Inspection of Plates", machineDeviceJigTools: "Receipt Inspection", stageNo: 1, productCharacteristic: "Appearance", processCharacteristic: "Storage", productProcessSpecification: "Free from Waveness,Pitting,Rust", evaluationMeasurementTechnique: "Visual", controlInCharge: "Q", sampleSize: "1", sampleFrequency: "Each Lot", recordingRequired: true, controlMethod: "INCOMING INSPECTION", reactionPlan: "D" },
    { processNameOperation: "Receipts Inspection of Plates", machineDeviceJigTools: "Receipt Inspection", stageNo: 1, productCharacteristic: "Dimensions (Thickness)", processCharacteristic: "In coming Checksheet", productProcessSpecification: "As per P.O", evaluationMeasurementTechnique: "Vernier", leastCountText: "0.02 mm", controlInCharge: "Q", sampleSize: "1", sampleFrequency: "Each Lot", recordingRequired: true, controlMethod: "INCOMING INSPECTION", reactionPlan: "D" },
    { processNameOperation: "Receipts Inspection of Plates", machineDeviceJigTools: "Receipt Inspection", stageNo: 1, productCharacteristic: "Dimensions (Length & Width)", processCharacteristic: "In coming Checksheet", productProcessSpecification: "As per P.O", evaluationMeasurementTechnique: "MT", leastCountText: "1.00 mm", controlInCharge: "Q", sampleSize: "1", sampleFrequency: "Each Lot", recordingRequired: true, controlMethod: "INCOMING INSPECTION", reactionPlan: "D" },
    { processNameOperation: "Receipts Inspection of Plates", machineDeviceJigTools: "Receipt Inspection", stageNo: 1, productCharacteristic: "Chemical & Mechanical properties", processCharacteristic: "In coming Checksheet", productProcessSpecification: "As per Drg.", evaluationMeasurementTechnique: "Compare With Mill T.C", controlInCharge: "Q", sampleSize: "1", sampleFrequency: "Each Lot", recordingRequired: true, controlMethod: "INCOMING INSPECTION", reactionPlan: "D" },
    { processNameOperation: "Material Identification", machineDeviceJigTools: "Recipt Inspection", stageNo: 2, productCharacteristic: "Identification marking", productProcessSpecification: "COLOUR CODING", evaluationMeasurementTechnique: "COLOUR CODING", controlInCharge: "Q", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "INSPECTION", reactionPlan: "A" },
    { processNameOperation: "Plasma Cutting/Gas cutting", machineDeviceJigTools: "Plasma Cutting M/c", stageNo: 3, productCharacteristic: "Plate Grade", productProcessSpecification: "As per Cutting Plan", evaluationMeasurementTechnique: "AS per Cutting Plan", controlInCharge: "W / I", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: false, controlMethod: "As per Cutting Plan", reactionPlan: "D" },
    { processNameOperation: "Plasma Cutting/Gas cutting", machineDeviceJigTools: "Plasma Cutting M/c", stageNo: 3, productCharacteristic: "Plate Profile Cutting", productProcessSpecification: "As per Drg.", evaluationMeasurementTechnique: "Checking as per Drg.", controlInCharge: "W / P", sampleSize: "As per Sampling Plan", sampleFrequency: "Each Part", recordingRequired: false, controlMethod: "AS PER STANDARD", reactionPlan: "D" },
    { processNameOperation: "Plasma Cutting/Gas cutting", machineDeviceJigTools: "Plasma Cutting M/c", stageNo: 3, processCharacteristic: "M/c Parameter", productProcessSpecification: "As per MESSER SPECIFICATION", evaluationMeasurementTechnique: "As per MESSER SPECIFICATION", controlInCharge: "W", sampleSize: "n=1", sampleFrequency: "Setting/Re- Setting", recordingRequired: false, controlMethod: "OPERATOR CHECK", reactionPlan: "A" },
    { processNameOperation: "Deslagging & Grinding", stageNo: 4, productCharacteristic: "Appearance", productProcessSpecification: "Free from Nick marks, serretion & scales", evaluationMeasurementTechnique: "Visual", controlInCharge: "W", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: false, controlMethod: "OPERATOR CHECK", reactionPlan: "A" },
    { processNameOperation: "Material preparation", machineDeviceJigTools: "Drilling", stageNo: 5, productCharacteristic: "Dimension", processCharacteristic: "M/c Parameter", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Meas. Tape & Template", controlInCharge: "W / I", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "OPERATOR CHECK", reactionPlan: "A" },
    { processNameOperation: "Material preparation", machineDeviceJigTools: "Rolling", stageNo: 5, productCharacteristic: "Dimension", processCharacteristic: "M/c Parameter", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Meas. Tape & Template", controlInCharge: "W / I", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "OPERATOR CHECK", reactionPlan: "A" },
    { processNameOperation: "Material preparation", machineDeviceJigTools: "Bending", stageNo: 5, productCharacteristic: "Dimension", processCharacteristic: "M/c Parameter", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Meas. Tape & Template", controlInCharge: "W / I", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "OPERATOR CHECK", reactionPlan: "A" },
    { processNameOperation: "Stage Inspection", stageNo: 6, productCharacteristic: "Inprocess Inspection", processCharacteristic: "Inspection Method/ Check sheet", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Checking Aids/ Check sheet", controlInCharge: "Q", sampleSize: "1OO%", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "As per CIS", reactionPlan: "A" },
    { processNameOperation: "Tack Welding & Sub assy Welding", machineDeviceJigTools: "Welding M/c", stageNo: 7, productCharacteristic: "Semi Finish parts Inspection", processCharacteristic: "M/c Parameter", productProcessSpecification: "As per Drg.", evaluationMeasurementTechnique: "Checking as per drg./Weld Gauge", controlInCharge: "P", sampleSize: "Each Lot", sampleFrequency: "As per Sampling Plan", recordingRequired: true, controlMethod: "As per Drg.", reactionPlan: "A" },
    { processNameOperation: "Inprocess inspection", stageNo: 8, productCharacteristic: "Inprocess Inspection", processCharacteristic: "Inspection Method/ Check sheet", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Checking Aids/ Check sheet", controlInCharge: "Q", sampleSize: "1OO%", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "As per CIS", reactionPlan: "A" },
    { processNameOperation: "Full Welding", machineDeviceJigTools: "Welding M/c", stageNo: 9, productCharacteristic: "Semi Finish parts Inspection", processCharacteristic: "M/c Parameter", productProcessSpecification: "As per Drg.", evaluationMeasurementTechnique: "Checking as per drg./Weld Gauge", controlInCharge: "P", sampleSize: "Each Lot", sampleFrequency: "As per Sampling Plan", recordingRequired: true, controlMethod: "As per Drg.", reactionPlan: "A" },
    { processNameOperation: "Stage Inspection", stageNo: 10, productCharacteristic: "Inprocess Inspection", processCharacteristic: "Inspection Method/ Check sheet", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Checking Aids/ Check sheet", controlInCharge: "Q", sampleSize: "1OO%", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "As per CIS", reactionPlan: "A" },
    { processNameOperation: "Dressing", machineDeviceJigTools: "Grinding Machine/Grit wheels", stageNo: 11, productCharacteristic: "Semi Finish parts Inspection", processCharacteristic: "Welding defects /irregularities", productProcessSpecification: "As per Drg. And Std. reqts.", evaluationMeasurementTechnique: "Checking as per drg./Weld Gauge", controlInCharge: "P", sampleSize: "Each Lot", sampleFrequency: "As per Sampling Plan", recordingRequired: true, controlMethod: "As per Drg.", reactionPlan: "A" },
    { processNameOperation: "Stage Inspection", stageNo: 12, productCharacteristic: "Inprocess Inspection", processCharacteristic: "Inspection Method/ Check sheet", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Checking Aids/ Check sheet", controlInCharge: "Q", sampleSize: "1OO%", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "As per CIS", reactionPlan: "A" },
    { processNameOperation: "Shot Blasting", machineDeviceJigTools: "Shot Blasting booth", stageNo: 13, productCharacteristic: "Surface Texture", processCharacteristic: "Paint Report", productProcessSpecification: "As per SA-2.5 (Rz 40 - 70mm)", evaluationMeasurementTechnique: "Visual/Surface Tester/Comparator", controlInCharge: "W", sampleSize: "Each Lot 4 to 5 locations", sampleFrequency: "As per Sampling Plan", recordingRequired: false, controlMethod: "OPERATOR CHECK", reactionPlan: "A" },
    { processNameOperation: "Painting", machineDeviceJigTools: "Paint booth", stageNo: 14, productCharacteristic: "Appearance", processCharacteristic: "Paint Report", productProcessSpecification: "Free from paint flow,paint miss etc.", evaluationMeasurementTechnique: "Visual", controlInCharge: "Q", sampleSize: "1", sampleFrequency: "Each Part", recordingRequired: false, reactionPlan: "A" },
    { processNameOperation: "Painting", machineDeviceJigTools: "Paint booth", stageNo: 14, productCharacteristic: "Adherence/Cross hatch test", processCharacteristic: "Paint Report", productProcessSpecification: "No peel off etc", evaluationMeasurementTechnique: "Cross Hatch Test", controlInCharge: "Q", sampleSize: "Each Lot 4 to 5 locations", sampleFrequency: "As per Sampling Plan", recordingRequired: false, reactionPlan: "A" },
    { processNameOperation: "Painting", machineDeviceJigTools: "Paint booth", stageNo: 14, productCharacteristic: "D.F.T", processCharacteristic: "Paint Report", productProcessSpecification: "Ref. DMS296", evaluationMeasurementTechnique: "D.F.T GAUGE", instrumentSlNo: 25, leastCountText: "1.0 micron", controlInCharge: "Q", sampleSize: "Each Lot", sampleFrequency: "As per Sampling Plan", recordingRequired: true, controlMethod: "AS PER STANDARD", reactionPlan: "A" },
    { processNameOperation: "Painting", machineDeviceJigTools: "Paint booth", stageNo: 14, productCharacteristic: "Gloss Value", processCharacteristic: "Paint Report", productProcessSpecification: "Ref. DMS296", evaluationMeasurementTechnique: "80 GU to 90 GU", controlInCharge: "Q", sampleSize: "Each Lot 4 to 5 locations", sampleFrequency: "As per Sampling Plan", recordingRequired: false, reactionPlan: "A" },
    { processNameOperation: "Final Inspection", machineDeviceJigTools: "Inspection", stageNo: 15, productCharacteristic: "Final Inspection", processCharacteristic: "Inspection Method/ Check sheet", productProcessSpecification: "As per drawing", evaluationMeasurementTechnique: "Checking Aids/ Check sheet", controlInCharge: "Q", sampleSize: "Each Lot", sampleFrequency: "As per Sampling Plan", recordingRequired: true, controlMethod: "FIR", reactionPlan: "A" },
    { processNameOperation: "Packing & Dispatch", machineDeviceJigTools: "Packing", stageNo: 16, productCharacteristic: "Packing", processCharacteristic: "Packing Standard", productProcessSpecification: "As per customer approved packing standard", evaluationMeasurementTechnique: "Visual", controlInCharge: "P & Q", sampleSize: "1OO%", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "As per CIS", reactionPlan: "A" },
    { processNameOperation: "Packing & Dispatch", machineDeviceJigTools: "Packing", stageNo: 16, productCharacteristic: "Storage/Loading", processCharacteristic: "Loading Pallets", productProcessSpecification: "As per customer approved packing standard", evaluationMeasurementTechnique: "Visual", controlInCharge: "P & Q", sampleSize: "1OO%", sampleFrequency: "Each Part", recordingRequired: true, controlMethod: "As per CIS", reactionPlan: "A" },
  ];

  await prisma.controlPlanRow.deleteMany({ where: { controlPlanDetailId: controlPlanDetail.id } });
  for (let i = 0; i < CONTROL_PLAN_ROWS.length; i++) {
    const row = CONTROL_PLAN_ROWS[i];
    await prisma.controlPlanRow.create({
      data: {
        controlPlanDetailId: controlPlanDetail.id,
        processNameOperation: row.processNameOperation,
        machineDeviceJigTools: row.machineDeviceJigTools,
        stageNo: row.stageNo,
        productCharacteristic: row.productCharacteristic,
        processCharacteristic: row.processCharacteristic,
        productProcessSpecification: row.productProcessSpecification,
        evaluationMeasurementTechnique: row.evaluationMeasurementTechnique,
        instrumentId: row.instrumentSlNo ? instrumentsBySlNo.get(row.instrumentSlNo) : undefined,
        leastCountText: row.leastCountText,
        controlInCharge: row.controlInCharge,
        sampleSize: row.sampleSize,
        sampleFrequency: row.sampleFrequency,
        recordingRequired: row.recordingRequired,
        controlMethod: row.controlMethod,
        reactionPlan: row.reactionPlan,
        sortOrder: i,
      },
    });
  }
  console.log(`Seeded element 7 (Control Plan): ${CONTROL_PLAN_ROWS.length} rows across 16 stages.`);

  // ---- Element 9 (Dimensional Report) — import the real sample from the
  // source workbook's "9. Dimensional Report" sheet. See
  // lib/dimensional-report-import.ts. The sheet's own numbering runs 1-143,
  // but 3 rows ("60 A", "60 B", "127 A") are lettered sub-items alongside
  // the plain numbers, so the true row count is 146 — imported faithfully
  // rather than dropped to force an exact "143".
  const dimensionalReportElement = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: 9 } },
  });
  const dimensionalReportWorkbook = new ExcelJS.Workbook();
  await dimensionalReportWorkbook.xlsx.readFile(path.join(__dirname, "..", "reference", "PPAP_Checklist.xlsx"));
  const dimensionalReportResult = await importDimensionalReportWorkbook(dimensionalReportWorkbook, dimensionalReportElement.id);
  console.log(`Seeded element 9 (Dimensional Report): ${dimensionalReportResult.imported} rows.`);

  // ---- Element 10 (RM Test Reports) — import the real 9-lot sample from
  // the source workbook's "10. RMTC Reports" sheet. See lib/rmtc-import.ts.
  const rmtcElement = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId: ppap.id, elementNo: 10 } },
  });
  const rmtcWorkbook = new ExcelJS.Workbook();
  await rmtcWorkbook.xlsx.readFile(path.join(__dirname, "..", "reference", "PPAP_Checklist.xlsx"));
  const rmtcResult = await importRmtcWorkbook(rmtcWorkbook, rmtcElement.id);
  await prisma.rmtcReportDetail.update({
    where: { ppapElementId: rmtcElement.id },
    data: { projectName: "NBL", supplierName: "INGENIOUS ENGINEERING" },
  });
  console.log(`Seeded element 10 (RM Test Reports): ${rmtcResult.imported} rows.`);

  // ---- Element 13 (AAR) — header, sample info and the 8 criteria rows
  // from sheet "13. AAR". See prisma/seed-aar.ts.
  const aarSeeded = await seedAarFromReferenceSheet(ppap.id, rajesh.id);
  console.log(aarSeeded ? "Seeded element 13 (AAR)." : "Element 13 (AAR) already has data — left as is.");

  // ---- Element 15 (Master Sample) — import the register (NBL-001) from
  // sheet "15. Master Sample". See prisma/seed-master-sample.ts.
  const masterSampleResult = await seedMasterSampleFromReferenceSheet(ppap.id, rajesh.id);
  console.log(`Seeded element 15 (Master Sample): ${masterSampleResult.imported} row(s).`);

  // ---- Element 17 (CSR) — TLD STL zone library + the sheet's 5 zone-map
  // pages. See prisma/seed-csr.ts.
  const csrResult = await seedCsrFromReferenceSheet(customer.id, ppap.id);
  console.log(`Seeded element 17 (CSR): ${csrResult.rules} rule(s), ${csrResult.pages} zone-map page(s).`);

  // ---- Element 18 (PSW) — the sheet's warrant values, unsigned. See prisma/seed-psw.ts.
  const pswSeeded = await seedPswFromReferenceSheet(ppap.id);
  console.log(pswSeeded ? "Seeded element 18 (PSW), unsigned." : "Element 18 (PSW) already has data — left as is.");

  console.log(`Seeded PPAP ${ppap.id} for ${part.partName} (${part.partNumber} Rev.${partRevision.revision}), level ${ppap.level}, customer ${customer.name}.`);
  console.log(`Elements by applicability:`, {
    REQUIRED: finalApplicability.filter((r) => r === "REQUIRED").length,
    RETAIN: finalApplicability.filter((r) => r === "RETAIN").length,
    NA: finalApplicability.filter((r) => r === "NA").length,
  });
  console.log(`Dev login: ${santhosh.email} / ${rajesh.email} — password "ChangeMe123!"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
