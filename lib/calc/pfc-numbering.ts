/**
 * Hierarchical numbering for the Process Flow assembly structure:
 * stage "1", its sub-assemblies "1.1", "1.2", their child parts "1.1.1",
 * "1.1.2". Numbers are positional (from the already-sorted input), never
 * stored, so reordering or deleting renumbers everything automatically.
 */

type StageInput = { subAssemblies: { childParts: unknown[] }[] };
type Sub<T extends StageInput> = T["subAssemblies"][number];
type Child<T extends StageInput> = Sub<T>["childParts"][number];

export type Numbered<T> = T & { no: string };
export type NumberedStage<T extends StageInput> = Numbered<
  Omit<T, "subAssemblies"> & {
    subAssemblies: Numbered<Omit<Sub<T>, "childParts"> & { childParts: Numbered<Child<T>>[] }>[];
  }
>;

export function numberAssemblyStructure<T extends StageInput>(stages: T[]): NumberedStage<T>[] {
  return stages.map((stage, si) => {
    const stageNo = `${si + 1}`;
    return {
      ...stage,
      no: stageNo,
      subAssemblies: stage.subAssemblies.map((sub, ai) => {
        const subNo = `${stageNo}.${ai + 1}`;
        return {
          ...sub,
          no: subNo,
          childParts: sub.childParts.map((cp, ci) => ({ ...(cp as object), no: `${subNo}.${ci + 1}` })),
        };
      }),
    } as NumberedStage<T>;
  });
}
