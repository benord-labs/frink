import { taskResultSchema, type TaskResultRecord } from '../../../../../shared/types/task-result';

type OverviewTaskRow = {
  id: string;
  status: string;
  effectiveStatus?: string;
  linkedChatId?: string | null;
  result?: TaskResultRecord | null;
  triggerContext?: TaskResultRecord | null;
};

const ATTENTION_STATUSES = [
  'plan_ready',
  'needs_attention',
  'interrupted',
  'failed',
  'done',
] as const;

function isWaitingForPickup(row: OverviewTaskRow): boolean {
  if (row.status !== 'pending') return false;
  const config = taskResultSchema.safeParse(row.triggerContext?.Config);
  return config.success && config.data.startMode === 'wait';
}

export function getOverviewTaskChatId(row: OverviewTaskRow): string | undefined {
  const parsedConfig = taskResultSchema.safeParse(row.triggerContext?.Config);
  const config = parsedConfig.success ? parsedConfig.data : null;
  const candidate = [
    row.result?.chatId,
    row.linkedChatId,
    row.triggerContext?.chatId,
    config?.continueChatId,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return candidate?.trim();
}

export function groupOverviewTaskRows<T extends OverviewTaskRow>(
  inboxRows: T[],
  activeRows: T[],
  historyRows: T[],
): { attentionRows: T[]; waitingRows: T[]; runningRows: T[] } {
  const waitingById = new Map<string, T>();
  for (const row of [...inboxRows, ...activeRows]) {
    if (isWaitingForPickup(row)) waitingById.set(row.id, row);
  }

  const attentionCandidates = [...activeRows, ...historyRows];

  return {
    attentionRows: ATTENTION_STATUSES.flatMap((status) =>
      attentionCandidates.filter((row) => (row.effectiveStatus ?? row.status) === status),
    ),
    waitingRows: Array.from(waitingById.values()),
    runningRows: activeRows.filter(
      (row) => (row.effectiveStatus ?? row.status) === 'running' && !waitingById.has(row.id),
    ),
  };
}
