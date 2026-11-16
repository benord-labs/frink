import type { OutputFieldSchema } from '../output-schemas';

/** What an agent node writes to `outputs` when it completes, read as `{{previous.<key>}}`. */
export const AGENT_OUTPUT_SCHEMA: OutputFieldSchema[] = [
  {
    key: 'summary',
    type: 'string',
    description: 'Short summary the agent reported on completion',
    guaranteed: false,
  },
  {
    key: 'details',
    type: 'string',
    description: 'Detailed output the agent reported on completion',
    guaranteed: false,
  },
  {
    key: 'chatId',
    type: 'string',
    description: 'Chat session ID — used by downstream agent and chat_reply blocks',
    guaranteed: true,
  },
  {
    key: 'worktreePath',
    type: 'string',
    description: 'Absolute path to the git worktree used by this agent',
    guaranteed: false,
  },
  {
    key: 'branch',
    type: 'string',
    description: 'Git branch the agent worked on',
    guaranteed: false,
  },
  {
    key: 'baseBranch',
    type: 'string',
    description: 'Base branch',
    guaranteed: false,
  },
  {
    key: 'spawnedTaskId',
    type: 'string',
    description: 'Task ID — only present when fireAndForget is true',
    guaranteed: false,
  },
  {
    key: 'fireAndForget',
    type: 'boolean',
    description: 'True when agent was launched in async fire-and-forget mode',
    guaranteed: false,
  },
  {
    key: 'taskStatus',
    type: 'string',
    description:
      'Task status when the node ended in a non-standard state (e.g. needs_attention when agent did not signal). Use {{previous.taskStatus}} to branch on this.',
    guaranteed: false,
  },
  {
    key: 'verification',
    type: 'object',
    description:
      "Structured verification result from the agent's frink_task_signal call — only present when the agent explicitly includes a verification object. Use dot notation: {{previous.verification.passed}}",
    guaranteed: false,
  },
  {
    key: 'contextTokens',
    type: 'number',
    description:
      "Tokens in the agent's context window after this node's turn. null when the provider reports no context usage (Cursor, Copilot).",
    guaranteed: false,
  },
  {
    key: 'compactions',
    type: 'number',
    description:
      "How many times the agent's context was compacted during this node, summed across turns if it paused and resumed. null when the provider cannot report compactions (currently every provider except Claude).",
    guaranteed: false,
  },
];
