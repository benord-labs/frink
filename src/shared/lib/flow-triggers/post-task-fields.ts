import type { TriggerFieldSchema } from '../output-schemas';

/** Exactly the `{{trigger.*}}` keys a post-task run saves (src/main/lib/flows/post-task-trigger.ts). */
export const POST_TASK_TRIGGER_FIELDS: TriggerFieldSchema[] = [
  { key: 'taskId', type: 'string', description: 'UUID of the completed task' },
  { key: 'taskTitle', type: 'string', description: 'Title of the completed task' },
  { key: 'taskStatus', type: 'string', description: 'Final status of the task' },
  {
    key: 'source',
    type: 'string',
    description: 'How the task was created (e.g. manual, flow, slack)',
  },
  { key: 'projectId', type: 'string', description: 'UUID of the project the task belonged to' },
  { key: 'taskCompletedAt', type: 'string', description: 'ISO time the task finished' },
  {
    key: 'result',
    type: 'string',
    description: "Summary the task's agent reported when it finished",
    guaranteed: false,
  },
  {
    key: 'branch',
    type: 'string',
    description: 'Git branch the task ran on',
    guaranteed: false,
  },
  {
    key: 'baseBranch',
    type: 'string',
    description: 'Base branch the task branched from',
    guaranteed: false,
  },
  {
    key: 'worktreePath',
    type: 'string',
    description: 'Absolute path to the task worktree',
    guaranteed: false,
  },
  {
    key: 'chatId',
    type: 'string',
    description: 'Chat session ID of the completed task',
    guaranteed: false,
  },
  {
    key: 'subChatId',
    type: 'string',
    description: 'Chat tab the completed task ran in',
    guaranteed: false,
  },
  {
    key: 'projectPath',
    type: 'string',
    description: 'Main project directory path',
    guaranteed: false,
  },
];
