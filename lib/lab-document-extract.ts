import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { resolveStoredFilePath } from "@/lib/storage";

/**
 * Reads one uploaded lab report (element 12, LabDocument) with Claude and
 * returns the fields the Material Clearance Record needs. The file goes to
 * the Anthropic API (ANTHROPIC_API_KEY in .env); the user reviews and can
 * correct every field afterwards.
 */

const extractionSchema = z.object({
  labName: z.string().describe('Name of the testing laboratory, e.g. "TRH Metallurgical Laboratory". Empty if not printed.'),
  materialSpec: z.string().describe('Material specification / grade the sample was tested against, as printed, e.g. "S890QL", "IS 2062 E250 BR". Empty if not printed.'),
  heatNo: z.string().describe("Heat no. / cast no. of the sample, exactly as printed. Empty if not printed."),
  plateNo: z.string().describe("Plate no. / batch no. / sample ID of the material, exactly as printed. Empty if not printed."),
  sizeText: z.string().describe('Thickness / diameter / size of the sample as printed, e.g. "10 MM", "Ø160 MM". Empty if not printed.'),
  tests: z
    .array(
      z.object({
        type: z.string().describe('Test type letter: "C" chemical analysis, "M" mechanical / tensile, "I" impact, "H" hardness, "UT" ultrasonic; another short code for any other test.'),
        reportNo: z.string().describe('The certificate / report number exactly as printed, e.g. "TRH/24-25/7122-8" or "ULR-TC904926000006998F". Do not add the type letter.'),
        date: z.string().describe("Report / issue date as DD-MM-YYYY. Empty if not printed."),
      }),
    )
    .describe("Every test certificate in this file (one file can contain several, e.g. chemical + mechanical + impact)."),
});
export type ExtractedLabDocument = z.infer<typeof extractionSchema>;

const SYSTEM_PROMPT = `You read laboratory test reports (NABL test certificates for steel and forgings) for an automotive supplier's PPAP Material Clearance Record.
Return only what is printed on the document. Never guess or invent values: leave a field empty when the document does not show it.
Copy numbers (report no., heat no., plate no.) character for character, including slashes and dashes.`;

const MEDIA_TYPES: Record<string, "application/pdf" | "image/png" | "image/jpeg"> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export class LabExtractionError extends Error {}

/** Bytes of a file saved by lib/storage.ts (`/api/files/...` URL). */
export async function readStoredUpload(url: string): Promise<Buffer> {
  if (!url.startsWith("/api/files/")) throw new LabExtractionError("The file is not in PPAP storage.");
  return readFile(resolveStoredFilePath(url.slice("/api/files/".length).split("/").map(decodeURIComponent)));
}

export function labDocumentMediaType(fileName: string) {
  return MEDIA_TYPES[path.extname(fileName).toLowerCase()] ?? null;
}

export async function extractLabDocument(file: { fileUrl: string; fileName: string }): Promise<ExtractedLabDocument> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new LabExtractionError("Automatic reading is off — add ANTHROPIC_API_KEY to .env, or fill the fields in by hand.");
  }
  const mediaType = labDocumentMediaType(file.fileName);
  if (!mediaType) throw new LabExtractionError("Only PDF, PNG and JPG lab reports can be read.");
  const data = (await readStoredUpload(file.fileUrl)).toString("base64");

  const source: Anthropic.Beta.BetaContentBlockParam =
    mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data } };

  const client = new Anthropic();
  let response;
  try {
    response = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // Re-run on Anthropic's recommended model if this one declines the request.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: { effort: "medium", format: betaZodOutputFormat(extractionSchema) },
      messages: [{ role: "user", content: [source, { type: "text", text: `Read this lab report (file "${file.fileName}").` }] }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new LabExtractionError("The Anthropic API key in .env was rejected.");
    if (err instanceof Anthropic.RateLimitError) throw new LabExtractionError("The Anthropic API is rate-limiting requests — try Re-read in a minute.");
    if (err instanceof Anthropic.BadRequestError) throw new LabExtractionError(`The file could not be read: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new LabExtractionError(`Anthropic API error ${err.status ?? ""}: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === "refusal") throw new LabExtractionError("The model declined to read this file — fill the fields in by hand.");
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new LabExtractionError("The reading came back incomplete — try Re-read, or fill the fields in by hand.");
  }
  return response.parsed_output;
}
