import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getLabsForPicker, getMaterialSpecsForLabPicker, getHeatBatchOptionsForPpap } from "@/lib/actions/lab";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, ApplicabilityBadge } from "@/components/status-badge";
import { SignatureBlock } from "@/components/signature-block";
import { LabAddReport } from "@/components/ppap-pages/lab-add-report";
import { LabReportCard } from "@/components/ppap-pages/lab-report-card";
import { LabMcrSection } from "@/components/ppap-pages/lab-mcr-section";
import { getMcrData } from "@/lib/data/mcr";

export async function LabPage({ ppapId }: { ppapId: string }) {
  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId, elementNo: 12 } },
    include: {
      preparedBy: true,
      checkedBy: true,
      approvedBy: true,
      labReports: {
        orderBy: { sortOrder: "asc" },
        include: {
          lab: true,
          // select only — MaterialSpec also carries Decimal chemical/
          // mechanical limits, which can't cross the server/client
          // boundary as props to the (client) LabReportCard below.
          materialSpec: { select: { id: true, standard: true, grade: true } },
          rmtcReportRow: true,
          testDetails: { orderBy: { sortOrder: "asc" } },
          mechanicalResults: true,
          chemicalResults: true,
          paintResults: true,
        },
      },
    },
  });

  const users = await prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });
  const labs = await getLabsForPicker();
  const materialSpecs = await getMaterialSpecsForLabPicker();
  const heatOptions = await getHeatBatchOptionsForPpap(ppapId);

  const locked = element.status === "APPROVED";
  const mcr = await getMcrData(ppapId);

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-6">
      {element.applicability === "NA" ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Lab Report Documents &amp; Material Clearance Record</CardTitle>
          </CardHeader>
          <CardContent>
            <LabMcrSection
              ppapId={ppapId}
              ppapElementId={element.id}
              locked={locked || mcr.ppapStatus === "CLOSED"}
              documents={mcr.documents.map((d) => ({
                id: d.id,
                fileUrl: d.fileUrl,
                fileName: d.fileName,
                extractionStatus: d.extractionStatus,
                extractionError: d.extractionError,
                labName: d.labName,
                materialSpec: d.materialSpec,
                heatNo: d.heatNo,
                plateNo: d.plateNo,
                sizeText: d.sizeText,
                tests: d.tests,
              }))}
              header={{ partNumber: mcr.header.partNumber, partName: mcr.header.partName, values: mcr.header }}
              groups={mcr.groups}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>12. Lab Reports / Qualified Laboratory Documentation</CardTitle>
          <div className="flex items-center gap-2">
            <ApplicabilityBadge applicability={element.applicability} />
            <StatusBadge status={element.status} />
            <Button
              render={<a href={`/api/ppap/${ppapId}/12/mcr`} target="_blank" rel="noreferrer" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Print
            </Button>
            <Button render={<a href={`/api/ppap/${ppapId}/12/pdf`} />} nativeButton={false} variant="outline" size="sm">
              Download PDF
            </Button>
            <Button render={<a href={`/api/lab/${element.id}/export`} />} nativeButton={false} variant="outline" size="sm">
              Export Excel
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {element.applicability === "NA" ? (
            <p className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground">N/A — {element.naReason}</p>
          ) : (
            <>
              {element.labReports.map((report) => (
                <LabReportCard
                  key={report.id}
                  ppapElementId={element.id}
                  locked={locked}
                  report={report}
                  labs={labs}
                  materialSpecs={materialSpecs}
                  heatOptions={heatOptions}
                />
              ))}
              {element.labReports.length === 0 ? <p className="text-sm text-muted-foreground">No lab reports yet.</p> : null}
              <p className="text-xs text-muted-foreground">
                Labs, accreditation certificates and expiry dates are managed on the{" "}
                <Link href="/labs" className="text-primary underline">
                  Labs
                </Link>{" "}
                page.
              </p>
              {!locked ? <LabAddReport ppapElementId={element.id} labs={labs} materialSpecs={materialSpecs} heatOptions={heatOptions} /> : null}
            </>
          )}

          <SignatureBlock
            ppapElementId={element.id}
            stages={["PREPARED", "CHECKED", "APPROVED"]}
            status={element.status}
            users={users}
            prepared={{ byId: element.preparedById, at: element.preparedAt }}
            checked={{ byId: element.checkedById, at: element.checkedAt }}
            approved={{ byId: element.approvedById, at: element.approvedAt }}
          />
        </CardContent>
      </Card>
    </main>
  );
}
