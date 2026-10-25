# CLAUDE.md

Conventions for this repo. Follow these in every later session. The reference
Excel files live in `/reference` (`PPAP_Checklist.xlsx` — 20 sheets: a cover
checklist + 18 PPAP elements, with element 11 (SPC) split over 2 sheets — and
`PPAP_Document_List.xlsx`). Read them before changing seed data, Doc No.s, or
print layouts; don't rely on paraphrase.

## Stack

Next.js 15 (App Router) + TypeScript, PostgreSQL + Prisma, Tailwind +
shadcn/ui, NextAuth v5 (credentials + email magic link), Zod, TanStack Table,
Recharts, ExcelJS (Excel import/export), Playwright (headless Chromium) for
PDF rendering and e2e, S3-compatible storage. Vitest for unit tests.

**Current infra status (2026-10-07):** using Neon (hosted Postgres) for
`DATABASE_URL` rather than a local Docker Postgres — MinIO's community
Docker images were pulled from Docker Hub and gated on Quay in 2026, and
their AIStor successor requires online license activation even for local
use, so object storage setup is deferred until closer to deploying the
upload/attachment features (F3). `docker-compose.yml` currently only runs
Maildev (local SMTP catcher for magic-link email in dev, at
http://localhost:1080). Revisit the storage choice (MinIO AIStor with a
license, `bitnamilegacy/minio`, Garage, or a managed S3-compatible service)
before building attachment upload.

## Domain model

- Every PPAP belongs to a `PartRevision`. Every PPAP has exactly 19
  `PpapElement` rows, one per AIAG element (`elementNo` 0–18: 0 = checklist
  cover, 1–18 = the AIAG elements, with element 11 = Initial Process Studies
  covering both SPC sheets as one logical element).
- `PpapElement` fields: `elementNo`, `applicability` (`REQUIRED | RETAIN | NA`),
  `naReason`, `status` (`NOT_STARTED | IN_PROGRESS | PREPARED | CHECKED |
  APPROVED | SUBMITTED | CUSTOMER_APPROVED | CUSTOMER_REJECTED`), `docNo`,
  `revision`, `preparedBy`/`preparedAt`, `checkedBy`/`checkedAt`,
  `approvedBy`/`approvedAt`.
- Page-specific data lives in its own Prisma model keyed by `ppapElementId`
  (e.g. `DesignRecordDetail`, `ControlPlanRow`, `SpcStudy`). Never duplicate
  master data (part, customer, supplier, users, instruments, materials) —
  always reference it by foreign key.
- Applicability is derived from a configurable AIAG level matrix
  (`LevelApplicabilityRule`: level 1–5 × element → `REQUIRED | RETAIN | NA`,
  with `*` meaning customer-decides, stored as `NA` + a flag the UI surfaces
  as "customer to confirm"). Changing a PPAP's level re-evaluates
  applicability but never deletes already-entered page data.
- The actual reference workbook's Doc No. scheme is not fully uniform —
  most elements use `F-...` codes (seeded from the sheet headers), but
  Process Flow Chart and Control Plan use project-specific codes
  (`IE/FC/...`, `IE/CP/...`). Seed `docNo` per element exactly as found in
  the sheet header, don't force a pattern.
- Two sheets in the reference workbook (SPC, Checking Aids) carry a stale
  2023 issue date left over from a reused template; don't copy that forward
  into new `DocumentTemplate` seeds — use the 2026 date that the rest of the
  workbook uses.

## Routing & pages

- Each element has `/ppap/[id]/[element]` (form/grid + server actions with
  Zod validation), `/ppap/[id]/[element]/print` (reproduces the client's
  Excel layout: logo, title, Doc No / Issue date / Rev block, signature
  footer), and both Excel (ExcelJS) and PDF (Playwright-rendered print route)
  export.
- `<PrintHeader>` / `<PrintFooter>` are shared components for the print
  layout; page orientation (portrait/landscape) follows the source sheet
  (most are landscape; ECN, CEA, PSW, Dimensional Report, LAB Report, AAR,
  Sample Production Part, Master Sample, Checking Aids, CSR are portrait).

## UI look & feel

- Theme tokens live in `app/globals.css` (navy/slate palette, `--brand` for
  the dark brand surfaces). Use the tokens (`bg-card`, `text-muted-foreground`,
  `bg-primary`…), not raw greys; status colours stay in `status-badge.tsx`.
- Font: Inter via next/font as `--font-inter`; the theme's `--font-sans`
  reads it (don't name the next/font variable `--font-sans` — it becomes
  self-referential).
- Shell: sticky header (`app/(app)/layout.tsx` + `components/app-nav.tsx`),
  per-PPAP header + sticky element sidebar (`ppap/[id]/layout.tsx`,
  `components/ppap-nav.tsx`, active element from the URL). Pages ease in via
  `template.tsx` (`.page-enter`); `loading.tsx` skeletons give instant
  feedback while the server renders — but only for the dashboard
  (`(app)/(home)/loading.tsx`) and element pages (`ppap/[id]/[element]/loading.tsx`).
  Never put a loading.tsx above a page whose guard calls `notFound()`:
  once the fallback streams, the status is committed as 200 instead of 404. Keep new pages inside a
  `<main className="mx-auto max-w-… space-y-4 p-6">` with Cards.

## Element 0 — PPAP Checklist (deviates from the AIAG-standard design)

The checklist cover page is normally meant to be an auto-computed summary:
Status "never typed" (derived from whether the source page is APPROVED/
rejected), Remarks auto-summarized from each page, Required driven by the
level-applicability matrix. **Per explicit user request (2026-10-08), it was
built fully free-editable instead** — `ChecklistRow` (keyed by
`[ppapId, elementNo]`) stores independent override text for Required,
Status, Remarks, and the document-reference label for each of the 18
elements, with no link back to the real `PpapElement` data for that
elementNo. The "Document Reference" column still links to the real
`/ppap/[id]/[elementNo]` page for navigation; only its *label* is the
free-text override. The progress bar is the one exception — it's computed
from real `PpapElement` status/applicability, not from the overrides.

**Exception added 2026-10-17 (user decision, from the AAR spec's "NA state
syncs with checklist"): the Required column two-way syncs with each page's
N/A state, for all 18 elements** (`lib/checklist-sync.ts`,
`lib/calc/checklist.ts`). Toggling N/A on a page (`setElementNaToggle`)
writes "N"/"Y" into that element's Required cell. Saving the checklist with
a *changed* Required cell that clearly reads Y/Yes/Required or
N/No/NA/N/A/Not required flips the page to REQUIRED or N/A (reason "Not
required per PPAP checklist"); unclear text (blank, "Retain", "TBD") and
unchanged cells never touch the page, and APPROVED (locked) pages are
skipped with a notice. RETAIN counts as "Y". Status, Remarks and the
document-reference label stay fully free-edit.

## Workflow & locking

- Internal workflow per `PpapElement`: Draft → Prepared → Checked → Approved,
  each step e-signed (signature image + name + timestamp) via the shared
  `<SignatureBlock>` component.
- A page **locks when `APPROVED`**. Editing an approved page creates a new
  revision (increment `revision`, keep the prior version queryable, show a
  diff) rather than mutating in place.
- Customer disposition (PSW part disposition, CEA customer approval, AAR
  customer approval, Sample Production Part customer approval) goes through
  the shared `<CustomerDisposition>` component, whose behavior switches on
  `Ppap.approvalMode` (`CUSTOMER_PORTAL | SUPPLIER_UPLOAD`, default from
  `Customer.approvalMode`, overridable per-PPAP until PSW is submitted).
  A rejection on the PSW reopens the PPAP for revision.
- PPAP lifecycle (`Ppap.status`, element 18 — `lib/actions/psw.ts`,
  `lib/psw-lifecycle.ts`): OPEN → SUBMITTED when the supplier e-signs the
  PSW (only once every REQUIRED element 0-17 is APPROVED / SUBMITTED /
  CUSTOMER_APPROVED — enforced server-side) → CLOSED when the customer
  approves the PSW. A PSW rejection (comments required) clears the
  supplier signature and sets the PPAP back to OPEN with
  `lastRejectionComments`. A CLOSED PPAP refuses sign-offs, revisions, N/A
  changes, checklist edits and dispositions (`assertPpapOpen`); the approval
  mode is fixed once the PPAP leaves OPEN.
- Client forms: use `onSubmit={submitFormData(handler)}` (`lib/form.ts`),
  not `<form action>` — React 19 resets an action form after every run,
  wiping the user's entries when the action reported an error.

## Roles & permissions

- `lib/calc/permissions.ts` `permissionsFor(roles)` is the single source:
  ADMIN everything; QA_MANAGER approves pages, signs the PSW, views the
  audit log; other supplier roles edit / prepare / check; CUSTOMER_APPROVER
  (a login with `customerId`) is read-only, sees only its own customer's
  PPAPs and may record customer dispositions.
- Every server action that changes supplier data calls
  `assertSupplierUser()` (or `assertCan(...)`) from `lib/permissions.ts`;
  every per-PPAP page / route checks the customer scope
  (`assertCanViewPpap`, or the same check inline in API routes, returning
  404). Supplier-only pages use `requirePagePermission`. New actions and
  routes must do the same — hiding a nav link is not a guard.

## Pre-submission checks, clone, pack, dashboard

- Data-consistency checks (`lib/calc/consistency.ts` pure rules,
  `lib/consistency.ts` gathers data): date order (prepared ≤ checked ≤
  approved ≤ PSW date), SPC/MSA/Dimensional rows owned by this part
  revision, checklist Required vs pages with data, typed vs computed values.
  ERRORs block `signPsw`; WARNINGs are review-only. Shown on the PSW and pack
  pages.
- Clone (`lib/clone-ppap.ts`, /ppap/[id]/clone) deep-copies all page data to
  a new revision or a new part in one transaction with remapped ids;
  sign-offs/statuses reset. Not copied: ECN log, dispositions, master
  samples, PSW signature, and CSR compliance when the customer changes.
- PPAP pack (`lib/pack.ts`, /ppap/[id]/pack, `GET /api/ppap/[id]/pack?format=pdf|zip|xlsx`):
  element 0 + every non-N/A element in order, each print view (rendered in
  one Chromium session) followed by its attachments (PDFs merged, images as
  pages), bookmarked via `lib/pdf-outline.ts`. The ZIP uses the 4 reference
  folders of PPAP_Document_List.xlsx (1-3 Drawing & Engineering, 4-7
  Manufacturing Process & Risk, 8-10 Inspection & Testing, 11-18 Validation
  & Approval; checklist at the root) plus the pack PDF and the 20-sheet
  workbook (`lib/workbook-export.ts`, which reuses the per-element exporters
  where they exist). When adding a new attachment field, add it to
  `getPackManifest`.
- Final PPAP by submission level (user request 2026-10-18; pack page card
  `components/submission-level-card.tsx`, rules in
  `lib/calc/submission-level.ts`, `?format=pdf&set=final`): L1 PSW + AAR,
  L2 / L4 PSW + user-picked elements (`Ppap.submissionElementNos`), L3 / L5
  PSW + every applicable 0-17. The PSW is sheet 1, the rest in element
  order, N/A always left out. Confirming sets `Ppap.level` and
  `submissionLevelSetAt` (the download appears only after that) but does
  **not** re-evaluate applicability; it's fixed once the PSW is approved or
  signed.
- Dashboard (`lib/dashboard.ts`, `/`) and audit-log viewer (`/audit`,
  `lib/calc/audit-diff.ts`) are scoped by the same permissions.
- Acceptance e2e: `e2e/full-flow.spec.ts` clones the seed PPAP to throwaway
  E2E customers (never modifies the seed) and runs both approval modes
  through to the pack download.

## Calculations

All numeric logic (Cp, Cpk, Pp, Ppk, UCL/LCL, %GRR, control-chart constants,
calibration-due flags, etc.) lives in `/lib/calc/*.ts` as pure functions with
unit tests. Use the client's real sample numbers as test fixtures — e.g. the
reference workbook's SPC study (sample size 25, 5 subgroups of 5,
USL=76/LSL=75.645, giving `Cp≈1.072`, `Cpk≈0.9537`) and the Checking Aids
calibration-due rule (`dueDate < today + 15 days` → "Due is near").

## Design Records (element 1) — AutoBalloon integration (2026-10-25)

- Drawing upload → auto ballooning → inspection report → PDF/Excel/CSV
  downloads use the AutoBalloon software from
  smorx-demo/Autoballooning-with-versions (commit ce94647), not hand-built
  PPAP code. Backend vendored as `autoballoon-service/` (FastAPI + PyMuPDF,
  Python 3.11, local JSON store + files in `autoballoon-service/data/`; run
  `autoballoon-service\start-ppap.bat`, port 9686). PPAP patch: no default S3
  bucket (it defaulted to SmorX's production bucket). Its UI
  (`InspectionPage` + canvas) is ported to `components/autoballoon/` without
  login/admin/licence screens; CSS scoped under `.ab-root`
  (`autoballoon.css`); both folders are lint-ignored (vendored) but
  type-checked.
- The browser only talks to `app/api/ppap/[id]/autoballoon/[...path]`, which
  applies PPAP access rules (customer scope; changes need a supplier user,
  unapproved page, open PPAP), allows only job / drawing-version /
  instrument-rule paths, and forwards with one service account
  (`AUTOBALLOON_URL` / `_USERNAME` / `_PASSWORD` in `.env`, matching
  `SUPERADMIN_*` in `autoballoon-service/.env`). A job is usable only from the
  PPAP it was uploaded on (`DesignRecordDetail.autoballoonJobId`, set on
  upload).
- Saving / rebuilding the report re-syncs element 1's `Balloon` rows
  (`lib/autoballoon-sync.ts`, mapping in `lib/calc/autoballoon.ts`) so the
  Dimensional Report keeps generating; removed balloons unlink their
  Dimensional Report rows first. The old Drawing Files / ballooned-image /
  manual balloon sections are no longer on the page.
- Page order (user request 2026-10-25): card 1 = Design Record details +
  special characteristics; card 2 = the AutoBalloon workspace with the
  inspection report inline below the drawing panels (`InspectionPage
  inlineReport`: shown from the saved rows whenever the job has balloons, no
  rebuild on load; top button "Refresh inspection report"); card 3 = the
  Prepared / Approved sign-off.
- Pack: when `autoballoonJobId` is set, element 1 gets two attachments —
  the ballooned drawing PDF and the inspection report PDF — listed with
  proxy URLs and fetched from the service at build time (`readStored` in
  `lib/pack.ts`); a stopped service just leaves them out.
- Not yet: the report PDF still carries SmorX branding; the element 1 print
  view is unchanged.

## Lab Reports (element 12) — Material Clearance Record (2026-10-25)

- "Lab Report Documents & Material Clearance Record" card (`lab-mcr-section.tsx`,
  actions `lib/actions/mcr.ts`): multi-file upload (PDF/PNG/JPG) into
  `LabDocument` (upload order = `sortOrder`), each read by Claude
  (`lib/lab-document-extract.ts`, `claude-opus-5-5`, structured output,
  `fallbacks: "default"`; needs `ANTHROPIC_API_KEY`, else the user fills fields
  by hand). Separate from `LabReport` (the structured sheet, unchanged).
- `McrRecord` (one per PPAP) holds header fields no lab report carries and the
  material groups (JSON, `mcrGroupsSchema`). Grouping = same heat/plate no. +
  spec (`lib/calc/mcr.ts buildMcrGroups`); material ID + mill TC come from the RM
  Test Report row with that heat no.; typed values always win. The print folds
  every read report in automatically (`printGroups`), so the cover always
  describes the files after it, and lists them ("Enclosed lab reports").
- Print = header **Print** button → `GET /api/ppap/[id]/12/mcr`
  (`lib/mcr-print.ts`): cover from `/ppap/[id]/12/mcr` (A4 landscape,
  `paginateMcr` — header + table header repeat, rows never split, groups ≥ 8
  codes may continue "contd.", "MCR <no> – Page X of Y", sign-off last), then
  each file in order (PDF pages, images one per page); an unreadable file gets a
  page naming it. Layout source: "MCR 109300003635- NEW REV-9 (Updated)1.xlsx".
- `e2e/lab.spec.ts` line 55 (Mn NG after reload) fails on the Neon setup
  independently of this work: it reloads 500 ms after blur, before the save lands.

## Process Flow (element 5) assembly structure

- Stage → Sub-assembly → Child part (user request 2026-10-22): `PfcStage`
  (per element 5) → `PfcSubAssembly` (`inMainAssembly` = the main-assembly
  checkbox) → existing `ChildPart` rows via nullable `subAssemblyId`.
  Child parts stay the BOM/route source for PFMEA & Control Plan; deleting a
  stage/sub-assembly only unassigns its parts (FK `SET NULL`). The main
  assembly is the PPAP's part itself. UI: `pfc-assembly-structure.tsx`
  (editor + checkboxes) and `pfc-assembly-tree.tsx` (top-to-bottom process
  flow, user request 2026-10-25: steps before the stages → Stage 1, 2, 3…
  side by side → their sub-assemblies with their steps below (child parts
  only on hover) → all merge down into the main assembly). Not yet in the print view / Excel.
- The element 5 page shows only the assembly structure (plus Excel import /
  export and sign-off): the "Child Parts (BOM) & Routes" grid
  (`pfc-child-parts-grid.tsx`) and the "Generated Flow Chart"
  (`pfc-flow-chart.tsx`) were taken off the screen per user request
  2026-10-25. The components still exist; the print view is unchanged.
- Auto-numbering (user request 2026-10-25): stages, sub-assemblies and their
  child parts are never named/typed — "Add stage" / "Add sub-assembly" are
  plain buttons, and the UI shows "Stage 2", "Sub-assembly 2.1", child part
  "2.1.1", computed positionally by `lib/calc/pfc-numbering.ts` (not stored;
  reordering/deleting renumbers). `PfcStage.name` / `PfcSubAssembly.partNo`
  / `description` stay in the schema but are written blank. "Add child part
  1.1.N" likewise creates the part in one click (blank part no. /
  description, qty 1); its BOM details are optional, filled in via the
  chip's Edit (`updateChildPart`), so `childPartSchema` allows blanks — the
  BOM grid's own add form still requires them client-side.
- Process steps on the structure (user request 2026-10-25): "+ Add step"
  dropdowns (Operation master; Raw material / Kitting / Full welding added
  by migration `20261025120000_pfc_structure_process_steps`) before the
  stages, on each sub-assembly and on each child part. Stored as ordinary
  `Route`/`RouteStep`s: `Route.preStage` (one per element) and
  `Route.subAssemblyId` (cascade-deleted with the sub-assembly); child parts
  use their existing BOM route. `addStructureStep` creates the route on first
  use and shares `addRouteStep`'s auto-Inspection-after rule. The main
  assembly route is `childPartId`, `subAssemblyId` null and `preStage`
  false — filter on all three. `getProcessStepList` (PFMEA / Control Plan)
  orders before-stages → child parts → sub-assemblies → main assembly.

## Instruments / Checking Aids (element 16)

- `Instrument` is a global master (not per PPAP). Status is never stored:
  `lib/calc/calibration.ts` computes VALID / DUE_SOON (due within the
  configurable window, `AppSetting` `calibration.dueSoonDays`, default 15) /
  OVERDUE / NOT_CALIBRATED (no due date) on every render.
- `calibrationDue` = calibratedOn + `calibrationFrequencyMonths`, unless
  `calibrationDueOverridden`. The reference sheet mostly uses "anniversary −
  1 day" dues (04-06-2025 → 03-06-2026), so the importer keeps the sheet's
  own date as an override wherever it differs from the computed one — don't
  "normalise" those dates.
- Any instrument picker (Control Plan, Dimensional, MSA, SPC) must call
  `assertInstrumentPickable(newId, previousId)` on save: newly picking an
  OVERDUE / NOT_CALIBRATED instrument is rejected; re-saving a row whose
  instrument has since lapsed is allowed.
- Weekly due/overdue email: `GET /api/cron/calibration-digest` with
  `Authorization: Bearer $CRON_SECRET`, called by an external scheduler (the
  app has none). Also "Send digest now" on /instruments.

## CSR (element 17)

- The CSR library (`CsrSection` / `CsrRequirement`) is per customer, edited
  at /csr and reused by all that customer's parts. Compliance
  (`CsrCompliance`, complied Y/N/null = not assessed) and zone maps
  (`CsrZoneMapPage` / `CsrZoneMapView`) are per PPAP element 17.
- Zone-map annotations are JSON in fractions (0-1) of the cropped picture
  (`lib/calc/csr.ts`); `crop` reproduces the reference sheet's picture
  crops. The sheet's screenshots already have the zone arrows drawn in, so
  the seed adds no annotations.
- AAR (element 13) reads zone A criteria (gloss %, min DFT, viewing
  distance — parsed from the rule text, tagged by `criteriaKey`) via
  `getAarCriteriaForPpap`; external callers use
  `GET /api/csr/[customerId]/zones`.

## Audit & formatting

- Audit-log every create/update/approve: user, timestamp, before/after JSON.
- Dates stored as ISO (UTC) in the database, displayed `DD-MM-YYYY` (India)
  in the UI. All dimensions are in mm unless the source document states
  otherwise (e.g. weight in kg).

## Known data quirks in the reference workbook (don't silently "fix" these by inventing data)

- Customer name is `TLD STL` almost everywhere, but the Dimensional Report
  sheet says `TLD Maini` — treat `TLD STL` as canonical; it's a typo in the
  source, not a second customer.
- The two SPC sheets (element 11) describe an unrelated part ("Pin, D76, 1
  Level", Part No. 1368082) — a leftover template, not the NBL chassis. Seed
  element 11 as `NOT_STARTED` for the real PPAP rather than importing that
  mismatched data.
- MSA, LAB Reports, and Sample Production Part sheets are blank templates
  with image-paste placeholders — that's expected for an initial submission
  still in progress, not missing extraction.
