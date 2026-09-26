const NODE_CONFIG_DETAIL_LABELS: Record<string, string> = {
  instructions: 'Instructions',
  instructionsCommandName: 'Instructions',
  agentInstructions: 'Agent role',
  fireAndForget: 'Completion behavior',
  model: 'Model',
  projectId: 'Project',
  label: 'Task title',
  startMode: 'Agent mode',
  startInWorktree: 'Worktree behavior',
  branch: 'Base branch',
  command: 'Command',
  workingDirectory: 'Working directory',
  customPath: 'Working directory',
  expectedOutputs: 'Output fields',
  url: 'Request destination',
  method: 'Request method',
  headers: 'Request headers',
  body: 'Request body',
  predicate: 'Condition',
  loop: 'Loop behavior',
  message: 'Approval message',
  triggerStates: 'Trigger states',
  filterBySource: 'Trigger filters',
  cronExpression: 'Schedule',
  timezone: 'Time zone',
  description: 'Schedule description',
  skipIfRunning: 'Overlap behavior',
  arrayField: 'Items source',
  maxIterations: 'Iteration limit',
  mode: 'Execution mode',
  maxParallel: 'Concurrency',
  messageTemplate: 'Reply message',
};

export function describeFlowNodeConfigChange(config: unknown): string {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'Step setup';
  const keys = Object.keys(config);
  const labels = [
    ...new Set(
      keys
        .map((key) => NODE_CONFIG_DETAIL_LABELS[key])
        .filter((label): label is string => label !== undefined),
    ),
  ];
  if (keys.some((key) => NODE_CONFIG_DETAIL_LABELS[key] === undefined)) {
    labels.push('Other step setup');
  }
  return labels.join(' · ') || 'Step setup';
}
