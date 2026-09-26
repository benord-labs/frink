export type ConditionFilter = {
  id: string;
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'in_list';
  /** in_list stores a list; the editor has no list control, so a list is shown but only text is edited. */
  value: string | string[];
};

export type EventType = {
  id: string;
  label: string;
};

export type AssigneeMode = 'me' | 'anyone' | 'specific';
