/** FlowWaitingBar — the flow chat's bottom surface while a step waits for the user to start it.
 * Start hands the step to the task executor, so it runs in this chat for every provider. */
import { Button } from '@benord-labs/frink-primitives';
import { Loader2, Play } from 'lucide-react';
import { memo, useState } from 'react';
import type { ChatMode } from '../../../../../../../../shared/types/chat-mode';
import type { CodexSpeed } from '../../../../../../../../shared/types/execution';
import { useStartWaitingTask } from '../../../../../../../lib/flows/waiting-step/use-start-waiting-task';
import { FlowRunMeta } from '../FlowRunMeta';
import { FlowSurfaceCard } from '../FlowSurfaceCard';
import { StopRunButton } from '../StopRunButton';

type FlowWaitingBarProps = {
  flowRunId: string;
  /** The waiting step Start releases. */
  taskId: string;
  modelId?: string;
  mode?: ChatMode;
  autoReviewTools?: boolean;
  codexSpeed?: CodexSpeed;
  onStopTurn: () => Promise<void> | void;
};

export const FlowWaitingBar = memo(function FlowWaitingBar({
  flowRunId,
  taskId,
  modelId,
  mode,
  autoReviewTools,
  codexSpeed,
  onStopTurn,
}: FlowWaitingBarProps) {
  const [confirming, setConfirming] = useState(false);
  const { starting, start } = useStartWaitingTask();

  return (
    <FlowSurfaceCard
      status={<span className="min-w-0 flex-1 truncate">Waiting for you to start this step.</span>}
      meta={
        <FlowRunMeta
          modelId={modelId}
          mode={mode}
          autoReviewTools={autoReviewTools}
          codexSpeed={codexSpeed}
          confirming={confirming}
        />
      }
      actions={
        <>
          {confirming ? null : (
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="h-7 shrink-0 gap-1 text-xs"
              title="Run this step now. The flow carries on when it's done."
              disabled={starting}
              aria-busy={starting || undefined}
              onClick={() => void start(taskId)}
            >
              {starting ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <Play className="h-3 w-3" aria-hidden />
              )}
              <span aria-live="polite">{starting ? 'Starting…' : 'Start'}</span>
            </Button>
          )}
          <StopRunButton
            flowRunId={flowRunId}
            onStopTurn={onStopTurn}
            onConfirmingChange={setConfirming}
          />
        </>
      }
    />
  );
});
