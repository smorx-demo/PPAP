-- CreateTable
CREATE TABLE "lab_documents" (
    "id" TEXT NOT NULL,
    "ppapElementId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "extractionStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "labName" TEXT,
    "materialSpec" TEXT,
    "heatNo" TEXT,
    "plateNo" TEXT,
    "sizeText" TEXT,
    "tests" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcr_records" (
    "id" TEXT NOT NULL,
    "ppapElementId" TEXT NOT NULL,
    "issueNumber" TEXT,
    "qty" TEXT,
    "projectName" TEXT,
    "poNumber" TEXT,
    "serialNumbers" TEXT,
    "location" TEXT,
    "mcrNumber" TEXT,
    "supplierName" TEXT,
    "mcrDate" TEXT,
    "groups" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcr_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lab_documents_ppapElementId_idx" ON "lab_documents"("ppapElementId");

-- CreateIndex
CREATE UNIQUE INDEX "mcr_records_ppapElementId_key" ON "mcr_records"("ppapElementId");

-- AddForeignKey
ALTER TABLE "lab_documents" ADD CONSTRAINT "lab_documents_ppapElementId_fkey" FOREIGN KEY ("ppapElementId") REFERENCES "ppap_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcr_records" ADD CONSTRAINT "mcr_records_ppapElementId_fkey" FOREIGN KEY ("ppapElementId") REFERENCES "ppap_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

