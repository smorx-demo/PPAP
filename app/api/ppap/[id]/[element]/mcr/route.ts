import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/permissions";
import { buildMcrPrintPdf } from "@/lib/mcr-print";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ppap/[id]/12/mcr — element 12's print: Material Clearance Record
 * cover page(s) followed by every uploaded lab report, as one PDF shown inline
 * (ready for the browser's print). `?download=1` saves it instead.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; element: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { id, element } = await params;
  if (element !== "12") return new NextResponse("Not found", { status: 404 });
  const ppap = await prisma.ppap.findUnique({ where: { id }, select: { customerId: true, partRevision: { select: { part: { select: { partNumber: true } } } } } });
  if (!ppap || (user.can.ownCustomerOnly && user.customerId !== ppap.customerId)) return new NextResponse("Not found", { status: 404 });

  const { pdf, documentCount, failed } = await buildMcrPrintPdf(id, new URL(req.url).origin, req.headers.get("cookie"));
  const fileName = `MCR ${ppap.partRevision.part.partNumber} with lab reports.pdf`.replace(/[\\/:*?"<>|]/g, "_");
  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${fileName}"`,
      "X-Lab-Reports-Included": String(documentCount - failed.length),
      "X-Lab-Reports-Failed": encodeURIComponent(failed.map((f) => f.fileName).join(", ")),
    },
  });
}
