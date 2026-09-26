import { memo } from 'react';
import {
  type InvoluntaryAbortReason,
  involuntaryAbortMessage,
} from '../../../../shared/lib/user-abort-error';

type AgentToolInterruptedProps = {
  toolName: string;
  subtitle?: string;
};

export const AgentToolInterrupted = memo(function AgentToolInterrupted({
  toolName,
  subtitle,
}: AgentToolInterruptedProps) {
  return (
    <div className="flex items-center gap-1.5 rounded-md py-0.5 px-2">
      <span className="text-xs text-muted-foreground">{toolName} interrupted</span>
      {subtitle && <span className="text-xs text-muted-foreground/60 truncate">{subtitle}</span>}
    </div>
  );
});

/**
 * Terminal row for a turn Frink itself tore down (window reload/crash).
 *
 * Reads the reason off the PERSISTED message metadata rather than the live error stream: the error
 * is IPC-only, and the window that would have received it is the one that just went away. Without a
 * durable row the transcript simply stops on a frozen tool card, which reads as a hang.
 */
export const AgentTurnInterrupted = memo(function AgentTurnInterrupted({
  reason,
}: {
  reason: InvoluntaryAbortReason;
}) {
  return (
    <div className="px-2 mt-1">
      <span className="text-xs text-muted-foreground">{involuntaryAbortMessage(reason)}</span>
    </div>
  );
});
