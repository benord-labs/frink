import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DbNodeRun } from '../../../../../shared/types/flow-run';
import {
  isCustomNodeBlockType,
  isTriggerBlockType,
} from '../../../../../shared/lib/block-registry';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';
import { countUniqueLanesByParent } from '../../../../lib/flows/count-unique-lanes-by-parent';
import { trpc } from '../../../../lib/trpc';
import { buildFlowNodeById, flowNodeRunDisplay } from './node-run-display';
import { NodeRunRow } from './node-run-row';

const TRAILING_SLASH_RE = /\/$/;
const LEADING_SLASH_RE = /^\//;

type NodeRunListProps = {
  flowRunId: string;
  graph: FlowGraph | null;
  nodeRuns: DbNodeRun[];
};

export function NodeRunList({ flowRunId, graph, nodeRuns }: NodeRunListProps) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const nodeById = useMemo(() => buildFlowNodeById(graph), [graph]);
  const nodeLabelById = useMemo(
    () =>
      new Map(
        graph?.nodes.map((node) => [node.id, node.label?.trim() || node.blockType] as const) ?? [],
      ),
    [graph],
  );
  const { data: discovery } = trpc.customNodes.discoverLocal.useQuery(undefined, {
    staleTime: 30_000,
  });

  const entryPathByBlock = useMemo(() => {
    const m = new Map<string, string>();
    for (const man of discovery?.valid ?? []) {
      const base = man.nodePath.replace(TRAILING_SLASH_RE, '');
      const ent = man.entrypoint.replace(LEADING_SLASH_RE, '');
      m.set(man.name, `${base}/${ent}`);
    }
    return m;
  }, [discovery]);

  const onToggleNode = useCallback((nodeRunId: string) => {
    setExpandedNodeId((prev) => (prev === nodeRunId ? null : nodeRunId));
  }, []);

  useEffect(() => {
    setExpandedNodeId(null);
  }, [flowRunId]);

  const laneTotalByParent = useMemo(() => countUniqueLanesByParent(nodeRuns), [nodeRuns]);

  const visible = nodeRuns.filter((n) => !isTriggerBlockType(n.block_type));
  if (visible.length === 0) {
    return <p className="text-xs text-muted-foreground/60 py-2">No node executions recorded.</p>;
  }

  return (
    <ul className="mt-2 space-y-0.5">
      {visible.map((nr) => {
        const { title, kind } = flowNodeRunDisplay(nr.block_type, nodeById.get(nr.node_id));
        const isExpanded = expandedNodeId === nr.id;
        const laneTotal =
          nr.parent_fan_out_node_run_id != null
            ? (laneTotalByParent.get(nr.parent_fan_out_node_run_id) ?? undefined)
            : undefined;

        const customEntrypointPath = isCustomNodeBlockType(nr.block_type)
          ? (entryPathByBlock.get(nr.block_type) ?? null)
          : null;

        return (
          <NodeRunRow
            key={nr.id}
            nr={nr}
            title={title}
            kind={kind ?? undefined}
            customEntrypointPath={customEntrypointPath}
            nodeLabelById={nodeLabelById}
            laneTotal={laneTotal}
            isExpanded={isExpanded}
            onToggleNode={onToggleNode}
          />
        );
      })}
    </ul>
  );
}
