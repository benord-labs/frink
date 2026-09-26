/**
 * Rich tool result card for frink_flows_run.
 */

import { Button } from '@benord-labs/frink-primitives';
import { useSetAtom } from 'jotai';
import { AlertCircle, Play, Workflow } from 'lucide-react';
import type { ReactElement } from 'react';
import { unwrapMcpOutput } from '../../../../../shared/lib/mcp-output';
import { TextShimmer } from '../../../../components/ui/text-shimmer';
import { activeOverlayAtom, flowsSelectedFlowIdAtom } from '../../../../lib/atoms';
import type { MessagePart } from '../../stores/message-store';
import { getToolStatus } from '../agent-tool-registry';

type RunOutput = {
  success?: boolean;
  flowId?: string;
  flowRunId?: string;
  status?: 'queued' | 'started';
  queuePosition?: number;
  message?: string;
};

function parseOutput(part: MessagePart): RunOutput | null {
  if (!part.output || typeof part.output !== 'object') return null;
  const unwrapped = unwrapMcpOutput(part.output);
  if (!unwrapped || typeof unwrapped !== 'object') return null;
  const raw = unwrapped as Record<string, unknown>;
  const flowRunId = typeof raw.flowRunId === 'string' ? raw.flowRunId : null;
  if (!flowRunId && raw.success !== true) return null;
  const status = raw.status === 'queued' || raw.status === 'started' ? raw.status : undefined;
  return {
    success: raw.success === true,
    flowId: typeof raw.flowId === 'string' ? raw.flowId : undefined,
    flowRunId: flowRunId ?? undefined,
    status,
    queuePosition:
      typeof raw.queuePosition === 'number' && Number.isFinite(raw.queuePosition)
        ? raw.queuePosition
        : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

type Props = {
  part: MessagePart;
  chatStatus?: string;
};

export function AgentFlowRunTool({ part, chatStatus }: Props): ReactElement {
  const { isPending } = getToolStatus(part, chatStatus);
  const isOutputAvailable = part.state === 'output-available';
  const isError = part.state === 'output-error';

  const output = isOutputAvailable ? parseOutput(part) : null;
  const inputFlowId =
    part.input && typeof part.input === 'object' && part.input !== null
      ? String((part.input as Record<string, unknown>).flowId ?? '').trim()
      : '';

  const setFlowId = useSetAtom(flowsSelectedFlowIdAtom);
  const setOverlay = useSetAtom(activeOverlayAtom);

  const title = isError
    ? 'Failed to start flow run'
    : output?.flowRunId
      ? output.status === 'queued'
        ? `Queued flow run${output.queuePosition !== undefined ? ` #${output.queuePosition}` : ''}`
        : 'Started flow run'
      : 'Starting flow run…';

  function handleOpenFlow() {
    const id = output?.flowId ?? inputFlowId;
    if (!id) return;
    setFlowId(id);
    setOverlay('flows');
  }

  return (
    <div className="flex flex-col gap-1.5 py-0.5 px-2">
      <div className="flex items-center gap-1.5">
        {isError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
        ) : (
          <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`text-xs font-medium min-w-0${isError ? ' text-destructive' : ''}`}
        >
          {isPending ? (
            <TextShimmer
              as="span"
              duration={1.2}
              className="inline-flex items-center text-xs leading-none h-4 m-0"
            >
              {title}
            </TextShimmer>
          ) : (
            title
          )}
        </span>
      </div>

      {isOutputAvailable && output?.flowRunId && !isError ? (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-muted-foreground">
          <div className="font-mono break-all">Run: {output.flowRunId}</div>
          {output.message ? <p>{output.message}</p> : null}
          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={handleOpenFlow}
            >
              <Workflow className="h-3 w-3" aria-hidden />
              Open in Flows
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
