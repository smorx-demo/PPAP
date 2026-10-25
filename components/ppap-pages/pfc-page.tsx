import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge, ApplicabilityBadge } from "@/components/status-badge";
import { SignatureBlock } from "@/components/signature-block";
import { PfcExcelActions } from "@/components/ppap-pages/pfc-excel-actions";
import { PfcAssemblyStructure } from "@/components/ppap-pages/pfc-assembly-structure";
import { numberAssemblyStructure } from "@/lib/calc/pfc-numbering";

export async function PfcPage({ ppapId }: { ppapId: string }) {
  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId, elementNo: 5 } },
    include: {
      preparedBy: true,
      checkedBy: true,
      approvedBy: true,
      // Only for the "add existing BOM part" picker — the BOM grid and the
      // generated flow chart are not shown on this page (user request
      // 2026-10-25); they remain in the print view.
      childParts: { orderBy: { sortOrder: "asc" }, select: { id: true, itemNo: true, partNo: true, description: true, subAssemblyId: true } },
    },
  });

  const stepsSelect = {
    steps: { orderBy: { sequence: "asc" }, select: { id: true, operation: { select: { name: true, symbol: true } } } },
  } as const;
  const flatSteps = (route: { steps: { id: string; operation: { name: string; symbol: string } }[] } | null) =>
    (route?.steps ?? []).map((s) => ({ id: s.id, name: s.operation.name, symbol: s.operation.symbol }));
  const childPartSelect = {
    id: true,
    itemNo: true,
    partNo: true,
    description: true,
    qtyPerAssembly: true,
    side: true,
    type: true,
    parentChildPartId: true,
    route: { select: stepsSelect },
  } as const;
  const stageRows = await prisma.pfcStage.findMany({
    where: { ppapElementId: element.id },
    orderBy: { sortOrder: "asc" },
    include: {
      subAssemblies: {
        orderBy: { sortOrder: "asc" },
        include: { childParts: { orderBy: { sortOrder: "asc" }, select: childPartSelect }, route: { select: stepsSelect } },
      },
    },
  });
  const stages = numberAssemblyStructure(
    stageRows.map((stage) => ({
      ...stage,
      subAssemblies: stage.subAssemblies.map(({ route, childParts, ...sub }) => ({
        ...sub,
        steps: flatSteps(route),
        childParts: childParts.map(({ route: cpRoute, ...cp }) => ({ ...cp, steps: flatSteps(cpRoute) })),
      })),
    })),
  );
  const preStageRoute = await prisma.route.findFirst({ where: { ppapElementId: element.id, preStage: true }, select: stepsSelect });
  const preStageSteps = flatSteps(preStageRoute);
  const ppap = await prisma.ppap.findUniqueOrThrow({
    where: { id: ppapId },
    select: { status: true, partRevision: { select: { part: { select: { partNumber: true, partName: true } } } } },
  });
  const ppapClosed = ppap.status === "CLOSED";
  const mainAssembly = { partNo: ppap.partRevision.part.partNumber, name: ppap.partRevision.part.partName };
  const unassigned = element.childParts
    .filter((c) => !c.subAssemblyId)
    .map((c) => ({ id: c.id, itemNo: c.itemNo, partNo: c.partNo, description: c.description }));

  const operations = await prisma.operation.findMany({ orderBy: { sortOrder: "asc" } });
  const users = await prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } });

  const locked = element.status === "APPROVED";

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>5. Process Flow Chart</CardTitle>
          <div className="flex items-center gap-2">
            <ApplicabilityBadge applicability={element.applicability} />
            <StatusBadge status={element.status} />
            <Button
              render={<Link href={`/ppap/${ppapId}/5/print`} target="_blank" />}
              nativeButton={false}
              variant="outline"
              size="sm"
            >
              Print
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {element.applicability === "NA" ? (
            <p className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground">N/A — {element.naReason}</p>
          ) : (
            <>
              <PfcExcelActions ppapElementId={element.id} locked={locked} />

              <section>
                <h3 className="mb-2 text-sm font-semibold">Stages, Sub-assemblies &amp; Main Assembly</h3>
                <PfcAssemblyStructure
                  ppapElementId={element.id}
                  locked={locked || ppapClosed}
                  mainAssembly={mainAssembly}
                  stages={stages}
                  preStageSteps={preStageSteps}
                  operations={operations.map((o) => ({ id: o.id, name: o.name }))}
                  unassigned={unassigned}
                />
              </section>
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
