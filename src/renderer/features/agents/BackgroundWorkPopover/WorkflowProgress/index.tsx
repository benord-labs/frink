/** A running Workflow's phases and agents, pulled every 2s only while the list is open — the CLI
 * itself snapshots at most every ~10s or on an agent or phase change. */

import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  WorkflowAgentProgress,
  WorkflowProgressView,
} from '../../../../../shared/types/wake-hold/workflow-progress';
import { formatElapsedTime } from '../../../../lib/agent-chat/elapsed-time/format-elapsed-time';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';

const POLL_MS = 2000;

export function WorkflowProgress({ subChatId, taskId }: { subChatId: string; taskId: string }) {
  const { data } = trpc.socket.getWorkflowProgress.useQuery(
    { subChatId, taskId },
    { refetchInterval: POLL_MS },
  );
  const running = data?.agents.some((agent) => agent.state === 'running') ?? false;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (!data) return null;
  return (
    <div className="mt-1.5 mb-0.5 space-y-1.5 border-l border-border pl-3">
      {groupByPhase(data).map(({ key, title, agents }) => (
        <div key={key}>
          {title ? (
            <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">{title}</span>
              <span className="shrink-0 tabular-nums">
                {agents.length === 0
                  ? 'Up next'
                  : `${agents.filter((agent) => agent.state === 'done').length}/${agents.length}`}
              </span>
            </div>
          ) : null}
          <ul>
            {agents.map((agent) => (
              <WorkflowAgentRow key={agent.index} agent={agent} now={now} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Phases in order, each with its agents; agents with no known phase trail as one untitled group. */
function groupByPhase(view: WorkflowProgressView) {
  const groups = view.phases.map((phase) => ({
    key: `phase-${phase.index}`,
    title: phase.title,
    agents: view.agents.filter((agent) => agent.phaseIndex === phase.index),
  }));
  const phased = new Set(view.phases.map((phase) => phase.index));
  const loose = view.agents.filter(
    (agent) => agent.phaseIndex === undefined || !phased.has(agent.phaseIndex),
  );
  // A phase with no agents yet is still shown, as up next; only an empty untitled group is noise.
  return loose.length > 0 ? [...groups, { key: 'loose', title: null, agents: loose }] : groups;
}

function WorkflowAgentRow({ agent, now }: { agent: WorkflowAgentProgress; now: number }) {
  const elapsed =
    agent.state === 'running' && agent.startedAt !== undefined
      ? formatElapsedTime(now - agent.startedAt)
      : formatElapsedTime(agent.durationMs ?? 0);
  const detail =
    agent.state === 'error' ? agent.error : agent.state === 'running' && agent.activity;
  return (
    <li className="flex items-center gap-1.5 py-0.5 text-[11px]">
      <AgentStateMark state={agent.state} />
      <span
        className={cn('min-w-0 truncate', agent.state === 'queued' && 'text-muted-foreground')}
        title={agent.label}
      >
        {agent.label}
      </span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={detail}>
          {detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="shrink-0 tabular-nums text-muted-foreground">{elapsed}</span>
    </li>
  );
}

function AgentStateMark({ state }: { state: WorkflowAgentProgress['state'] }) {
  if (state === 'done') {
    return <Check className="h-3 w-3 shrink-0 text-status-online" aria-label="Done" />;
  }
  if (state === 'error')
    return <X className="h-3 w-3 shrink-0 text-destructive" aria-label="Failed" />;
  return (
    <span className="flex h-3 w-3 shrink-0 items-center justify-center">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          state === 'running'
            ? 'bg-primary motion-safe:animate-pulse'
            : 'border border-muted-foreground/60',
        )}
        role="img"
        aria-label={state === 'running' ? 'Running' : 'Queued'}
      />
    </span>
  );
}
