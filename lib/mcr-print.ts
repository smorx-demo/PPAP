import { PDFDocument, PageSizes, StandardFonts, rgb } from "pdf-lib";
import { prisma } from "@/lib/prisma";
import { renderPrintRouteToPdf } from "@/lib/pdf";
import { readStoredUpload } from "@/lib/lab-document-extract";

/**
 * Element 12 print: the Material Clearance Record cover page(s), A4
 * landscape (route /ppap/[id]/12/mcr), then every uploaded lab report file in
 * upload order — PDFs page by page, images one per page scaled to fit. A file
 * that can't be added gets a page naming it and the reason, so nothing goes
 * missing silently; the names are also returned for the response header.
 */
export async function buildMcrPrintPdf(ppapId: string, origin: string, cookie: string | null) {
  const cover = await renderPrintRouteToPdf(`${origin}/ppap/${encodeURIComponent(ppapId)}/12/mcr`, { cookie, landscape: true });
  const out = await PDFDocument.load(cover);
  out.setTitle("Material Clearance Record and lab reports");
  out.setCreator("PPAP Management — Ingenious Engineering");

  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId, elementNo: 12 } },
    select: { labDocuments: { orderBy: [{ sortOrder: "asc" }, { uploadedAt: "asc" }], select: { fileName: true, fileUrl: true } } },
  });

  const failed: { fileName: string; reason: string }[] = [];
  for (const doc of element.labDocuments) {
    try {
      const bytes = await readStoredUpload(doc.fileUrl);
      const head = bytes.subarray(0, 4).toString("latin1");
      if (head === "%PDF") {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        addImagePage(out, await out.embedPng(bytes));
      } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        addImagePage(out, await out.embedJpg(bytes));
      } else {
        throw new Error("not a PDF, PNG or JPG file");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ fileName: doc.fileName, reason });
      await addErrorPage(out, doc.fileName, reason);
    }
  }

  return { pdf: await out.save(), documentCount: element.labDocuments.length, failed };
}

function addImagePage(out: PDFDocument, img: Awaited<ReturnType<PDFDocument["embedPng"]>>) {
  const [w, h] = img.width > img.height ? [PageSizes.A4[1], PageSizes.A4[0]] : PageSizes.A4;
  const page = out.addPage([w, h]);
  const margin = 28;
  const scale = Math.min((w - 2 * margin) / img.width, (h - 2 * margin) / img.height);
  page.drawImage(img, { x: (w - img.width * scale) / 2, y: (h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
}

/** Standard PDF fonts only cover WinAnsi; anything else in a file name prints as "?". */
const printable = (s: string) => s.replace(/[^\x20-\x7E]/g, "?");

async function addErrorPage(out: PDFDocument, fileName: string, reason: string) {
  const page = out.addPage(PageSizes.A4);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const red = rgb(0.7, 0.05, 0.05);
  page.drawText("LAB REPORT COULD NOT BE PRINTED", { x: 50, y: 760, size: 16, font: bold, color: red });
  page.drawText(`File: ${printable(fileName)}`, { x: 50, y: 726, size: 11, font, maxWidth: 495 });
  page.drawText(`Reason: ${printable(reason)}`, { x: 50, y: 704, size: 11, font, maxWidth: 495, lineHeight: 14 });
  page.drawText("Open the original file from the Lab Reports page and print it separately, or re-upload it.", { x: 50, y: 660, size: 10, font, maxWidth: 495 });
}
