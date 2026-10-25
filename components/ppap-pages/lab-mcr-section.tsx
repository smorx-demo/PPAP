"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deleteLabDocument,
  moveLabDocument,
  readLabDocument,
  rebuildMcrGroups,
  saveMcrGroups,
  saveMcrHeader,
  updateLabDocument,
  uploadLabDocuments,
} from "@/lib/actions/mcr";
import type { McrGroup, McrTest } from "@/lib/calc/mcr";
import type { McrHeaderField } from "@/lib/data/mcr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { submitFormData } from "@/lib/form";

type LabDocumentRow = {
  id: string;
  fileUrl: string;
  fileName: string;
  extractionStatus: string;
  extractionError: string | null;
  labName: string | null;
  materialSpec: string | null;
  heatNo: string | null;
  plateNo: string | null;
  sizeText: string | null;
  tests: McrTest[];
};

const HEADER_LABELS: Record<McrHeaderField, string> = {
  issueNumber: "Issue Number",
  qty: "QTY",
  projectName: "Project Name",
  poNumber: "PO Number",
  serialNumbers: "Serial Numbers",
  location: "Location",
  mcrNumber: "MCR Number",
  supplierName: "Supplier Name",
  mcrDate: "Date (DD/MM/YYYY)",
};

/** Tests as editable text, one per line: "C | TRH/24-25/7122-8 | 19-11-2024". */
const testsToText = (tests: McrTest[]) => tests.map((t) => [t.type, t.reportNo, t.date].join(" | ")).join("\n");
const textToTests = (text: string): McrTest[] =>
  text
    .split("\n")
    .map((line) => line.split("|").map((p) => p.trim()))
    .filter((p) => p.some(Boolean))
    .map(([type = "", reportNo = "", date = ""]) => ({ type, reportNo, date }));

function useRunner() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      setError(null);
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  return { run, isPending, error, setError };
}

function StatusBadge({ doc }: { doc: LabDocumentRow }) {
  if (doc.extractionStatus === "READ") return <Badge variant="secondary">Read</Badge>;
  if (doc.extractionStatus === "FAILED") return <Badge variant="destructive">Not read</Badge>;
  return <Badge variant="outline">Waiting</Badge>;
}

function DocumentRow({ doc, index, count, locked, run, isPending }: { doc: LabDocumentRow; index: number; count: number; locked: boolean; run: (fn: () => Promise<unknown>) => void; isPending: boolean }) {
  const [editing, setEditing] = useState(false);
  const fields = (fd: FormData) => ({
    labName: String(fd.get("labName") ?? ""),
    materialSpec: String(fd.get("materialSpec") ?? ""),
    heatNo: String(fd.get("heatNo") ?? ""),
    plateNo: String(fd.get("plateNo") ?? ""),
    sizeText: String(fd.get("sizeText") ?? ""),
    tests: textToTests(String(fd.get("tests") ?? "")),
  });
  const p = `doc-${doc.id}`;

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-6 text-muted-foreground tabular-nums">{index + 1}.</span>
        <a href={doc.fileUrl} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
          {doc.fileName}
        </a>
        <StatusBadge doc={doc} />
        {!locked ? (
          <div className="ml-auto flex flex-wrap gap-1">
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Print earlier" disabled={isPending || index === 0} onClick={() => run(() => moveLabDocument(doc.id, "up"))}>
              ↑
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Print later" disabled={isPending || index === count - 1} onClick={() => run(() => moveLabDocument(doc.id, "down"))}>
              ↓
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={() => setEditing(!editing)}>
              {editing ? "Cancel" : "Edit"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => readLabDocument(doc.id))}>
              Re-read
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isPending}
              onClick={() => {
                if (confirm(`Remove ${doc.fileName}?`)) run(() => deleteLabDocument(doc.id));
              }}
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      {doc.extractionError ? <p className="text-xs text-destructive">{doc.extractionError}</p> : null}

      {editing ? (
        <form
          className="grid gap-2 sm:grid-cols-5"
          onSubmit={submitFormData((fd) =>
            run(async () => {
              await updateLabDocument(doc.id, fields(fd));
              setEditing(false);
            }),
          )}
        >
          {(
            [
              ["labName", "Lab", doc.labName],
              ["materialSpec", "Material spec", doc.materialSpec],
              ["heatNo", "Heat no.", doc.heatNo],
              ["plateNo", "Plate no.", doc.plateNo],
              ["sizeText", "Size", doc.sizeText],
            ] as const
          ).map(([name, label, value]) => (
            <div key={name} className="space-y-1">
              <Label htmlFor={`${p}-${name}`} className="text-xs">
                {label}
              </Label>
              <Input id={`${p}-${name}`} name={name} defaultValue={value ?? ""} className="h-8 text-xs" />
            </div>
          ))}
          <div className="space-y-1 sm:col-span-5">
            <Label htmlFor={`${p}-tests`} className="text-xs">
              Test reports — one per line: type | report no. | date (types: C chemical, M mechanical, I impact, H hardness, UT ultrasonic)
            </Label>
            <Textarea id={`${p}-tests`} name="tests" defaultValue={testsToText(doc.tests)} rows={Math.max(2, doc.tests.length + 1)} className="font-mono text-xs" />
          </div>
          <div className="sm:col-span-5">
            <Button type="submit" size="sm" disabled={isPending}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[repeat(5,minmax(0,1fr))]">
          <span>
            <span className="text-muted-foreground">Lab:</span> {doc.labName || "—"}
          </span>
          <span>
            <span className="text-muted-foreground">Spec:</span> {doc.materialSpec || "—"}
          </span>
          <span>
            <span className="text-muted-foreground">Heat:</span> {doc.heatNo || "—"}
          </span>
          <span>
            <span className="text-muted-foreground">Plate:</span> {doc.plateNo || "—"}
          </span>
          <span>
            <span className="text-muted-foreground">Size:</span> {doc.sizeText || "—"}
          </span>
          <span className="sm:col-span-5">
            <span className="text-muted-foreground">Tests:</span>{" "}
            {doc.tests.length ? doc.tests.map((t) => `${t.type}-${t.reportNo} ${t.date}`.trim()).join(" · ") : "—"}
          </span>
        </div>
      )}
    </div>
  );
}

const GROUP_FIELDS: { key: Exclude<keyof McrGroup, "key" | "itemCodes">; label: string; rows: number }[] = [
  { key: "itemDescription", label: "Item Description", rows: 1 },
  { key: "size", label: "Size/ Qty (Nos)", rows: 2 },
  { key: "materialSpec", label: "Material Spec", rows: 2 },
  { key: "materialIdNo", label: "Material Identification No.", rows: 2 },
  { key: "heatPlateNo", label: "Heat No./ Plate No.", rows: 2 },
  { key: "testCertificate", label: "Test Certificate No & Date", rows: 2 },
  { key: "nablReports", label: "NABL Reports No. (one per line)", rows: 4 },
];

function GroupsEditor({ ppapElementId, initial, locked, run, isPending }: { ppapElementId: string; initial: McrGroup[]; locked: boolean; run: (fn: () => Promise<unknown>) => void; isPending: boolean }) {
  const [groups, setGroups] = useState(initial);
  const [dirty, setDirty] = useState(false);
  // Take the server's groups after a save / rebuild, unless there are unsaved edits.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial && !dirty) {
    setPrevInitial(initial);
    setGroups(initial);
  }
  const edit = (i: number, patch: Partial<McrGroup>) => {
    setGroups((gs) => gs.map((g, n) => (n === i ? { ...g, ...patch } : g)));
    setDirty(true);
  };
  const move = (i: number, d: -1 | 1) => {
    setGroups((gs) => {
      const next = [...gs];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
    setDirty(true);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!locked ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending || dirty}
              title={dirty ? "Save your group edits first" : undefined}
              onClick={() => run(() => rebuildMcrGroups(ppapElementId))}
            >
              Build groups from lab reports
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => {
                setGroups((gs) => [
                  ...gs,
                  { key: `manual:${crypto.randomUUID()}`, itemCodes: [], itemDescription: "", size: "", materialSpec: "", materialIdNo: "", heatPlateNo: "", testCertificate: "", nablReports: "" },
                ]);
                setDirty(true);
              }}
            >
              Add group
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !dirty}
              onClick={() =>
                run(async () => {
                  await saveMcrGroups(ppapElementId, groups);
                  setDirty(false);
                })
              }
            >
              Save groups
            </Button>
            {dirty ? <span className="text-xs text-amber-700 dark:text-amber-400">Unsaved changes</span> : null}
          </>
        ) : null}
        <span className="text-xs text-muted-foreground">
          Lab reports with the same heat / plate no. and material spec become one Sr.No. Building again keeps what you typed and only adds.
        </span>
      </div>

      {groups.length === 0 ? <p className="text-sm text-muted-foreground">No material groups yet — upload lab reports, then build the groups.</p> : null}

      {groups.map((g, i) => (
        <div key={g.key} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Sr.No. {i + 1}</span>
            {!locked ? (
              <div className="ml-auto flex gap-1">
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === groups.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setGroups((gs) => gs.filter((_, n) => n !== i));
                    setDirty(true);
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : null}
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <div className="space-y-1 md:row-span-2">
              <Label htmlFor={`${g.key}-codes`} className="text-xs">
                Item Codes (one per line)
              </Label>
              <Textarea
                id={`${g.key}-codes`}
                value={g.itemCodes.join("\n")}
                disabled={locked}
                rows={Math.max(4, g.itemCodes.length + 1)}
                onChange={(e) => edit(i, { itemCodes: e.target.value.split("\n") })}
                className="font-mono text-xs"
              />
            </div>
            {GROUP_FIELDS.map((f) => (
              <div key={f.key} className={`space-y-1 ${f.key === "nablReports" ? "md:col-span-3" : ""}`}>
                <Label htmlFor={`${g.key}-${f.key}`} className="text-xs">
                  {f.label}
                </Label>
                <Textarea id={`${g.key}-${f.key}`} value={g[f.key]} disabled={locked} rows={f.rows} onChange={(e) => edit(i, { [f.key]: e.target.value })} className="min-h-0 text-xs" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Element 12: upload lab report files, review what was read from them, fill
 * the Material Clearance Record header and material groups, and print the MCR
 * cover page followed by every uploaded report as one PDF.
 */
export function LabMcrSection({
  ppapId,
  ppapElementId,
  locked,
  documents,
  header,
  groups,
}: {
  ppapId: string;
  ppapElementId: string;
  locked: boolean;
  documents: LabDocumentRow[];
  header: { partNumber: string; partName: string; values: Record<McrHeaderField, string> };
  groups: McrGroup[];
}) {
  const { run, isPending, error } = useRunner();
  const [progress, setProgress] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = () => {
    const files = fileRef.current?.files;
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("files", f);
    run(async () => {
      setProgress([`Uploading ${files.length} file(s)…`]);
      const ids = await uploadLabDocuments(ppapElementId, fd);
      if (fileRef.current) fileRef.current.value = "";
      const log: string[] = [];
      for (const [n, id] of ids.entries()) {
        setProgress([...log, `Reading ${n + 1} of ${ids.length}…`]);
        const r = await readLabDocument(id);
        log.push(r.message);
      }
      setProgress(log);
    });
  };

  return (
    <div className="space-y-6">
      {error ? <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">1. Upload lab reports</h3>
        {!locked ? (
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" multiple accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" aria-label="Report files to upload" className="text-sm" />
            <Button type="button" size="sm" disabled={isPending} onClick={upload}>
              Upload &amp; read
            </Button>
            <span className="text-xs text-muted-foreground">PDF, PNG or JPG — several at once. Each file is read automatically; check what was read below.</span>
          </div>
        ) : null}
        {progress.length ? (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {progress.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">2. Check what was read (print order)</h3>
        {documents.length === 0 ? <p className="text-sm text-muted-foreground">No lab reports uploaded yet.</p> : null}
        {documents.map((doc, i) => (
          <DocumentRow key={doc.id} doc={doc} index={i} count={documents.length} locked={locked} run={run} isPending={isPending} />
        ))}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">3. MCR header</h3>
        <p className="text-xs text-muted-foreground">
          Part Number <span className="font-medium text-foreground">{header.partNumber}</span> · Part Name{" "}
          <span className="font-medium text-foreground">{header.partName}</span> (from the part master). PO Number, Project Name and Supplier Name start from the PSW and RM
          Test Report — change them here if the MCR needs something else.
        </p>
        <form className="grid gap-2 sm:grid-cols-3" onSubmit={submitFormData((fd) => run(() => saveMcrHeader(ppapElementId, Object.fromEntries(Object.keys(HEADER_LABELS).map((k) => [k, String(fd.get(k) ?? "")])) as Record<McrHeaderField, string>)))}>
          {(Object.keys(HEADER_LABELS) as McrHeaderField[]).map((k) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={`mcr-${k}`} className="text-xs">
                {HEADER_LABELS[k]}
              </Label>
              <Input id={`mcr-${k}`} name={k} defaultValue={header.values[k]} disabled={locked} className="h-8 text-sm" />
            </div>
          ))}
          {!locked ? (
            <div className="sm:col-span-3">
              <Button type="submit" size="sm" disabled={isPending}>
                Save header
              </Button>
            </div>
          ) : null}
        </form>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">4. Material groups (Sr.No. rows)</h3>
        <GroupsEditor ppapElementId={ppapElementId} initial={groups} locked={locked} run={run} isPending={isPending} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">5. Print</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button render={<a href={`/api/ppap/${ppapId}/12/mcr`} target="_blank" rel="noreferrer" />} nativeButton={false} size="sm">
            Print MCR + lab reports
          </Button>
          <Button render={<a href={`/api/ppap/${ppapId}/12/mcr?download=1`} />} nativeButton={false} size="sm" variant="outline">
            Download PDF
          </Button>
          {documents.length === 0 ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">No lab reports uploaded — the print will have the MCR cover page only.</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              MCR cover page(s), then {documents.length} lab report file{documents.length === 1 ? "" : "s"} in the order above.
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
