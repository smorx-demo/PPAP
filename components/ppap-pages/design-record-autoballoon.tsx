"use client";

import "@/components/autoballoon/autoballoon.css";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setApiBase } from "@/components/autoballoon/api";
import { syncDesignRecordBalloons } from "@/lib/actions/autoballoon";
import { Button } from "@/components/ui/button";

// The ported inspection UI touches window / localStorage while rendering.
const InspectionPage = dynamic(() => import("@/components/autoballoon/inspection-page"), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted-foreground">Loading the drawing workspace…</p>,
});

/**
 * Drawing upload → auto ballooning → inspection report → downloads, using the
 * AutoBalloon software (components/autoballoon, served by autoballoon-service
 * through /api/ppap/[id]/autoballoon). The report's balloons are copied into
 * this element's balloon list, which the Dimensional Report (element 9) uses.
 */
export function DesignRecordAutoballoon({
  ppapId,
  ppapElementId,
  jobId,
  balloonCount,
  editable,
}: {
  ppapId: string;
  ppapElementId: string;
  jobId: string | null;
  balloonCount: number;
  editable: boolean;
}) {
  setApiBase(`/api/ppap/${ppapId}/autoballoon`);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const sync = () =>
    startTransition(async () => {
      setMessage(null);
      try {
        const r = await syncDesignRecordBalloons(ppapElementId);
        setMessage(`Balloon list updated: ${r.added} added, ${r.updated} changed, ${r.removed} removed.`);
        router.refresh();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : "Could not update the balloon list.");
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">
          {balloonCount} balloon{balloonCount === 1 ? "" : "s"} in the PPAP balloon list (used by the{" "}
          <Link href={`/ppap/${ppapId}/9`} className="text-primary underline-offset-2 hover:underline">
            Dimensional Report
          </Link>
          ) — updated automatically whenever the inspection report is refreshed or saved.
        </span>
        {editable && jobId ? (
          <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={sync}>
            Update balloon list now
          </Button>
        ) : null}
        {message ? <span className="text-muted-foreground">{message}</span> : null}
      </div>
      {!editable ? (
        <p className="rounded bg-muted px-3 py-2 text-sm text-muted-foreground">
          View only — this page is approved, the PPAP is closed, or your login is read-only. Uploads and edits will be refused.
        </p>
      ) : null}
      <div className="ab-root overflow-hidden rounded-lg border">
        <InspectionPage initialJobId={jobId} inlineReport />
      </div>
    </div>
  );
}
