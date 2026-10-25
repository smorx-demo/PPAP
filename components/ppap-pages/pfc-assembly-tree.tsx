"use client";

import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** One process step (an Operation) on a route, e.g. "Tack welding". */
export type TreeStep = { id: string; name: string; symbol: string };

export type TreeChildPart = {
  id: string;
  /** Hierarchical number, e.g. "1.1.2" (lib/calc/pfc-numbering.ts). */
  no: string;
  itemNo: number;
  partNo: string;
  description: string;
  qtyPerAssembly: number;
  side: "LEFT" | "RIGHT";
  type: "MAKE" | "BOP";
  parentChildPartId: string | null;
  steps: TreeStep[];
};
export type TreeSubAssembly = {
  id: string;
  /** e.g. "1.2" */
  no: string;
  partNo: string;
  description: string;
  inMainAssembly: boolean;
  steps: TreeStep[];
  childParts: TreeChildPart[];
};
export type TreeStage = { id: string; no: string; name: string; subAssemblies: TreeSubAssembly[] };

export const stageLabel = (stage: { no: string }) => `Stage ${stage.no}`;
export const subAssemblyLabel = (sub: { no: string }) => `Sub-assembly ${sub.no}`;
export const childPartLabel = (cp: { no: string }) => `Child part ${cp.no}`;
/** Optional BOM details typed after the part was auto-created; blank until then. */
export const childPartDetail = (cp: TreeChildPart) =>
  [[cp.partNo, cp.description].filter(Boolean).join(" — "), cp.partNo || cp.description ? `× ${cp.qtyPerAssembly}` : ""].filter(Boolean).join(" ");
/** Part no. / description left over from sub-assemblies created before auto-numbering; blank for new ones. */
const subAssemblyDetail = (sub: TreeSubAssembly) => [sub.partNo, sub.description].filter(Boolean).join(" — ");

/** Hover card listing a sub-assembly's child parts; shared by the tree and the main-assembly checkboxes. */
export function SubAssemblyPartsTooltip({ sub, children }: { sub: TreeSubAssembly; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="shrink-0 cursor-help">{children}</span>} />
      <TooltipContent side="right" className="block max-w-sm text-xs">
        <p className="mb-1 font-semibold">
          {subAssemblyLabel(sub)}
          {subAssemblyDetail(sub) ? <span className="font-normal opacity-80"> · {subAssemblyDetail(sub)}</span> : null}
        </p>
        {sub.childParts.length === 0 ? (
          <p className="opacity-80">No child parts yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {sub.childParts.map((cp) => (
              <li key={cp.id}>
                {childPartLabel(cp)}
                {childPartDetail(cp) ? ` · ${childPartDetail(cp)}` : ""}
                {cp.type === "BOP" ? " (BOP)" : ""}
                {cp.steps.length > 0 ? <span className="opacity-80"> — {cp.steps.map((st) => st.name).join(" → ")}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const EDGE = "border-muted-foreground/70";
const PILL = "rounded-full border border-muted-foreground/50 bg-card px-2 py-0.5 text-[10px] whitespace-nowrap";

/**
 * Elbow from a parent box down to one of its side-by-side children: a short
 * vertical drop into the child, plus its slice of the horizontal bar the
 * siblings share. Borders, no SVG, so it themes like the page. The child
 * needs `relative pt-5`.
 */
function fanDownClasses(i: number, n: number) {
  return cn(
    "before:absolute before:top-0 before:left-1/2 before:h-5 before:border-l-2 before:border-muted-foreground/70",
    n > 1 && "after:absolute after:top-0 after:border-t-2 after:border-muted-foreground/70",
    n > 1 && i === 0 && "after:left-1/2 after:right-0",
    n > 1 && i > 0 && i < n - 1 && "after:left-0 after:right-0",
    n > 1 && i === n - 1 && "after:left-0 after:right-1/2",
  );
}

/**
 * Slice of the horizontal bus along the bottom that every sub-assembly
 * merges into on the way down to the main assembly. Each column draws its
 * own half-left / half-right piece so the slices join across all stages.
 */
function MergeBus({ left, right }: { left: boolean; right: boolean }) {
  if (!left && !right) return null;
  return <span className={cn("absolute bottom-0 border-b-2", EDGE, left ? "left-0" : "left-1/2", right ? "right-0" : "right-1/2")} />;
}

/** Steps stacked down a connector: a short vertical line, then the step pill. */
function StepPills({ steps, dashed = false }: { steps: TreeStep[]; dashed?: boolean }) {
  return steps.map((step) => (
    <span key={step.id} className="flex shrink-0 flex-col items-center">
      <span className={cn("h-3 border-l-2", EDGE, dashed && "border-dashed")} />
      <span className={PILL}>{step.name}</span>
    </span>
  ));
}

/** Child parts aren't drawn in the tree — hovering the box lists them. */
function SubAssemblyNode({ sub }: { sub: TreeSubAssembly }) {
  return (
    <SubAssemblyPartsTooltip sub={sub}>
      <span
        className={cn(
          "block rounded-md border bg-card px-3 py-1.5 text-center text-xs whitespace-nowrap shadow-xs transition-colors hover:bg-muted",
          !sub.inMainAssembly && "border-dashed opacity-55",
        )}
      >
        <span className="block font-semibold">{subAssemblyLabel(sub)}</span>
        {subAssemblyDetail(sub) ? <span className="block text-muted-foreground">{subAssemblyDetail(sub)}</span> : null}
        <span className="block text-[10px] text-muted-foreground">
          {sub.childParts.length} part{sub.childParts.length === 1 ? "" : "s"}
          {sub.inMainAssembly ? "" : " · not in main assembly"}
        </span>
      </span>
    </SubAssemblyPartsTooltip>
  );
}

/**
 * Top-to-bottom process flow: the steps before the stages (raw material →
 * inspection → kitting…) branch out to Stage 1, 2, 3… side by side → each
 * stage's sub-assemblies (their own steps below them; child parts on hover)
 * → all sub-assemblies merge down into the main assembly.
 */
export function PfcAssemblyTree({
  mainAssembly,
  stages,
  preStageSteps,
}: {
  mainAssembly: { partNo: string; name: string };
  stages: TreeStage[];
  preStageSteps: TreeStep[];
}) {
  if (stages.length === 0) {
    return <p className="text-sm text-muted-foreground">Add a stage to start building the assembly tree.</p>;
  }

  // Columns left to right (one per sub-assembly; an empty stage still takes
  // a column) — the merge bus runs from the first sub-assembly column to the last.
  const colCounts = stages.map((s) => Math.max(1, s.subAssemblies.length));
  const subCols = stages.flatMap((s, si) => s.subAssemblies.map((_, ai) => colCounts.slice(0, si).reduce((a, b) => a + b, 0) + ai));
  const firstSubCol = subCols.length > 0 ? Math.min(...subCols) : -1;
  const lastSubCol = subCols.length > 0 ? Math.max(...subCols) : -1;
  const bus = (col: number) => ({ left: firstSubCol >= 0 && col > firstSubCol, right: lastSubCol >= 0 && col < lastSubCol });

  let col = 0;
  const stageGroups = stages.map((stage) => {
    const n = stage.subAssemblies.length;
    const stageNode = (
      <div className="shrink-0 px-3">
        <div className="rounded-md border bg-secondary px-4 py-1.5 text-center text-xs font-semibold whitespace-nowrap text-secondary-foreground">
          {stageLabel(stage)}
        </div>
      </div>
    );
    if (n === 0) {
      const c = col++;
      return (
        <div key={stage.id} className="flex h-full flex-col items-center">
          {stageNode}
          <div className="relative flex w-full flex-1 justify-center px-3 pt-3 pb-6">
            <span className="text-[11px] whitespace-nowrap text-muted-foreground">No sub-assemblies yet</span>
            <MergeBus {...bus(c)} />
          </div>
        </div>
      );
    }
    return (
      <div key={stage.id} className="flex h-full flex-col items-center">
        {stageNode}
        <div className="relative flex flex-1 pt-5 before:absolute before:top-0 before:left-1/2 before:h-5 before:border-l-2 before:border-muted-foreground/70">
          {stage.subAssemblies.map((sub, i) => {
            const c = col++;
            return (
              <div key={sub.id} className={cn("relative flex flex-col items-center px-3 pt-5", fanDownClasses(i, n))}>
                <SubAssemblyNode sub={sub} />
                <StepPills steps={sub.steps} dashed={!sub.inMainAssembly} />
                <span className={cn("min-h-6 flex-1 border-l-2", EDGE, !sub.inMainAssembly && "border-dashed")} />
                <MergeBus {...bus(c)} />
              </div>
            );
          })}
        </div>
      </div>
    );
  });

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border bg-background p-4">
        <div className="mx-auto flex w-fit flex-col items-center">
          {preStageSteps.length > 0 ? (
            <div className="flex flex-col items-center">
              {preStageSteps.map((step, i) => (
                <span key={step.id} className="flex flex-col items-center">
                  {i > 0 ? <span className={cn("h-3 border-l-2", EDGE)} /> : null}
                  <span className={PILL}>{step.name}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-stretch">
            {stageGroups.map((group, i) => (
              <div key={stages[i].id} className={cn("relative", preStageSteps.length > 0 && cn("pt-5", fanDownClasses(i, stages.length)))}>
                {group}
              </div>
            ))}
          </div>
          {subCols.length > 0 ? <span className={cn("h-6 border-l-2", EDGE)} /> : <span className="h-6" />}
          <div className="rounded-md bg-primary px-4 py-2 text-center text-xs text-primary-foreground shadow-sm">
            <span className="block text-[10px] tracking-wide uppercase opacity-80">Main assembly</span>
            <span className="block font-semibold">{mainAssembly.partNo}</span>
            <span className="block">{mainAssembly.name}</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Flow runs top to bottom: steps before the stages → stages → sub-assemblies (with their steps) → main assembly. Hover a sub-assembly to
        see its child parts and their steps. Dashed sub-assemblies are not ticked for the main assembly.
      </p>
    </div>
  );
}
