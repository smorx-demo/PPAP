-- AlterTable
ALTER TABLE "child_parts" ADD COLUMN     "subAssemblyId" TEXT;

-- CreateTable
CREATE TABLE "pfc_stages" (
    "id" TEXT NOT NULL,
    "ppapElementId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pfc_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pfc_sub_assemblies" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "partNo" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inMainAssembly" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pfc_sub_assemblies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pfc_stages_ppapElementId_idx" ON "pfc_stages"("ppapElementId");

-- CreateIndex
CREATE INDEX "pfc_sub_assemblies_stageId_idx" ON "pfc_sub_assemblies"("stageId");

-- AddForeignKey
ALTER TABLE "child_parts" ADD CONSTRAINT "child_parts_subAssemblyId_fkey" FOREIGN KEY ("subAssemblyId") REFERENCES "pfc_sub_assemblies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pfc_stages" ADD CONSTRAINT "pfc_stages_ppapElementId_fkey" FOREIGN KEY ("ppapElementId") REFERENCES "ppap_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pfc_sub_assemblies" ADD CONSTRAINT "pfc_sub_assemblies_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "pfc_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
