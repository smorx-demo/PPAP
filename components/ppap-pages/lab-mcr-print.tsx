import { Fragment } from "react";
import { PDFDocument } from "pdf-lib";
import { getMcrData, type McrHeader } from "@/lib/data/mcr";
import { readStoredUpload } from "@/lib/lab-document-extract";
import {
  MCR_COLUMNS,
  MCR_ENCLOSURE_COLUMNS,
  MCR_LAYOUT,
  mcrEnclosures,
  mcrFooter,
  paginateMcr,
  type McrEnclosure,
  type McrPageGroup,
} from "@/lib/calc/mcr";

/**
 * Material Clearance Record cover page(s), A4 landscape — layout of sheet
 * "Material Clearance record" in "MCR 109300003635- NEW REV-9". Printed in
 * front of the uploaded lab reports by lib/mcr-print.ts, and lists those
 * reports ("Enclosed lab reports", same order and page counts). The page split is
 * computed (lib/calc/mcr.ts paginateMcr) so the header block and table header
 * repeat on every page and "Page X of Y" is exact.
 */

const border = "border border-black";
const cell = `${border} px-1 py-0.5 align-top whitespace-pre-line break-words`;
const label = `${border} px-1.5 py-1 font-bold whitespace-nowrap`;
const value = `${border} px-1.5 py-1`;

function HeaderBlock({ h }: { h: McrHeader }) {
  const rows: [string, string][][] = [
    [["Part Number:", h.partNumber], ["Issue Number:", h.issueNumber], ["Part Name:", h.partName], ["QTY:", h.qty]],
    [["Project Name:", h.projectName], ["PO Number:", h.poNumber], ["", ""], ["Serial Numbers:", h.serialNumbers]],
    [["Location", h.location], ["MCR Number:", h.mcrNumber], ["Supplier Name:", h.supplierName], ["Date:", h.mcrDate]],
  ];
  return (
    <table className="w-full table-fixed border-collapse text-[9pt]">
      <colgroup>
        {[24, 34, 26, 40, 28, 70, 28, 27].map((mm, i) => (
          <col key={i} style={{ width: `${mm}mm` }} />
        ))}
      </colgroup>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r}>
            {row.map(([l, v], c) => (
              <Fragment key={c}>
                <td className={label}>{l}</td>
                <td className={value}>{v}</td>
              </Fragment>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GroupRows({ g }: { g: McrPageGroup }) {
  const codes = g.itemCodes.length ? g.itemCodes : [""];
  const span = codes.length;
  const merged = (text: string) => (
    <td rowSpan={span} className={cell}>
      {text}
    </td>
  );
  return (
    <>
      {codes.map((code, i) => (
        <tr key={i} style={{ height: `${MCR_LAYOUT.rowMm}mm`, breakInside: "avoid" }}>
          {i === 0 ? (
            <td rowSpan={span} className={`${cell} text-center`}>
              {g.srNo}
              {g.continued ? <span className="block text-[7pt]">(contd.)</span> : null}
            </td>
          ) : null}
          <td className={cell}>{code}</td>
          {i === 0 ? (
            <>
              {merged(g.group.itemDescription)}
              {merged(g.group.size)}
              {merged(g.group.materialSpec)}
              {merged(g.group.materialIdNo)}
              {merged(g.group.heatPlateNo)}
              {merged(g.group.testCertificate)}
              {merged(g.group.nablReports)}
            </>
          ) : null}
        </tr>
      ))}
    </>
  );
}

function SignOff() {
  const boxes = [
    ["Prepared By", "(Name, Signature & Date)", "Supplier/Tata Power SED"],
    ["Accepted By", "(Name, Signature & Date)", "Tata Power SED QA"],
    ["Customer Clearance", "(Name, Signature & Date)", "(If Required)"],
  ];
  return (
    <div className="mt-3 grid grid-cols-3 gap-0" style={{ height: `${MCR_LAYOUT.signOffMm - 4}mm`, breakInside: "avoid" }}>
      {boxes.map((lines) => (
        <div key={lines[0]} className={`${border} -ml-px p-2 text-center text-[9pt] font-semibold first:ml-0`}>
          {lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Pages each file adds after the cover — same rules as lib/mcr-print.ts (null = it gets an error page instead). */
async function pageCount(fileUrl: string): Promise<number | null> {
  try {
    const bytes = await readStoredUpload(fileUrl);
    if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
    if ((bytes[0] === 0x89 && bytes[1] === 0x50) || (bytes[0] === 0xff && bytes[1] === 0xd8)) return 1;
    return null;
  } catch {
    return null;
  }
}

function EnclosuresTable({ rows, continued }: { rows: McrEnclosure[]; continued: boolean }) {
  return (
    <div className="mt-3" style={{ breakInside: "avoid" }}>
      <h2 className="mb-1 text-[9pt] font-bold">Enclosed lab reports (printed after this record, in this order){continued ? " — contd." : ""}</h2>
      <table className="w-full table-fixed border-collapse text-[8pt] leading-tight">
        <colgroup>
          {MCR_ENCLOSURE_COLUMNS.map((c) => (
            <col key={c.key} style={{ width: `${c.mm}mm` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {MCR_ENCLOSURE_COLUMNS.map((c) => (
              <th key={c.key} className={`${border} bg-gray-100 px-1 py-1 text-center font-bold`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.no} style={{ minHeight: `${MCR_LAYOUT.rowMm}mm`, breakInside: "avoid" }}>
              <td className={`${cell} text-center`}>{e.no}</td>
              <td className={cell}>{e.fileName}</td>
              <td className={cell}>{e.labName || "—"}</td>
              <td className={cell}>{e.materialSpec || "—"}</td>
              <td className={cell}>{e.heatPlateNo || "—"}</td>
              <td className={cell}>{e.tests || "—"}</td>
              <td className={`${cell} text-center`}>{e.pages ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export async function LabMcrPrint({ ppapId }: { ppapId: string }) {
  const data = await getMcrData(ppapId);
  const counts = await Promise.all(data.documents.map((d) => pageCount(d.fileUrl)));
  const enclosures = mcrEnclosures(data.documents, counts);
  const groups = data.printGroups;
  const pages = paginateMcr(groups, enclosures);

  return (
    <div className="mcr-print bg-white text-black">
      <style>{`
        @page { size: A4 landscape; margin: 10mm; }
        .mcr-print { font-family: Arial, Helvetica, sans-serif; }
        .mcr-page { height: 188mm; display: flex; flex-direction: column; break-after: page; }
        .mcr-page:last-child { break-after: auto; }
        .mcr-print tr { break-inside: avoid; }
        @media screen { .mcr-page { width: 277mm; margin: 0 auto 12mm; padding: 4mm; box-shadow: 0 0 0 1px #ccc; height: auto; min-height: 188mm; } }
      `}</style>
      {pages.map((page, p) => (
        <section key={p} className="mcr-page" data-testid="mcr-page">
          <h1 className="mb-1.5 text-center text-[13pt] font-bold tracking-wide">MATERIAL CLEARANCE RECORD</h1>
          <HeaderBlock h={data.header} />
          <table className="mt-2 w-full table-fixed border-collapse text-[8pt] leading-tight">
            <colgroup>
              {MCR_COLUMNS.map((c) => (
                <col key={c.key} style={{ width: `${c.mm}mm` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {MCR_COLUMNS.map((c) => (
                  <th key={c.key} className={`${border} bg-gray-100 px-1 py-1 text-center font-bold`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.groups.map((g) => (
                <GroupRows key={`${g.srNo}-${g.itemCodes[0] ?? ""}`} g={g} />
              ))}
              {groups.length === 0 && p === 0 ? (
                <tr>
                  <td colSpan={MCR_COLUMNS.length} className={`${cell} py-3 text-center italic`}>
                    No material groups yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {page.enclosures.length ? (
            <EnclosuresTable rows={page.enclosures} continued={pages.slice(0, p).some((q) => q.enclosures.length > 0)} />
          ) : null}
          {page.signOff && enclosures.length === 0 ? (
            <p className="mt-2 text-[8pt] italic">No lab reports are attached to this record.</p>
          ) : null}
          {page.signOff ? <SignOff /> : null}
          <div className="mt-auto pt-2 text-right text-[8pt]">{mcrFooter(data.header.mcrNumber, p + 1, pages.length)}</div>
        </section>
      ))}
    </div>
  );
}
