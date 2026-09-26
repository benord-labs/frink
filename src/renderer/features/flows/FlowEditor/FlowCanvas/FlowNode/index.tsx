/**
 * Custom React Flow node: icons, summary, and actions on the canvas.
 *
 * Wrapped in React.memo with a custom comparator so that graph-level changes
 * (which recreate every node's `data` object with fresh closures) only
 * re-render nodes whose *visible* state actually changed.  Without this,
 * every graph mutation causes all nodes to re-render simultaneously, which
 * triggers cascading Handle re-registration in the RF store and blows React's
 * maximum update depth.
 */

import type { Node, NodeProps } from '@xyflow/react';
import { memo, type ReactElement } from 'react';
import type { FlowNode as FlowNodeDef } from '../../../../../../shared/lib/validate-flow-graph';
import type { FlowNodeCanvasContext } from '../../nodeSummary';
import { FlowStepNodeView } from '../FlowStepNodeView';
import type { FlowStepNodeData } from '../useFlowLayout';

export type FlowStepRfData = FlowStepNodeData & {
  node: FlowNodeDef;
  isTrigger: boolean;
  isCondition: boolean;
  isEnd: boolean;
  graphLength: number;
  isSelected: boolean;
  showAppendStubDefault: boolean;
  showAppendStubTrue: boolean;
  showAppendStubFalse: boolean;
  customBlockIcon?: string;
  customFlowCanvasContext?: FlowNodeCanvasContext;
  flowDefaultProjectId: string | undefined;
  /** Canvas execution overlay scope — compared in memo so atom subscriptions stay aligned with flowId. */
  flowId?: string;
  /** Historical run inspection: muted borders, no live pulse. */
  canvasHistoricalInspection?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRequestAddStep: (sourceHandle: string | undefined) => void;
  /** Deep-link from the missing-project warning to the flow settings Project field. */
  onRequestOpenFlowSettings?: () => void;
  readOnly?: boolean;
  /** Fan Out only: smallest container that still fits its children (resize floor). */
  fanOutMinSize?: { width: number; height: number };
};

type FlowStepRfNode = Node<FlowStepRfData, 'flowStep'>;

/** Data fields that change what a step renders; callbacks are deliberately excluded. */
const VISIBLE_KEYS = [
  'node',
  'index',
  'isTrigger',
  'isCondition',
  'isEnd',
  'graphLength',
  'isSelected',
  'showAppendStubDefault',
  'showAppendStubTrue',
  'showAppendStubFalse',
  'customBlockIcon',
  'customFlowCanvasContext',
  'flowDefaultProjectId',
  'flowId',
  'canvasHistoricalInspection',
  'readOnly',
] as const satisfies ReadonlyArray<keyof FlowStepRfData>;

function sameVisibleData(a: FlowStepRfData, b: FlowStepRfData): boolean {
  const aMin = a.fanOutMinSize;
  const bMin = b.fanOutMinSize;
  return (
    VISIBLE_KEYS.every((key) => a[key] === b[key]) &&
    aMin?.width === bMin?.width &&
    aMin?.height === bMin?.height
  );
}

export const FlowStepRf = memo(
  function FlowStepRf({ data }: NodeProps<FlowStepRfNode>): ReactElement {
    return (
      <FlowStepNodeView
        node={data.node}
        index={data.index}
        isTrigger={data.isTrigger}
        isCondition={data.isCondition}
        isEnd={data.isEnd}
        graphLength={data.graphLength}
        isSelected={data.isSelected}
        showAppendStubDefault={data.showAppendStubDefault}
        showAppendStubTrue={data.showAppendStubTrue}
        showAppendStubFalse={data.showAppendStubFalse}
        customBlockIcon={data.customBlockIcon}
        customFlowCanvasContext={data.customFlowCanvasContext}
        flowDefaultProjectId={data.flowDefaultProjectId}
        flowId={data.flowId}
        canvasHistoricalInspection={data.canvasHistoricalInspection}
        onSelect={data.onSelect}
        onDelete={data.onDelete}
        onRequestAddStep={data.onRequestAddStep}
        onRequestOpenFlowSettings={data.onRequestOpenFlowSettings}
        readOnly={data.readOnly}
        fanOutMinSize={data.fanOutMinSize}
      />
    );
  },
  (prev, next) => sameVisibleData(prev.data, next.data),
);
