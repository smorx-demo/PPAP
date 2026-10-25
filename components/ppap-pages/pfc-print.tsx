import { prisma } from "@/lib/prisma";
import { formatDateIndia } from "@/lib/format";
import { PrintFooter } from "@/components/print-footer";

const SYMBOL_LABEL: Record<string, string> = {
  OPERATION: "○",
  INSPECTION: "□",
  STORAGE: "▽",
  TRANSPORT: "→",
  DELAY: "D",
};

const ROWS_PER_PAGE = 18;

export async function PfcPrint({ ppapId }: { ppapId: string }) {
  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId, elementNo: 5 } },
    include: {
      preparedBy: true,
      checkedBy: true,
      ppap: { include: { customer: true, partRevision: { include: { part: true } } } },
      childParts: {
        orderBy: { itemNo: "asc" },
        include: { route: { include: { steps: { orderBy: { sequence: "asc" }, include: { operation: true } } } } },
      },
      routes: {
        where: { childPartId: null, subAssemblyId: null, preStage: false },
        include: { steps: { orderBy: { sequence: "asc" }, include: { operation: true } } },
      },
    },
  });

  if (element.applicability === "NA") {
    return (
      <div className="mx-auto max-w-4xl bg-white p-6 text-black">
        <p className="text-sm">N/A — {element.naReason}</p>
      </div>
    );
  }

  const mainRoute = element.routes[0] ?? null;
  const pages: (typeof element.childParts)[] = [];
  for (let i = 0; i < element.childParts.length; i += ROWS_PER_PAGE) {
    pages.push(element.childParts.slice(i, i + ROWS_PER_PAGE));
  }
  const totalPages = pages.length + (mainRoute ? 1 : 0);

  const part = element.ppap.partRevision.part;
  const footerEntries = [
    { label: "Prepared By", name: element.preparedBy?.name ?? null, date: element.preparedAt },
    { label: "Checked By", name: element.checkedBy?.name ?? null, date: element.checkedAt },
  ];

  function RouteCell({ steps }: { steps: { operation: { symbol: string; name: string } }[] }) {
    return (
      <span>
        {steps.map((s, i) => (
          <span key={i}>
            {i > 0 ? " → " : ""}
            {SYMBOL_LABEL[s.operation.symbol] ?? ""} {s.operation.name}
          </span>
        ))}
      </span>
    );
  }

  return (
    <div className="bg-white text-black">
      <style>{`
        @page { size: A3 landscape; margin: 10mm; }
        @media print {
          .pfc-print-page { page-break-after: always; }
          .pfc-print-page:last-child { page-break-after: auto; }
        }
      `}</style>

      {pages.map((pageRows, pageIndex) => (
        <div key={pageIndex} className="pfc-print-page p-4">
          <table className="w-full border-collapse border border-black text-[9px]">
            <thead>
              <tr>
                <td colSpan={7} className="border border-black p-1 text-center font-semibold">
                  FLOW CHART FOR {part.projectModel ?? ""} CHASSIS — {part.partNumber} Rev.{element.ppap.partRevision.revision}
                </td>
              </tr>
              <tr className="bg-muted/40">
                <th className="border border-black p-1">Item No</th>
                <th className="border border-black p-1">Sketch</th>
                <th className="border border-black p-1">Part No</th>
                <th className="border border-black p-1">Description</th>
                <th className="border border-black p-1">Qty/Str</th>
                <th className="border border-black p-1">Side</th>
                <th className="border border-black p-1">Process Route</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((cp) => (
                <tr key={cp.id}>
                  <td className="border border-black p-1 text-center">{cp.itemNo}</td>
                  <td className="border border-black p-1 text-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {cp.sketchImageUrl ? <img src={cp.sketchImageUrl} alt="" className="mx-auto h-8 w-8 object-contain" /> : "—"}
                  </td>
                  <td className="border border-black p-1">{cp.partNo}</td>
                  <td className="border border-black p-1">{cp.description}</td>
                  <td className="border border-black p-1 text-center">{cp.qtyPerAssembly}</td>
                  <td className="border border-black p-1 text-center">{cp.side}</td>
                  <td className="border border-black p-1">
                    {cp.type === "BOP" ? "BOP — " : ""}
                    <RouteCell steps={cp.route?.steps ?? []} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <PrintFooter entries={footerEntries} />
          <table className="mt-1 w-full border-collapse border border-black text-[9px]">
            <tbody>
              <tr>
                <td className="border border-black p-1">Doc Description : {part.partName}</td>
                <td className="border border-black p-1">Doc No : {element.docNo}</td>
                <td className="border border-black p-1">
                  Sheet {pageIndex + 1} of {totalPages}
                </td>
                <td className="border border-black p-1">Date: {formatDateIndia(new Date())}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      {mainRoute ? (
        <div className="pfc-print-page p-4">
          <table className="w-full border-collapse border border-black text-[9px]">
            <thead>
              <tr>
                <td className="border border-black p-1 text-center font-semibold">Main Assembly Route</td>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-black p-2">
                  <RouteCell steps={mainRoute.steps} />
                </td>
              </tr>
            </tbody>
          </table>

          <PrintFooter entries={footerEntries} />
          <table className="mt-1 w-full border-collapse border border-black text-[9px]">
            <tbody>
              <tr>
                <td className="border border-black p-1">Doc Description : {part.partName}</td>
                <td className="border border-black p-1">Doc No : {element.docNo}</td>
                <td className="border border-black p-1">
                  Sheet {totalPages} of {totalPages}
                </td>
                <td className="border border-black p-1">Date: {formatDateIndia(new Date())}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
