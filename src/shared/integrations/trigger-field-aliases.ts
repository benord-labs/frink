/**
 * Friendly `{{trigger.<alias>}}` variables per provider over the raw vendor body, rendered by
 * `src/shared/lib/provider-trigger-aliases.ts`; `{{trigger.payload.*}}` is the raw escape hatch.
 */

export type TriggerFieldAlias = {
  /** Dotted name the flow editor exposes as `{{trigger.<alias>}}`. */
  alias: string;
  /** Path into the raw body; an array is "first defined wins". Indices work (`actions.0.name`). */
  path: string | string[];
  label: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
};

export const TRIGGER_FIELD_ALIASES: Record<string, TriggerFieldAlias[]> = {
  clickup: [
    { alias: 'task.id', path: 'task_id', label: 'Task ID', type: 'string' },
    { alias: 'webhook.id', path: 'webhook_id', label: 'Webhook ID', type: 'string' },
    { alias: 'action', path: 'event', label: 'Event', type: 'string' },
  ],
  shortcut: [
    { alias: 'story.title', path: 'actions.0.name', label: 'Story title', type: 'string' },
    { alias: 'story.id', path: 'primary_id', label: 'Story ID', type: 'number' },
    { alias: 'story.url', path: 'actions.0.app_url', label: 'Story URL', type: 'string' },
    {
      alias: 'story.action',
      path: 'actions.0.action',
      label: 'Action',
      type: 'string',
      description: 'create / update',
    },
  ],
  linear: [
    // Base is the unwrapped Linear webhook body: { action, type, data, url, … }.
    // Issue and Comment events share the `data` root, so entity-specific aliases
    // simply resolve to undefined on the event that does not carry them.
    { alias: 'issue.title', path: 'data.title', label: 'Issue title', type: 'string' },
    // Comment deliveries put the comment's own UUID at data.id and the issue at
    // data.issueId, so reading data.id alone labels a comment id "Issue ID".
    {
      alias: 'issue.id',
      path: ['data.issueId', 'data.id'],
      label: 'Issue ID',
      type: 'string',
    },
    { alias: 'issue.identifier', path: 'data.identifier', label: 'Issue key', type: 'string' },
    { alias: 'issue.url', path: 'url', label: 'Issue URL', type: 'string' },
    {
      alias: 'issue.description',
      path: 'data.description',
      label: 'Description',
      type: 'string',
    },
    { alias: 'issue.priority', path: 'data.priorityLabel', label: 'Priority', type: 'string' },
    { alias: 'comment.body', path: 'data.body', label: 'Comment body', type: 'string' },
    { alias: 'action', path: 'action', label: 'Action', type: 'string' },
  ],
};
