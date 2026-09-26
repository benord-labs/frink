/**
 * DAG validation utilities for batch stage dependency graphs.
 */

/** Maximum fan-in per stage. A stage depending on 10+ parents is hard to reason about. */
const MAX_FAN_IN = 10;

type DagStageInput = {
  stageNumber: number;
  dependsOn?: number[];
};

type DagValidationResult =
  | { valid: true; rootStageNumbers: number[]; maxDepth: number }
  | { valid: false; error: string; invalidIndex?: number };

/**
 * Validates a DAG structure of batch stages.
 *
 * Checks (in order):
 * 1. Duplicate stageNumbers
 * 2. Self-references
 * 3. Duplicate stageNumbers within a single dependsOn array
 * 4. Dangling references (dependsOn referencing non-existent stageNumbers)
 * 5. Max fan-in (≤10 dependencies per stage)
 * 6. Cycles (Kahn's topological sort)
 * 7. Max depth (≤50)
 *
 * Both undefined and [] dependsOn are treated as "root" (no dependencies).
 */
function stageArrayIndex(stages: DagStageInput[], stageNum: number): number | undefined {
  const i = stages.findIndex((s) => s.stageNumber === stageNum);
  return i >= 0 ? i : undefined;
}

export function validateDag(stages: DagStageInput[]): DagValidationResult {
  const stageNumbers = stages.map((s) => s.stageNumber);
  const seenDup = new Set<number>();
  for (let i = 0; i < stages.length; i++) {
    const n = stages[i].stageNumber;
    if (seenDup.has(n)) {
      return {
        valid: false,
        error: 'Duplicate stageNumbers are not allowed',
        invalidIndex: i,
      };
    }
    seenDup.add(n);
  }
  const stageSet = new Set(stageNumbers);

  const normalizedDeps = new Map<number, number[]>();
  for (const stage of stages) {
    const deps = stage.dependsOn && stage.dependsOn.length > 0 ? stage.dependsOn : [];
    normalizedDeps.set(stage.stageNumber, deps);
  }

  for (const [stageNum, deps] of normalizedDeps) {
    if (deps.includes(stageNum)) {
      const invalidIndex = stageArrayIndex(stages, stageNum);
      return {
        valid: false,
        error: `Stage ${stageNum} cannot depend on itself`,
        ...(invalidIndex !== undefined ? { invalidIndex } : {}),
      };
    }
  }

  for (const [stageNum, deps] of normalizedDeps) {
    if (new Set(deps).size !== deps.length) {
      const invalidIndex = stageArrayIndex(stages, stageNum);
      return {
        valid: false,
        error: `Stage ${stageNum} has duplicate stageNumbers in dependsOn`,
        ...(invalidIndex !== undefined ? { invalidIndex } : {}),
      };
    }
  }

  for (const [stageNum, deps] of normalizedDeps) {
    for (const dep of deps) {
      if (!stageSet.has(dep)) {
        const invalidIndex = stageArrayIndex(stages, stageNum);
        return {
          valid: false,
          error: `Stage ${stageNum} references non-existent stage ${dep}`,
          ...(invalidIndex !== undefined ? { invalidIndex } : {}),
        };
      }
    }
  }

  for (const [stageNum, deps] of normalizedDeps) {
    if (deps.length > MAX_FAN_IN) {
      const invalidIndex = stageArrayIndex(stages, stageNum);
      return {
        valid: false,
        error: `Stage ${stageNum} exceeds maximum fan-in of ${MAX_FAN_IN} dependencies`,
        ...(invalidIndex !== undefined ? { invalidIndex } : {}),
      };
    }
  }

  const inDegree = new Map<number, number>();
  const successors = new Map<number, number[]>();
  for (const stageNum of stageSet) {
    inDegree.set(stageNum, 0);
    successors.set(stageNum, []);
  }
  for (const [stageNum, deps] of normalizedDeps) {
    for (const dep of deps) {
      inDegree.set(stageNum, (inDegree.get(stageNum) ?? 0) + 1);
      const sucList = successors.get(dep);
      if (sucList) sucList.push(stageNum);
    }
  }

  const queue: number[] = [];
  for (const [stageNum, degree] of inDegree) {
    if (degree === 0) queue.push(stageNum);
  }

  const topologicalOrder: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    topologicalOrder.push(node);
    for (const successor of successors.get(node) ?? []) {
      const newDegree = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, newDegree);
      if (newDegree === 0) queue.push(successor);
    }
  }

  if (topologicalOrder.length !== stages.length) {
    return { valid: false, error: 'Cyclic dependency detected in stage graph' };
  }

  const depth = new Map<number, number>();
  for (const stageNum of topologicalOrder) {
    const deps = normalizedDeps.get(stageNum) ?? [];
    if (deps.length === 0) {
      depth.set(stageNum, 1);
    } else {
      const maxPredDepth = Math.max(...deps.map((d) => depth.get(d) ?? 0));
      depth.set(stageNum, maxPredDepth + 1);
    }
  }

  const maxDepth = depth.size === 0 ? 0 : Math.max(...depth.values());

  const rootStageNumbers = [...normalizedDeps.entries()]
    .filter(([, deps]) => deps.length === 0)
    .map(([stageNum]) => stageNum);

  return { valid: true, rootStageNumbers, maxDepth };
}
