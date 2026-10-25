"use client";

import { useRef, useState, useTransition } from "react";
import {
  updateDesignRecordDetail,
  upsertSpecialCharacteristic,
  deleteSpecialCharacteristic,
} from "@/lib/actions/design-record";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { Prisma } from "@/app/generated/prisma/client";

type Detail = Prisma.DesignRecordDetailGetPayload<{
  include: { materialSpec: { select: { id: true; standard: true; grade: true } } };
}> | null;
type MaterialSpec = Prisma.MaterialSpecGetPayload<{ select: { id: true; standard: true; grade: true } }>;
type SpecialCharacteristic = Prisma.SpecialCharacteristicGetPayload<object>;

export function DesignRecordForm({
  ppapElementId,
  locked,
  master,
  detail,
  materialSpecs,
  specialCharacteristics,
}: {
  ppapElementId: string;
  locked: boolean;
  master: {
    partId: string;
    partName: string;
    partNumber: string;
    customerId: string;
    customerName: string;
    partRevisionId: string;
    drawingNumber: string;
    drawingRevision: string;
  };
  detail: Detail;
  materialSpecs: MaterialSpec[];
  specialCharacteristics: SpecialCharacteristic[];
}) {
  return (
    <div className="space-y-8">
      <DetailTable
        ppapElementId={ppapElementId}
        locked={locked}
        master={master}
        detail={detail}
        materialSpecs={materialSpecs}
      />
      <SpecialCharacteristicsTable
        ppapElementId={ppapElementId}
        locked={locked}
        rows={specialCharacteristics}
      />
      {/* Drawing files, the ballooned drawing and the balloon table are now the
          AutoBalloon workspace (design-record-autoballoon.tsx), shown below this
          form; DrawingFilesSection / BallooningSection are no longer rendered. */}
    </div>
  );
}

function Row({
  no,
  particular,
  details,
  remarksName,
  defaultRemarks,
  locked,
}: {
  no: number;
  particular: string;
  details: React.ReactNode;
  remarksName: string;
  defaultRemarks: string | null | undefined;
  locked: boolean;
}) {
  return (
    <TableRow>
      <TableCell className="w-10 text-muted-foreground">{no}</TableCell>
      <TableCell className="w-48 font-medium">{particular}</TableCell>
      <TableCell>{details}</TableCell>
      <TableCell className="w-56">
        <Input
          name={remarksName}
          defaultValue={defaultRemarks ?? ""}
          disabled={locked}
          placeholder="Remarks"
        />
      </TableCell>
    </TableRow>
  );
}

function DetailTable({
  ppapElementId,
  locked,
  master,
  detail,
  materialSpecs,
}: {
  ppapElementId: string;
  locked: boolean;
  master: {
    partId: string;
    partName: string;
    partNumber: string;
    customerId: string;
    customerName: string;
    partRevisionId: string;
    drawingNumber: string;
    drawingRevision: string;
  };
  detail: Detail;
  materialSpecs: MaterialSpec[];
}) {
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      await updateDesignRecordDetail(ppapElementId, formData);
    });
  }

  return (
    <form ref={formRef} action={handleSubmit}>
      <p className="mb-2 text-xs text-muted-foreground">
        Part, customer, and drawing fields below are master data shared across every PPAP for
        this part — editing them here updates the shared record, not just this page.
      </p>
      <input type="hidden" name="partId" value={master.partId} />
      <input type="hidden" name="customerId" value={master.customerId} />
      <input type="hidden" name="partRevisionId" value={master.partRevisionId} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sl.</TableHead>
            <TableHead>Particular</TableHead>
            <TableHead>Details</TableHead>
            <TableHead>Remarks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <Row
            no={1}
            particular="Part Name"
            details={<Input name="partName" defaultValue={master.partName} disabled={locked} required />}
            remarksName="partNameRemarks"
            defaultRemarks={detail?.partNameRemarks}
            locked={locked}
          />
          <Row
            no={2}
            particular="Part Number"
            details={<Input name="partNumber" defaultValue={master.partNumber} disabled={locked} required />}
            remarksName="partNumberRemarks"
            defaultRemarks={detail?.partNumberRemarks}
            locked={locked}
          />
          <Row
            no={3}
            particular="Customer Name"
            details={<Input name="customerName" defaultValue={master.customerName} disabled={locked} required />}
            remarksName="customerNameRemarks"
            defaultRemarks={detail?.customerNameRemarks}
            locked={locked}
          />
          <Row
            no={4}
            particular="Drawing Number"
            details={<Input name="drawingNumber" defaultValue={master.drawingNumber} disabled={locked} required />}
            remarksName="drawingNumberRemarks"
            defaultRemarks={detail?.drawingNumberRemarks}
            locked={locked}
          />
          <Row
            no={5}
            particular="Drawing Revision"
            details={<Input name="drawingRevision" defaultValue={master.drawingRevision} disabled={locked} required />}
            remarksName="drawingRevisionRemarks"
            defaultRemarks={detail?.drawingRevisionRemarks}
            locked={locked}
          />
          <Row
            no={6}
            particular="Material Specification"
            details={
              <select
                name="materialSpecId"
                defaultValue={detail?.materialSpecId ?? ""}
                disabled={locked}
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="">— Select —</option>
                {materialSpecs.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.standard} {m.grade}
                  </option>
                ))}
              </select>
            }
            remarksName="materialSpecRemarks"
            defaultRemarks={detail?.materialSpecRemarks}
            locked={locked}
          />
          <Row
            no={7}
            particular="Heat Treatment"
            details={
              <Input name="heatTreatment" defaultValue={detail?.heatTreatment ?? ""} disabled={locked} />
            }
            remarksName="heatTreatmentRemarks"
            defaultRemarks={detail?.heatTreatmentRemarks}
            locked={locked}
          />
          <Row
            no={8}
            particular="Surface Finish"
            details={
              <Input name="surfaceFinish" defaultValue={detail?.surfaceFinish ?? ""} disabled={locked} />
            }
            remarksName="surfaceFinishRemarks"
            defaultRemarks={detail?.surfaceFinishRemarks}
            locked={locked}
          />
          <Row
            no={9}
            particular="Special Characteristics"
            details={<span className="text-muted-foreground">See table below</span>}
            remarksName="specialCharacteristicsRemarks"
            defaultRemarks={detail?.specialCharacteristicsRemarks}
            locked={locked}
          />
        </TableBody>
      </Table>
      {!locked ? (
        <Button type="submit" size="sm" className="mt-3" disabled={isPending}>
          {isPending ? "Saving..." : "Save"}
        </Button>
      ) : null}
    </form>
  );
}

type SpecialCharDraft = { characteristic: string; charClass: "CRITICAL" | "MAJOR"; symbol: string; drawingRef: string };

const EMPTY_SPECIAL_CHAR: SpecialCharDraft = { characteristic: "", charClass: "CRITICAL", symbol: "", drawingRef: "" };

function SpecialCharacteristicsTable({
  ppapElementId,
  locked,
  rows,
}: {
  ppapElementId: string;
  locked: boolean;
  rows: SpecialCharacteristic[];
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState<SpecialCharDraft>(EMPTY_SPECIAL_CHAR);

  function startAdd() {
    setDraft(EMPTY_SPECIAL_CHAR);
    setEditingId(null);
    setAdding(true);
  }

  function startEdit(row: SpecialCharacteristic) {
    setDraft({
      characteristic: row.characteristic,
      charClass: row.charClass,
      symbol: row.symbol ?? "",
      drawingRef: row.drawingRef ?? "",
    });
    setAdding(false);
    setEditingId(row.id);
  }

  function cancel() {
    setAdding(false);
    setEditingId(null);
  }

  function save() {
    startTransition(async () => {
      await upsertSpecialCharacteristic(ppapElementId, { id: editingId ?? undefined, ...draft });
      setAdding(false);
      setEditingId(null);
      setDraft(EMPTY_SPECIAL_CHAR);
    });
  }

  const editorOpen = adding || editingId !== null;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Special Characteristics</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Characteristic</TableHead>
            <TableHead>Class</TableHead>
            <TableHead>Symbol</TableHead>
            <TableHead>Drawing Ref</TableHead>
            {!locked ? <TableHead className="w-32">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.characteristic}</TableCell>
              <TableCell>
                <Badge variant={row.charClass === "CRITICAL" ? "destructive" : "secondary"}>
                  {row.charClass}
                </Badge>
              </TableCell>
              <TableCell>{row.symbol ?? "—"}</TableCell>
              <TableCell>{row.drawingRef ?? "—"}</TableCell>
              {!locked ? (
                <TableCell className="flex gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => startEdit(row)}>
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPending}
                    onClick={() =>
                      startTransition(async () => {
                        await deleteSpecialCharacteristic(ppapElementId, row.id);
                      })
                    }
                  >
                    Delete
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No special characteristics yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      {!locked ? (
        editorOpen ? (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="sc-characteristic">Characteristic</Label>
              <Input
                id="sc-characteristic"
                value={draft.characteristic}
                onChange={(e) => setDraft((d) => ({ ...d, characteristic: e.target.value }))}
                className="w-48"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-class">Class</Label>
              <select
                id="sc-class"
                value={draft.charClass}
                onChange={(e) => setDraft((d) => ({ ...d, charClass: e.target.value as "CRITICAL" | "MAJOR" }))}
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="CRITICAL">CRITICAL</option>
                <option value="MAJOR">MAJOR</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-symbol">Symbol</Label>
              <Input
                id="sc-symbol"
                value={draft.symbol}
                onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value }))}
                className="w-24"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-drawing-ref">Drawing Ref</Label>
              <Input
                id="sc-drawing-ref"
                value={draft.drawingRef}
                onChange={(e) => setDraft((d) => ({ ...d, drawingRef: e.target.value }))}
                className="w-32"
              />
            </div>
            <Button type="button" size="sm" disabled={!draft.characteristic || isPending} onClick={save}>
              {editingId ? "Save" : "Add"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" className="mt-3" onClick={startAdd}>
            Add row
          </Button>
        )
      ) : null}
    </section>
  );
}
