import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { assertCanViewPpap } from "@/lib/permissions";
import { LabMcrPrint } from "@/components/ppap-pages/lab-mcr-print";

/** /ppap/[id]/12/mcr — the Material Clearance Record cover page(s) of element 12 (rendered to PDF by lib/mcr-print.ts). */
export default async function McrPrintPage({ params }: { params: Promise<{ id: string; element: string }> }) {
  const { id, element } = await params;
  if (element !== "12") notFound();
  const ppap = await prisma.ppap.findUnique({ where: { id }, select: { customerId: true } });
  if (!ppap) notFound();
  await assertCanViewPpap(ppap.customerId);
  return <LabMcrPrint ppapId={id} />;
}
