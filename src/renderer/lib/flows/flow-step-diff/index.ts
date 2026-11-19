import type {
  FlowChangePresentation,
  FlowSemanticChange,
} from '../../../../shared/types/flows/flow-change-presentation';
import type { FlowGraph } from '../../../../shared/lib/validate-flow-graph';
import type { FlowOutlineRoute, FlowOutlineStep } from '../flow-change-outline';
import { type StepFieldChange, stepFieldChanges } from './step-fields';

export type { StepFieldChange, TextFieldChange } from './step-fields';
export type { DiffParagraph, DiffSegment, TextDiffSize } from './text-diff';

/** The immutable saved versions a patch went from and to. */
export type FlowVersionPair = { before: FlowGraph; after: FlowGraph };

export type FlowVersionKey = { flowId: string; baseVersionNumber: number };

export type StepChangeEntry = {
  nodeId: string;
  label: string;
  blockTypeLabel?: string;
  /** Branch labels leading to the step, outermost first. */
  path: string[];
  fields: StepFieldChange[];
};

const DIFFABLE_PHASES = new Set<FlowChangePresentation['phase']>(['applied', 'partial']);

function isAppliedStepUpdate(change: FlowSemanticChange): boolean {
  return (
    change.kind === 'node' &&
    change.action === 'update' &&
    change.status === 'applied' &&
    Boolean(change.nodeId)
  );
}

/**
 * The version pair to read, only when the receipt proves the patch saved exactly base+1: the
 * optimistic-concurrency save guarantees that pair holds this patch and nothing else.
 */
export function stepDiffVersionKey(
  presentation: FlowChangePresentation,
): FlowVersionKey | undefined {
  const { baseVersionNumber, flowId, versionNumber } = presentation;
  if (presentation.mode !== 'update' || !DIFFABLE_PHASES.has(presentation.phase)) return undefined;
  if (!flowId || baseVersionNumber == null || versionNumber !== baseVersionNumber + 1) {
    return undefined;
  }
  if (!presentation.changes.some(isAppliedStepUpdate)) return undefined;
  return { flowId, baseVersionNumber };
}

function findStep(
  routes: FlowOutlineRoute[],
  nodeId: string,
  trail: string[] = [],
): { step: FlowOutlineStep; path: string[] } | undefined {
  for (const route of routes) {
    const path = route.label ? [...trail, route.label] : trail;
    for (const step of route.steps) {
      if (step.nodeId === nodeId) return { step, path };
      const nested = findStep(step.branches, nodeId, path);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** One entry per updated step whose saved fields differ, in receipt order. */
export function buildStepChanges(
  presentation: FlowChangePresentation,
  versions: FlowVersionPair,
  routes: FlowOutlineRoute[],
): StepChangeEntry[] {
  // A step removed and re-added under the same id is a different step; diffing it would mislead.
  const replaced = new Set(
    presentation.changes
      .filter(
        (change) =>
          change.kind === 'node' && change.action !== 'update' && change.status === 'applied',
      )
      .map((change) => change.nodeId),
  );
  const nodeIds = [
    ...new Set(
      presentation.changes.filter(isAppliedStepUpdate).map((change) => change.nodeId ?? ''),
    ),
  ].filter((nodeId) => !replaced.has(nodeId));
  return nodeIds.flatMap((nodeId) => {
    const before = versions.before.nodes.find((node) => node.id === nodeId);
    const after = versions.after.nodes.find((node) => node.id === nodeId);
    if (!before || !after) return [];
    const fields = stepFieldChanges(before, after);
    if (fields.length === 0) return [];
    const placed = findStep(routes, nodeId);
    return [
      {
        nodeId,
        label: after.label || placed?.step.label || after.blockType,
        blockTypeLabel: placed?.step.blockTypeLabel,
        path: placed?.path ?? [],
        fields,
      },
    ];
  });
}
