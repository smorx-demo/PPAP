import { prisma } from "@/lib/prisma";
import { getAutoballoonJob } from "@/lib/autoballoon";
import { reportRowsToBalloons } from "@/lib/calc/autoballoon";

/**
 * Replaces element 1's `Balloon` rows with the AutoBalloon job's inspection
 * report, so the Dimensional Report (element 9) keeps generating from them.
 * Balloons are matched by number (updated in place, keeping their ids); ones
 * no longer on the report are deleted after unlinking any Dimensional Report
 * rows that pointed at them (those rows keep their own copied values).
 */
export async function syncBalloonsFromAutoballoon(params: { ppapElementId: string; ppapId: string; jobId: string; userId: string }) {
  const job = await getAutoballoonJob(params.jobId);
  const next = reportRowsToBalloons(job.report_rows ?? [], job.balloons ?? []);
  const before = await prisma.balloon.findMany({ where: { ppapElementId: params.ppapElementId }, orderBy: { balloonNo: "asc" } });
  const byNo = new Map(before.map((b) => [b.balloonNo, b]));
  const keep = new Set(next.map((b) => b.balloonNo));
  const removed = before.filter((b) => !keep.has(b.balloonNo));

  const unchanged = (a: (typeof before)[number], b: (typeof next)[number]) =>
    a.viewSection === b.viewSection && a.description === b.description && a.nominal === b.nominal && a.tolerance === b.tolerance;
  const changed = next.filter((b) => !byNo.has(b.balloonNo) || !unchanged(byNo.get(b.balloonNo)!, b));
  if (changed.length === 0 && removed.length === 0) return { added: 0, updated: 0, removed: 0 };

  await prisma.$transaction([
    prisma.dimensionalReportRow.updateMany({ where: { balloonId: { in: removed.map((b) => b.id) } }, data: { balloonId: null } }),
    prisma.balloon.deleteMany({ where: { id: { in: removed.map((b) => b.id) } } }),
    ...next.map((b) =>
      prisma.balloon.upsert({
        where: { ppapElementId_balloonNo: { ppapElementId: params.ppapElementId, balloonNo: b.balloonNo } },
        create: { ppapElementId: params.ppapElementId, ...b, sortOrder: b.balloonNo },
        update: { ...b, sortOrder: b.balloonNo },
      }),
    ),
  ]);

  const after = await prisma.balloon.findMany({ where: { ppapElementId: params.ppapElementId }, orderBy: { balloonNo: "asc" } });
  await prisma.auditLog.create({
    data: {
      ppapId: params.ppapId,
      userId: params.userId,
      action: "UPDATE",
      entityType: "Balloon",
      entityId: params.ppapElementId,
      before: { source: "autoballoon", jobId: params.jobId, balloons: before } as never,
      after: { source: "autoballoon", jobId: params.jobId, balloons: after } as never,
    },
  });
  const added = next.filter((b) => !byNo.has(b.balloonNo)).length;
  return { added, updated: changed.length - added, removed: removed.length };
}
