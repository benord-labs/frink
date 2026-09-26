import { Button } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import type { FlowConsentPromptData } from '../../../../shared/types/flows/flow-consent';
import { cn } from '../../../lib/utils';

type FlowConsentViewProps = {
  flowConsent: FlowConsentPromptData;
  onAllowOnce: () => void;
  onAllowAlways: () => void;
  onDeny: () => void;
  primaryCtaClassName?: string;
};

/**
 * Per-flow consent for an agent-initiated Flow run.
 *
 * Three outcomes, so neither existing view fits: `SimpleApprovalView` has two
 * buttons, and `FourButtonView`'s rule-scope dropdown describes permission
 * rules, while this grant writes `flows.agent_invocable`.
 *
 * The flow's NAME is chosen by the agent that authored it, so the card also
 * states what the graph will execute — a name alone is not informed consent.
 */
export const FlowConsentView = memo(function FlowConsentView({
  flowConsent,
  onAllowOnce,
  onAllowAlways,
  onDeny,
  primaryCtaClassName,
}: FlowConsentViewProps) {
  const { flowName, summary, allowOnce } = flowConsent;
  const { batch, unsandboxedBlockTypes } = summary;

  return (
    <>
      <div className="flex items-start gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium py-0.5 shrink-0">
          Flow
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-foreground leading-relaxed">
            Let this chat&apos;s agent run &quot;{flowName}&quot;?
          </span>
          <span className="text-[11px] text-muted-foreground leading-relaxed">
            {batch
              ? `${batch.pendingRunCount} run${batch.pendingRunCount === 1 ? '' : 's'} across ${batch.stageCount} stage${batch.stageCount === 1 ? '' : 's'}`
              : `${summary.nodeCount} step${summary.nodeCount === 1 ? '' : 's'}`}
            {summary.blockTypes.length > 0 ? ` · ${summary.blockTypes.join(', ')}` : ''}
          </span>
          {unsandboxedBlockTypes.length > 0 && (
            <span className="text-[11px] text-warning leading-relaxed">
              Runs commands on this machine ({unsandboxedBlockTypes.join(', ')}).
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={onDeny}>
          Deny
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={onAllowAlways}
        >
          Always allow this Flow
        </Button>
        {/*
          Hidden under Auto Mode: the agent parks and retries in a later turn,
          and a one-call approval cannot span that boundary — the button would
          silently do nothing.
        */}
        {allowOnce && (
          <Button
            variant="primary"
            size="sm"
            className={cn('h-7 px-2.5 text-xs', primaryCtaClassName)}
            onClick={onAllowOnce}
          >
            {batch ? 'Run this batch once' : 'Allow once'}
          </Button>
        )}
      </div>
    </>
  );
});
