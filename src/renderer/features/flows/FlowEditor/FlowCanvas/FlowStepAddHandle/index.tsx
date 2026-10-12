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
        className="shrink-0 overflow-visible text-muted-foreground/40"
        aria-hidden
      >
        <line
          x1={2}
          y1={0}
          x2={2}
          y2={STUB_HEIGHT}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeDasharray="3 4"
          strokeLinecap="round"
        />
      </svg>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 w-7 shrink-0 rounded-full border border-border/70 bg-card text-muted-foreground shadow-sm hover:text-foreground"
        disabled={atCap}
        aria-label="Add new step"
        title="Add new step"
        onClick={(e) => {
          e.stopPropagation();
          onRequestAddStep(sourceHandle);
        }}
        iconOnly
      >
        <Plus className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
