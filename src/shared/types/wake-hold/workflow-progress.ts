/** A running Workflow's phases and agents, parsed from the CLI's `task_progress` snapshots. */
export type WorkflowProgressView = {
  phases: { index: number; title: string }[];
  agents: WorkflowAgentProgress[];
};

export type WorkflowAgentProgress = {
  index: number;
  label: string;
  phaseIndex?: number;
  state: 'queued' | 'running' | 'done' | 'error';
  /** Epoch ms. */
  startedAt?: number;
  durationMs?: number;
  /** What a running agent is doing now, e.g. "Bash · bun test". */
  activity?: string;
  error?: string;
};
