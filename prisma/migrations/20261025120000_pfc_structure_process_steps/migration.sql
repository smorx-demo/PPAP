-- Process steps on the assembly structure (element 5): a route per
-- sub-assembly, plus one "before the stages" route per element.

-- DropForeignKey
ALTER TABLE "route_steps" DROP CONSTRAINT "route_steps_routeId_fkey";

-- AlterTable
ALTER TABLE "routes" ADD COLUMN     "preStage" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "subAssemblyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "routes_subAssemblyId_key" ON "routes"("subAssemblyId");

-- AddForeignKey
ALTER TABLE "routes" ADD CONSTRAINT "routes_subAssemblyId_fkey" FOREIGN KEY ("subAssemblyId") REFERENCES "pfc_sub_assemblies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_steps" ADD CONSTRAINT "route_steps_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Operations the assembly-structure dropdowns need (user request
-- 2026-10-25): Raw material, Kitting, Full welding. Spread the existing
-- sort orders out so the new ones slot in next to their neighbours; the
-- seed (prisma/seed.ts) lists them in the same order.
UPDATE "operations" SET "sortOrder" = "sortOrder" * 10;
INSERT INTO "operations" ("id", "code", "name", "symbol", "defaultInspectionAfter", "sortOrder") VALUES
  ('op_raw_material', 'RAW_MATERIAL', 'Raw material', 'STORAGE', true, 5),
  ('op_kitting', 'KITTING', 'Kitting', 'OPERATION', false, 135),
  ('op_full_welding', 'FULL_WELDING', 'Full welding', 'OPERATION', true, 165)
ON CONFLICT ("code") DO NOTHING;
