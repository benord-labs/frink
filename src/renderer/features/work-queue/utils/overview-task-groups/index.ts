import { taskResultSchema, type TaskResultRecord } from '../../../../../shared/types/task-result';

type OverviewTaskRow = {
  linkedChatId?: string | null;
  result?: TaskResultRecord | null;
  triggerContext?: TaskResultRecord | null;
};

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
