// Events that support state transitions
export const STATE_TRANSITION_EVENTS = ['story_moved', 'task_status_changed'];

// Strings > 50 chars only
export const LONG_STRINGS = {
  noConditionsText:
    'No conditions added. Click "Add filter" to narrow down when this rule triggers.',
  assigneeMeDescription:
    'Only triggers when assigned to your connected account. Add API access if identity is unavailable.',
} as const;

// Operator options for filters
export const OPERATOR_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
] as const;
