import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, ApplicabilityBadge } from "@/components/status-badge";
import { SignatureBlock } from "@/components/signature-block";
import { DesignRecordForm } from "@/components/ppap-pages/design-record-form";
import { DesignRecordAutoballoon } from "@/components/ppap-pages/design-record-autoballoon";
import { getCurrentUser } from "@/lib/permissions";

export async function DesignRecordPage({ ppapId }: { ppapId: string }) {
  const ppap = await prisma.ppap.findUniqueOrThrow({
    where: { id: ppapId },
    include: { customer: true, partRevision: { include: { part: true } } },
  });

  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId, elementNo: 1 } },
    include: {
      designRecordDetail: {
        include: { materialSpec: { select: { id: true, standard: true, grade: true } } },
      },
      specialCharacteristics: { orderBy: { sortOrder: "asc" } },
      balloons: { orderBy: { balloonNo: "asc" } },
    },
  });

  // select only plain-serializable fields — Prisma's Decimal fields can't
  // cross the Server->Client Component boundary (see /ppap/new/page.tsx).
  const materialSpecs = await prisma.materialSpec.findMany({
    orderBy: { grade: "asc" },
    select: { id: true, standard: true, grade: true },
  });

  const users = await prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });

  const locked = element.status === "APPROVED";
  const user = await getCurrentUser();
  const workspaceEditable = !locked && ppap.status !== "CLOSED" && Boolean(user?.can.editSupplierData);

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-6">
      {/* Order (user request 2026-10-25): Design Record details and special
          characteristics, then the ballooning workspace with the inspection
          report inline, then the Prepared / Approved sign-off. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>1. Design Records</CardTitle>
          <div className="flex items-center gap-2">
            <ApplicabilityBadge applicability={element.applicability} />
            <StatusBadge status={element.status} />
            <Button
              render={<Link href={`/ppap/${ppapId}/1/print`} target="_blank" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Print
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {element.naReason ? (
            <p className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground">N/A — {element.naReason}</p>
          ) : (
            <DesignRecordForm
              ppapElementId={element.id}
              locked={locked}
              master={{
                partId: ppap.partRevision.part.id,
                partName: ppap.partRevision.part.partName,
                partNumber: ppap.partRevision.part.partNumber,
                customerId: ppap.customer.id,
                customerName: ppap.customer.name,
                partRevisionId: ppap.partRevision.id,
                drawingNumber: ppap.partRevision.drawingNo ?? "",
                drawingRevision: ppap.partRevision.revision,
              }}
              detail={element.designRecordDetail}
              materialSpecs={materialSpecs}
              specialCharacteristics={element.specialCharacteristics}
            />
          )}
        </CardContent>
      </Card>

      {element.naReason ? null : (
        <Card>
          <CardHeader>
            <CardTitle>Engineering Drawing, Ballooning &amp; Inspection Report</CardTitle>
          </CardHeader>
          <CardContent>
            <DesignRecordAutoballoon
              ppapId={ppapId}
              ppapElementId={element.id}
              jobId={element.designRecordDetail?.autoballoonJobId ?? null}
              balloonCount={element.balloons.length}
              editable={workspaceEditable}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sign-off</CardTitle>
        </CardHeader>
        <CardContent>
          <SignatureBlock
            ppapElementId={element.id}
            stages={["PREPARED", "APPROVED"]}
            status={element.status}
            users={users}
            prepared={{ byId: element.preparedById, at: element.preparedAt }}
            approved={{ byId: element.approvedById, at: element.approvedAt }}
          />
        </CardContent>
      </Card>
    </main>
  );
}
