import { describe, expect, it } from 'vitest';
import { parseConditions } from './parse-conditions';

describe('parseConditions', () => {
  it('returns defaults for empty conditions', () => {
    const result = parseConditions({}, 'email_received', 'gmail');
    expect(result).toEqual({
      assigneeMode: 'me',
      fromStatus: '',
      toStatus: '',
      filters: [],
    });
  });

  it('defaults new Shortcut rules to anyone and preserves an explicitly saved me condition', () => {
    expect(parseConditions({}, 'story_assigned', 'shortcut').assigneeMode).toBe('anyone');
    expect(parseConditions({}, 'story_created', 'shortcut').assigneeMode).toBe('anyone');
    expect(parseConditions({ assignee: 'me' }, 'story_assigned', 'shortcut').assigneeMode).toBe(
      'me',
    );
  });

  it('parses assignee mode for assignee events', () => {
    const result = parseConditions({ assignee: 'anyone' }, 'story_assigned', 'shortcut');
    expect(result.assigneeMode).toBe('anyone');
  });

  it('offers assignee only where the provider flags the event', () => {
    // Stored assignee is honoured only on a flagged event: story_moved and another provider's
    // lookalike id both fall back to the event's default.
    expect(parseConditions({ assignee: 'anyone' }, 'story_moved', 'shortcut').assigneeMode).toBe(
      'me',
    );
    expect(parseConditions({ assignee: 'me' }, 'story_assigned', 'gmail').assigneeMode).toBe(
      'anyone',
    );
  });

  it('ignores assignee for non-assignee events', () => {
    const result = parseConditions({ assignee: 'anyone' }, 'email_received', 'gmail');
    expect(result.assigneeMode).toBe('me');
  });

  it('parses status transitions for state-transition events', () => {
    const result = parseConditions(
      { from_status: 'Started', to_status: 'Done' },
      'story_moved',
      'shortcut',
    );
    expect(result.fromStatus).toBe('Started');
    expect(result.toStatus).toBe('Done');
  });

  it('ignores status for non-state-transition events', () => {
    const result = parseConditions(
      { from_status: 'Started', to_status: 'Done' },
      'email_received',
      'gmail',
    );
    expect(result.fromStatus).toBe('');
    expect(result.toStatus).toBe('');
  });

  it('parses valid filters and skips malformed ones', () => {
    const result = parseConditions(
      {
        filters: [
          { field: 'from', operator: 'equals', value: 'a@b.com' },
          { field: 'bad' },
          'not-an-object',
        ],
      },
      'email_received',
      'gmail',
    );
    expect(result.filters).toHaveLength(1);
    expect(result.filters[0].field).toBe('from');
    expect(result.filters[0].operator).toBe('equals');
    expect(result.filters[0].value).toBe('a@b.com');
  });

  it('keeps an in_list filter with its stored list intact', () => {
    const result = parseConditions(
      { filters: [{ field: 'project_id', operator: 'in_list', value: ['p0', 'p1'] }] },
      'story_created',
      'shortcut',
    );
    expect(result.filters).toEqual([
      { id: expect.any(String), field: 'project_id', operator: 'in_list', value: ['p0', 'p1'] },
    ]);
  });
});
