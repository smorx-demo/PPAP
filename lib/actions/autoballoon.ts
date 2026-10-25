"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { assertSupplierUser } from "@/lib/permissions";
import { assertPpapOpen } from "@/lib/psw-lifecycle";
import { syncBalloonsFromAutoballoon } from "@/lib/autoballoon-sync";

/// "Update balloon list" on Design Records: re-copies the inspection report's
/// balloons into element 1's Balloon rows (also done automatically whenever
/// the report is saved or rebuilt through the proxy).
export async function syncDesignRecordBalloons(ppapElementId: string) {
  const user = await assertSupplierUser();
  const element = await prisma.ppapElement.findUniqueOrThrow({
    where: { id: ppapElementId },
    select: { id: true, ppapId: true, elementNo: true, status: true, designRecordDetail: { select: { autoballoonJobId: true } } },
  });
  if (element.elementNo !== 1) throw new Error("Not a Design Records page.");
  if (element.status === "APPROVED") throw new Error("This page is approved and locked. Use Revise to edit it.");
  await assertPpapOpen(element.ppapId);
  const jobId = element.designRecordDetail?.autoballoonJobId;
  if (!jobId) throw new Error("Upload a drawing first.");

  const result = await syncBalloonsFromAutoballoon({ ppapElementId, ppapId: element.ppapId, jobId, userId: user.id });
  revalidatePath(`/ppap/${element.ppapId}/1`);
  revalidatePath(`/ppap/${element.ppapId}/9`);
  return result;
}
