import { describe, expect, it } from 'vitest';
import {
  defaultWebhookAssignee,
  packWebhookTriggerConditions,
} from './webhook-trigger-condition-pack';

describe('packWebhookTriggerConditions', () => {
  it('story_assigned selection persists assignee me (regression: empty conditions must not match-all)', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: true,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [],
    });
    expect(conditions).toEqual({ assignee: 'me' });
  });

  it('story_moved includes status fields when set and not assignee', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: true,
      supportsAssignee: false,
      fromStatus: 'Started',
      toStatus: 'Done',
      assigneeMode: 'me',
      filters: [],
    });
    expect(conditions).toEqual({ from_status: 'Started', to_status: 'Done' });
  });

  it('includes packed filters when valid field and value pairs are present', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [
        { field: 'branch', operator: 'contains', value: 'main' },
        { field: 'label', operator: 'equals', value: 'bug' },
      ],
    });
    expect(conditions.filters).toEqual([
      { field: 'branch', operator: 'contains', value: 'main' },
      { field: 'label', operator: 'equals', value: 'bug' },
    ]);
  });

  it('drops filters with missing field or empty value', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [
        { field: '', operator: 'equals', value: 'x' },
        { field: 'ok', operator: 'equals', value: 'y' },
        { field: 'bad', operator: 'equals', value: '' },
      ],
    });
    expect(conditions.filters).toEqual([{ field: 'ok', operator: 'equals', value: 'y' }]);
  });

  it('overrides operator to equals when field is repo_full_name', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [{ field: 'repo_full_name', operator: 'contains', value: 'acme/repo' }],
    });
    expect(conditions.filters).toEqual([
      { field: 'repo_full_name', operator: 'equals', value: 'acme/repo' },
    ]);
  });

  it('passes an in_list filter through with its list intact', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [{ field: 'project_id', operator: 'in_list', value: ['p0', 'p1'] }],
    });
    expect(conditions.filters).toEqual([
      { field: 'project_id', operator: 'in_list', value: ['p0', 'p1'] },
    ]);
  });

  it('omits filters when all filter entries are invalid', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [
        { field: '', operator: 'equals', value: 'x' },
        { field: 'y', operator: 'equals', value: '' },
      ],
    });
    expect(conditions.filters).toBeUndefined();
  });

  it('omits filters key when all filter rows are invalid alongside status and assignee (no empty filters array)', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: true,
      supportsAssignee: true,
      fromStatus: 'Started',
      toStatus: 'Done',
      assigneeMode: 'me',
      filters: [
        { field: '', operator: 'equals', value: 'x' },
        { field: 'y', operator: 'equals', value: '' },
      ],
    });
    expect(conditions).toEqual({
      from_status: 'Started',
      to_status: 'Done',
      assignee: 'me',
    });
    expect(conditions).not.toHaveProperty('filters');
  });

  it('trims filter field and value before packing', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [{ field: '  branch  ', operator: 'contains', value: '  main  ' }],
    });
    expect(conditions.filters).toEqual([{ field: 'branch', operator: 'contains', value: 'main' }]);
  });

  it('passes operator through unchanged (not trimmed): empty string and surrounding whitespace', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [
        { field: 'branch', operator: '', value: 'main' },
        { field: 'label', operator: '  contains  ', value: 'bug' },
      ],
    });
    expect(conditions.filters).toEqual([
      { field: 'branch', operator: '', value: 'main' },
      { field: 'label', operator: '  contains  ', value: 'bug' },
    ]);
  });

  it('drops filters when field or value is whitespace-only after trim', () => {
    const conditions = packWebhookTriggerConditions({
      supportsStateTransition: false,
      supportsAssignee: false,
      fromStatus: '',
      toStatus: '',
      assigneeMode: 'me',
      filters: [
        { field: '   ', operator: 'equals', value: 'x' },
        { field: 'ok', operator: 'equals', value: '   ' },
        { field: '\t', operator: 'equals', value: '\n' },
      ],
    });
    expect(conditions.filters).toBeUndefined();
  });
});

describe('defaultWebhookAssignee', () => {
  it('starts a Shortcut story rule on anyone and every other event on me', () => {
    expect(defaultWebhookAssignee('story_assigned')).toBe('anyone');
    expect(defaultWebhookAssignee('story_created')).toBe('anyone');
    expect(defaultWebhookAssignee('task_assigned')).toBe('me');
    expect(defaultWebhookAssignee('issue_opened')).toBe('me');
  });
});
