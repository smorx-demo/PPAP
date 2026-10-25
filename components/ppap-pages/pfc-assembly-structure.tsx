"use client";

import { Fragment, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createStage,
  deleteStage,
  moveStage,
  createSubAssembly,
  deleteSubAssembly,
  setSubAssemblyInMainAssembly,
  assignChildPartToSubAssembly,
  createChildPart,
  updateChildPart,
  addStructureStep,
  moveRouteStep,
  removeRouteStep,
  type StructureStepTarget,
} from "@/lib/actions/pfc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  PfcAssemblyTree,
  SubAssemblyPartsTooltip,
  childPartDetail,
  childPartLabel,
  stageLabel,
  subAssemblyLabel,
  type TreeChildPart,
  type TreeStage,
  type TreeStep,
  type TreeSubAssembly,
} from "@/components/ppap-pages/pfc-assembly-tree";

type UnassignedPart = { id: string; itemNo: number; partNo: string; description: string };
type Run = (fn: () => Promise<unknown>) => void;
type Operation = { id: string; name: string };

/**
 * A run of process steps (Raw material → Inspection → Kitting…) with a
 * "+ Add step" dropdown of the Operation master. Used before the stages,
 * on each sub-assembly and on each child part (its BOM route).
 */
function StepChain({
  ppapElementId,
  target,
  steps,
  operations,
  locked,
  run,
  isPending,
  label,
}: {
  ppapElementId: string;
  target: StructureStepTarget;
  steps: TreeStep[];
  operations: Operation[];
  locked: boolean;
  run: Run;
  isPending: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {steps.map((step, i) => (
        <Fragment key={step.id}>
          {i > 0 ? (
            <span aria-hidden className="text-xs text-muted-foreground">
              →
            </span>
          ) : null}
          <span className="inline-flex items-center gap-0.5 rounded-full border bg-background px-2 py-0.5 text-xs">
            {step.name}
            {!locked ? (
              <>
                <button
                  type="button"
                  aria-label={`Move ${step.name} earlier`}
                  className="px-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={isPending || i === 0}
                  onClick={() => run(() => moveRouteStep(ppapElementId, step.id, "up"))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label={`Move ${step.name} later`}
                  className="px-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={isPending || i === steps.length - 1}
                  onClick={() => run(() => moveRouteStep(ppapElementId, step.id, "down"))}
                >
                  ›
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${step.name}`}
                  className="px-0.5 text-muted-foreground hover:text-destructive"
                  disabled={isPending}
                  onClick={() => run(() => removeRouteStep(ppapElementId, step.id))}
                >
                  ×
                </button>
              </>
            ) : null}
          </span>
        </Fragment>
      ))}
      {!locked ? (
        <select
          aria-label={`Add a process step to ${label}`}
          value=""
          disabled={isPending}
          onChange={(e) => {
            const operationId = e.target.value;
            if (operationId) run(() => addStructureStep(ppapElementId, target, operationId));
          }}
          className="h-7 rounded-full border border-dashed bg-transparent px-2 text-xs text-primary"
        >
          <option value="">+ Add step</option>
          {operations.map((op) => (
            <option key={op.id} value={op.id}>
              {op.name}
            </option>
          ))}
        </select>
      ) : steps.length === 0 ? (
        <span className="text-xs text-muted-foreground">No steps.</span>
      ) : null}
    </div>
  );
}

/** Runs a server action in a transition, refreshing on success and surfacing the thrown message on failure. */
function useRunner() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run: Run = (fn) =>
    startTransition(async () => {
      setError(null);
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  return { run, isPending, error };
}

/** Optional BOM details for an auto-numbered child part (used by the BOM grid, flow chart, PFMEA and Control Plan). */
function ChildPartDetailsForm({
  ppapElementId,
  part,
  run,
  isPending,
  onDone,
}: {
  ppapElementId: string;
  part: TreeChildPart;
  run: Run;
  isPending: boolean;
  onDone: () => void;
}) {
  const [partNo, setPartNo] = useState(part.partNo);
  const [description, setDescription] = useState(part.description);
  const [qty, setQty] = useState(String(part.qtyPerAssembly));
  const [side, setSide] = useState<"LEFT" | "RIGHT">(part.side);
  const [type, setType] = useState<"MAKE" | "BOP">(part.type);
  const prefix = `pfc-cp-${part.id}`;

  return (
    <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-2 sm:grid-cols-6">
      <p className="col-span-2 text-xs font-semibold sm:col-span-6">{childPartLabel(part)} — details (optional)</p>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-partno`} className="text-xs">Part No.</Label>
        <Input id={`${prefix}-partno`} value={partNo} onChange={(e) => setPartNo(e.target.value)} className="h-8 text-xs" />
      </div>
      <div className="col-span-2 space-y-1">
        <Label htmlFor={`${prefix}-desc`} className="text-xs">Description</Label>
        <Input id={`${prefix}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 text-xs" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-qty`} className="text-xs">Qty</Label>
        <Input id={`${prefix}-qty`} type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} className="h-8 text-xs" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-side`} className="text-xs">Side</Label>
        <select id={`${prefix}-side`} value={side} onChange={(e) => setSide(e.target.value as "LEFT" | "RIGHT")} className="h-8 w-full rounded-md border bg-transparent px-1 text-xs">
          <option value="LEFT">Left</option>
          <option value="RIGHT">Right</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-type`} className="text-xs">Type</Label>
        <select id={`${prefix}-type`} value={type} onChange={(e) => setType(e.target.value as "MAKE" | "BOP")} className="h-8 w-full rounded-md border bg-transparent px-1 text-xs">
          <option value="MAKE">Make</option>
          <option value="BOP">BOP</option>
        </select>
      </div>
      <div className="col-span-2 flex items-end gap-2 sm:col-span-6">
        <Button
          type="button"
          size="sm"
          disabled={isPending}
          onClick={() =>
            run(async () => {
              await updateChildPart(part.id, ppapElementId, {
                partNo,
                description,
                qtyPerAssembly: qty,
                side,
                type,
                parentChildPartId: part.parentChildPartId ?? undefined,
              });
              onDone();
            })
          }
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SubAssemblyCard({
  ppapElementId,
  sub,
  unassigned,
  operations,
  locked,
  run,
  isPending,
}: {
  ppapElementId: string;
  sub: TreeSubAssembly;
  unassigned: UnassignedPart[];
  operations: Operation[];
  locked: boolean;
  run: Run;
  isPending: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = sub.childParts.find((cp) => cp.id === editingId);

  return (
    <div className="space-y-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold">{subAssemblyLabel(sub)}</span>
          {sub.partNo || sub.description ? (
            <span className="text-muted-foreground"> · {[sub.partNo, sub.description].filter(Boolean).join(" — ")}</span>
          ) : null}
          {sub.inMainAssembly ? <Badge variant="secondary" className="ml-2">In main assembly</Badge> : null}
        </div>
        {!locked ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isPending}
            onClick={() => {
              if (confirm(`Delete ${subAssemblyLabel(sub)}? Its child parts stay in the BOM, unassigned.`)) {
                run(() => deleteSubAssembly(ppapElementId, sub.id));
              }
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>

      <StepChain
        ppapElementId={ppapElementId}
        target={{ kind: "SUB_ASSEMBLY", subAssemblyId: sub.id }}
        steps={sub.steps}
        operations={operations}
        locked={locked}
        run={run}
        isPending={isPending}
        label={subAssemblyLabel(sub)}
      />

      <div className="space-y-1.5">
        {sub.childParts.map((cp) => (
          <div key={cp.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/30 px-2 py-1 text-xs">
            <span className="font-medium">{childPartLabel(cp)}</span>
            {childPartDetail(cp) ? <span className="text-muted-foreground">· {childPartDetail(cp)}</span> : null}
            <StepChain
              ppapElementId={ppapElementId}
              target={{ kind: "CHILD_PART", childPartId: cp.id }}
              steps={cp.steps}
              operations={operations}
              locked={locked}
              run={run}
              isPending={isPending}
              label={childPartLabel(cp)}
            />
            <span className="ml-auto" />
            {!locked ? (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                disabled={isPending}
                onClick={() => setEditingId(editingId === cp.id ? null : cp.id)}
              >
                Edit
              </button>
            ) : null}
            {!locked ? (
              <button
                type="button"
                aria-label={`Remove ${childPartLabel(cp)} from ${subAssemblyLabel(sub)}`}
                className="text-muted-foreground hover:text-foreground"
                disabled={isPending}
                onClick={() => run(() => assignChildPartToSubAssembly(ppapElementId, cp.id, null))}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {sub.childParts.length === 0 ? <span className="text-xs text-muted-foreground">No child parts yet.</span> : null}
      </div>

      {!locked ? (
        editing ? (
          <ChildPartDetailsForm key={editing.id} ppapElementId={ppapElementId} part={editing} run={run} isPending={isPending} onDone={() => setEditingId(null)} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() =>
                run(() =>
                  createChildPart(ppapElementId, { partNo: "", description: "", qtyPerAssembly: 1, side: "LEFT", type: "MAKE", subAssemblyId: sub.id }),
                )
              }
            >
              Add child part {sub.no}.{sub.childParts.length + 1}
            </Button>
            {unassigned.length > 0 ? (
              <select
                aria-label={`Add an existing BOM part to ${subAssemblyLabel(sub)}`}
                value=""
                disabled={isPending}
                onChange={(e) => {
                  const childPartId = e.target.value;
                  if (childPartId) run(() => assignChildPartToSubAssembly(ppapElementId, childPartId, sub.id));
                }}
                className="h-8 max-w-72 rounded-md border bg-transparent px-2 text-xs"
              >
                <option value="">— Add existing BOM part —</option>
                {unassigned.map((cp) => (
                  <option key={cp.id} value={cp.id}>
                    {cp.itemNo}. {cp.partNo} — {cp.description}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function StageCard({
  ppapElementId,
  stage,
  index,
  stageCount,
  unassigned,
  operations,
  locked,
  run,
  isPending,
}: {
  ppapElementId: string;
  stage: TreeStage;
  index: number;
  stageCount: number;
  unassigned: UnassignedPart[];
  operations: Operation[];
  locked: boolean;
  run: Run;
  isPending: boolean;
}) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">{stageLabel(stage)}</h4>
        <span className="text-xs text-muted-foreground">
          {stage.subAssemblies.length} sub-assembl{stage.subAssemblies.length === 1 ? "y" : "ies"}
        </span>
        {!locked ? (
          <div className="ml-auto flex gap-1">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move stage up" disabled={isPending || index === 0} onClick={() => run(() => moveStage(ppapElementId, stage.id, "up"))}>
              ↑
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Move stage down" disabled={isPending || index === stageCount - 1} onClick={() => run(() => moveStage(ppapElementId, stage.id, "down"))}>
              ↓
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => {
                if (confirm(`Delete ${stageLabel(stage)} and its sub-assemblies? Their child parts stay in the BOM, unassigned.`)) {
                  run(() => deleteStage(ppapElementId, stage.id));
                }
              }}
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        {stage.subAssemblies.map((sub) => (
          <SubAssemblyCard
            key={sub.id}
            ppapElementId={ppapElementId}
            sub={sub}
            unassigned={unassigned}
            operations={operations}
            locked={locked} run={run} isPending={isPending} />
        ))}
      </div>

      {!locked ? (
        <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => run(() => createSubAssembly(ppapElementId, stage.id))}>
          Add sub-assembly {stage.no}.{stage.subAssemblies.length + 1}
        </Button>
      ) : null}
    </div>
  );
}

/** Ticks immediately (optimistic) — the server round trip and refresh can take a few seconds. */
function MainAssemblyCheckbox({ ppapElementId, sub, locked, run }: { ppapElementId: string; sub: TreeSubAssembly; locked: boolean; run: Run }) {
  const [checked, setChecked] = useOptimistic(sub.inMainAssembly);
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/50",
        checked && "border-primary/40 bg-primary/5",
        locked && "cursor-default",
      )}
    >
      <input
        type="checkbox"
        aria-label={`Use ${subAssemblyLabel(sub)} in the main assembly`}
        checked={checked}
        disabled={locked}
        onChange={(e) => {
          const next = e.target.checked;
          run(async () => {
            setChecked(next);
            await setSubAssemblyInMainAssembly(ppapElementId, sub.id, next);
          });
        }}
      />
      <SubAssemblyPartsTooltip sub={sub}>
        <span className="underline decoration-dotted underline-offset-2">
          {subAssemblyLabel(sub)}
        </span>
      </SubAssemblyPartsTooltip>
      <span className="text-xs text-muted-foreground">({sub.childParts.length})</span>
    </label>
  );
}

function MainAssemblySelector({
  ppapElementId,
  mainAssembly,
  stages,
  locked,
  run,
  isPending,
}: {
  ppapElementId: string;
  mainAssembly: { partNo: string; name: string };
  stages: TreeStage[];
  locked: boolean;
  run: Run;
  isPending: boolean;
}) {
  const allSubs = stages.flatMap((s) => s.subAssemblies);
  const selected = allSubs.filter((s) => s.inMainAssembly).length;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="text-sm font-semibold">
          Main assembly — {mainAssembly.partNo} {mainAssembly.name}
        </h4>
        {!locked && allSubs.length > 1 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => {
              const next = selected < allSubs.length;
              run(async () => {
                for (const sub of allSubs.filter((s) => s.inMainAssembly !== next)) {
                  await setSubAssemblyInMainAssembly(ppapElementId, sub.id, next);
                }
              });
            }}
          >
            {selected < allSubs.length ? "Select all" : "Clear all"}
          </Button>
        ) : null}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">
          Tick the sub-assemblies used in the main assembly ({selected} of {allSubs.length} selected). Hover a sub-assembly to see its child parts.
        </p>
      </div>
      {allSubs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Add sub-assemblies to a stage first.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {stages
            .filter((s) => s.subAssemblies.length > 0)
            .map((stage) => (
              <fieldset key={stage.id} className="space-y-1.5">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">{stageLabel(stage)}</legend>
                {stage.subAssemblies.map((sub) => (
                  <MainAssemblyCheckbox key={sub.id} ppapElementId={ppapElementId} sub={sub} locked={locked} run={run} />
                ))}
              </fieldset>
            ))}
        </div>
      )}
    </div>
  );
}

export function PfcAssemblyStructure({
  ppapElementId,
  locked,
  mainAssembly,
  stages,
  preStageSteps,
  operations,
  unassigned,
}: {
  ppapElementId: string;
  locked: boolean;
  mainAssembly: { partNo: string; name: string };
  stages: TreeStage[];
  preStageSteps: TreeStep[];
  operations: Operation[];
  unassigned: UnassignedPart[];
}) {
  const { run, isPending, error } = useRunner();

  return (
    <div className="space-y-4">
      {error ? <p className="rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="space-y-3">
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <h4 className="text-sm font-semibold">Before the stages</h4>
          <StepChain
            ppapElementId={ppapElementId}
            target={{ kind: "PRE_STAGE" }}
            steps={preStageSteps}
            operations={operations}
            locked={locked}
            run={run}
            isPending={isPending}
            label="the steps before the stages"
          />
        </div>
        {stages.map((stage, i) => (
          <StageCard
            key={stage.id}
            ppapElementId={ppapElementId}
            stage={stage}
            index={i}
            stageCount={stages.length}
            unassigned={unassigned}
            operations={operations}
            locked={locked}
            run={run}
            isPending={isPending}
          />
        ))}
        {!locked ? (
          <Button type="button" size="sm" disabled={isPending} onClick={() => run(() => createStage(ppapElementId))}>
            Add stage {stages.length + 1}
          </Button>
        ) : null}
        {unassigned.length > 0 && stages.length > 0 ? (
          <p className="text-xs text-muted-foreground">{unassigned.length} BOM part(s) are not yet in any sub-assembly.</p>
        ) : null}
      </div>

      <MainAssemblySelector ppapElementId={ppapElementId} mainAssembly={mainAssembly} stages={stages} locked={locked} run={run} isPending={isPending} />

      <div>
        <h4 className="mb-2 text-sm font-semibold">Assembly Tree</h4>
        <PfcAssemblyTree mainAssembly={mainAssembly} stages={stages} preStageSteps={preStageSteps} />
      </div>
    </div>
  );
}
