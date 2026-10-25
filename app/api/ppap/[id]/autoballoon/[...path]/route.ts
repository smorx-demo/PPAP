import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/permissions";
import { autoballoonFetch, AutoballoonUnavailableError } from "@/lib/autoballoon";
import { syncBalloonsFromAutoballoon } from "@/lib/autoballoon-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy from the Design Records page (element 1) to the AutoBalloon service.
 * The browser never talks to the service directly: this route applies PPAP's
 * own access rules, then forwards with the service account's token.
 *
 * - Only job / drawing-version / instrument-rule paths are forwarded (never
 *   the service's admin or auth endpoints).
 * - Viewing needs the PPAP to be in the user's customer scope; changes need a
 *   supplier user, an unapproved page and an open PPAP.
 * - A job can be used only from the PPAP it was uploaded on
 *   (`DesignRecordDetail.autoballoonJobId`, set here after an upload).
 * - Saving / rebuilding the inspection report re-syncs element 1's balloon
 *   list (lib/autoballoon-sync.ts), which feeds the Dimensional Report.
 */

const UPLOAD = /^api\/jobs\/upload$/;
const JOB = /^api\/jobs\/([A-Za-z0-9_-]+)(\/.*)?$/;
const ALLOWED = [UPLOAD, JOB, /^api\/drawings\/[^/]+\/versions(\/[^/]+)?$/, /^api\/settings\/instrument-rules$/];
/** Job sub-paths whose success means the report rows changed. */
const REPORT_CHANGES = /^\/(report|report\/rows|report\/rebuild|balloons\/resequence)$/;

type Ctx = { params: Promise<{ id: string; path: string[] }> };

async function handle(req: Request, { params }: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ detail: "Not authenticated" }, { status: 401 });
  const { id: ppapId, path: segments } = await params;

  const ppap = await prisma.ppap.findUnique({ where: { id: ppapId }, select: { id: true, customerId: true, status: true } });
  if (!ppap || (user.can.ownCustomerOnly && user.customerId !== ppap.customerId)) {
    return NextResponse.json({ detail: "Not found" }, { status: 404 });
  }
  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { ppapId_elementNo: { ppapId, elementNo: 1 } },
    select: { id: true, status: true, designRecordDetail: { select: { autoballoonJobId: true } } },
  });

  const path = segments.join("/");
  if (!ALLOWED.some((re) => re.test(path))) return NextResponse.json({ detail: "Not found" }, { status: 404 });

  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating) {
    if (!user.can.editSupplierData) return NextResponse.json({ detail: "Customer logins are read-only here." }, { status: 403 });
    if (element.status === "APPROVED") {
      return NextResponse.json({ detail: "Design Records is approved and locked. Use Revise to edit it." }, { status: 409 });
    }
    if (ppap.status === "CLOSED") return NextResponse.json({ detail: "This PPAP is closed." }, { status: 409 });
  }

  const jobMatch = UPLOAD.test(path) ? null : JOB.exec(path);
  if (jobMatch && jobMatch[1] !== element.designRecordDetail?.autoballoonJobId) {
    return NextResponse.json({ detail: "This drawing job does not belong to this PPAP." }, { status: 404 });
  }

  // Forward the query string, minus any token the original UI may append.
  const url = new URL(req.url);
  url.searchParams.delete("token");
  url.searchParams.delete("access_token");
  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const body = mutating ? await req.arrayBuffer() : undefined;

  let res: Response;
  try {
    res = await autoballoonFetch(`/${path}${url.search}`, { method: req.method, headers, body });
  } catch (err) {
    if (err instanceof AutoballoonUnavailableError) return NextResponse.json({ detail: err.message }, { status: 503 });
    throw err;
  }

  if (res.ok && UPLOAD.test(path)) {
    const json = (await res.json()) as { job_id: string };
    const before = element.designRecordDetail?.autoballoonJobId ?? null;
    await prisma.designRecordDetail.upsert({
      where: { ppapElementId: element.id },
      create: { ppapElementId: element.id, autoballoonJobId: json.job_id },
      update: { autoballoonJobId: json.job_id },
    });
    await prisma.auditLog.create({
      data: {
        ppapId,
        userId: user.id,
        action: "UPDATE",
        entityType: "DesignRecordDetail",
        entityId: element.id,
        before: { autoballoonJobId: before } as never,
        after: { autoballoonJobId: json.job_id } as never,
      },
    });
    return NextResponse.json(json, { status: res.status });
  }

  if (res.ok && mutating && jobMatch && REPORT_CHANGES.test(jobMatch[2] ?? "")) {
    try {
      await syncBalloonsFromAutoballoon({ ppapElementId: element.id, ppapId, jobId: jobMatch[1], userId: user.id });
    } catch (err) {
      // The report itself was saved; a failed balloon sync is retried on the next save.
      console.error("[autoballoon] balloon sync failed:", err);
    }
  }

  const out = new Headers();
  for (const h of ["content-type", "content-disposition", "cache-control", "content-length"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new NextResponse(res.body, { status: res.status, headers: out });
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
