/**
 * Append control: dashed stub line from the source handle into a "+" (leaf / open branch only).
 */

import { Button } from '@benord-labs/frink-primitives';
import { Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { MAX_FLOW_GRAPH_NODES } from '../../../../../../shared/lib/validate-flow-graph';
import { cn } from '../../../../../lib/utils';

const STUB_HEIGHT = 36;

type FlowStepAddHandleProps = {
  graphLength: number;
  sourceHandle: string | undefined;
  onRequestAddStep: (sourceHandle: string | undefined) => void;
  className?: string;
};

export function FlowStepAddHandle({
  graphLength,
  sourceHandle,
  onRequestAddStep,
  className,
}: FlowStepAddHandleProps): ReactElement {
  const atCap = graphLength >= MAX_FLOW_GRAPH_NODES;

  return (
    <div className={cn('pointer-events-auto flex flex-col items-center', className)}>
      <svg
        width={4}
        height={STUB_HEIGHT}
        className="shrink-0 overflow-visible text-muted-foreground/55"
        aria-hidden
      >
        <line
          x1={2}
          y1={0}
          x2={2}
          y2={STUB_HEIGHT}
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinecap="round"
        />
      </svg>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-8 w-8 shrink-0 rounded-full border border-border/50 bg-card shadow-md ring-1 ring-inset ring-border/35"
        disabled={atCap}
        aria-label="Add new step"
        title="Add new step"
        onClick={(e) => {
          e.stopPropagation();
          onRequestAddStep(sourceHandle);
        }}
        iconOnly
      >
        <Plus className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
