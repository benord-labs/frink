import { describe, expect, it } from 'vitest';
import {
  extractFlowWebhookBindingFromGraph,
  matchesConditions,
  unreadableWebhookFilterMessage,
  type WebhookBinding,
  type WebhookEventData,
} from './webhook-match';

function event(extra: Record<string, unknown> = {}): WebhookEventData {
  return { provider: 'shortcut', eventType: 'story_moved', externalUserId: 'member-1', ...extra };
}

describe('matchesConditions', () => {
  it('matches all events when conditions are empty', () => {
    expect(matchesConditions({}, event())).toBe(true);
  });

  describe('state transitions', () => {
    it('matches to_status when it equals newStatus', () => {
      expect(matchesConditions({ to_status: 'Done' }, event({ newStatus: 'Done' }))).toBe(true);
    });

    it('rejects to_status mismatch', () => {
      expect(matchesConditions({ to_status: 'Done' }, event({ newStatus: 'In Progress' }))).toBe(
        false,
      );
    });

    it('matches a state literally named any', () => {
      expect(matchesConditions({ to_status: 'any' }, event({ newStatus: 'any' }))).toBe(true);
      expect(matchesConditions({ to_status: 'any' }, event({ newStatus: 'whatever' }))).toBe(false);
    });

    it('matches from_status against old_status fallback key', () => {
      expect(matchesConditions({ from_status: 'Todo' }, event({ old_status: 'Todo' }))).toBe(true);
    });
  });

  describe('assignee', () => {
    it("assignee=me matches when owner_ids includes the user's external id", () => {
      expect(
        matchesConditions({ assignee: 'me' }, event({ owner_ids: ['member-1'] }), 'member-1'),
      ).toBe(true);
    });

    it('assignee=me rejects when external id missing', () => {
      expect(matchesConditions({ assignee: 'me' }, event({ owner_ids: ['member-1'] }))).toBe(false);
    });

    it('assignee=me rejects when owner_ids excludes the user', () => {
      expect(
        matchesConditions({ assignee: 'me' }, event({ owner_ids: ['someone-else'] }), 'member-1'),
      ).toBe(false);
    });

    it('assignee=anyone matches with at least one owner', () => {
      expect(matchesConditions({ assignee: 'anyone' }, event({ owner_ids: ['x'] }))).toBe(true);
    });

    it('assignee=anyone rejects with no owners', () => {
      expect(matchesConditions({ assignee: 'anyone' }, event({ owner_ids: [] }))).toBe(false);
    });
  });

  describe('filters', () => {
    it('equals on repo_full_name is case-insensitive', () => {
      const conditions = {
        filters: [{ field: 'repo_full_name', operator: 'equals', value: 'acme/API' }],
      };
      expect(matchesConditions(conditions, event({ repo_full_name: 'acme/api' }))).toBe(true);
    });

    it('not_equals on repo_full_name is case-insensitive', () => {
      const conditions = {
        filters: [{ field: 'repo_full_name', operator: 'not_equals', value: 'acme/API' }],
      };
      expect(matchesConditions(conditions, event({ repo_full_name: 'acme/api' }))).toBe(false);
    });

    it('contains matches a substring case-insensitively', () => {
      const conditions = { filters: [{ field: 'title', operator: 'contains', value: 'bug' }] };
      expect(matchesConditions(conditions, event({ title: 'Critical BUG report' }))).toBe(true);
    });

    it('equals and contains match any element of an array field', () => {
      const data = event({ labels: ['performance', 'backend'] });
      const filters = (operator: 'equals' | 'contains', value: string) => ({
        filters: [{ field: 'labels', operator, value }],
      });
      expect(matchesConditions(filters('equals', 'backend'), data)).toBe(true);
      expect(matchesConditions(filters('equals', 'frontend'), data)).toBe(false);
      expect(matchesConditions(filters('contains', 'PERF'), data)).toBe(true);
    });

    it.each(['equals', 'not_equals', 'contains', 'in_list'])(
      'a malformed persisted filter never matches (%s)',
      (operator) => {
        const data = event({ title: 'anything', missing: null });
        expect(
          matchesConditions({ filters: [{ field: 'title', operator, value: null }] }, data),
        ).toBe(false);
        expect(
          matchesConditions({ filters: [{ field: 'missing', operator, value: null }] }, data),
        ).toBe(false);
      },
    );

    it('a filters value that is not a list never matches', () => {
      expect(matchesConditions({ filters: { field: 'title' } }, event({ title: 'x' }))).toBe(false);
      expect(matchesConditions({ filters: 'title' }, event({ title: 'x' }))).toBe(false);
    });

    it('in_list matches when value is in the list', () => {
      const conditions = {
        filters: [{ field: 'label', operator: 'in_list', value: ['p0', 'p1'] }],
      };
      expect(matchesConditions(conditions, event({ label: 'p1' }))).toBe(true);
      expect(matchesConditions(conditions, event({ label: 'p2' }))).toBe(false);
    });
  });

  describe('legacy direct-field matching', () => {
    it('matches a direct string field', () => {
      expect(matchesConditions({ storyName: 'Ship it' }, event({ storyName: 'Ship it' }))).toBe(
        true,
      );
      expect(matchesConditions({ storyName: 'Ship it' }, event({ storyName: 'Other' }))).toBe(
        false,
      );
    });

    it('_contains key matches a substring', () => {
      expect(matchesConditions({ title_contains: 'urgent' }, event({ title: 'is URGENT' }))).toBe(
        true,
      );
    });

    it('array expected value matches when scalar actual is included', () => {
      expect(matchesConditions({ status: ['a', 'b'] }, event({ status: 'b' }))).toBe(true);
      expect(matchesConditions({ status: ['a', 'b'] }, event({ status: 'c' }))).toBe(false);
    });
  });
});

describe('extractFlowWebhookBindingFromGraph', () => {
  const intg = '550e8400-e29b-41d4-a716-446655440099';

  it('returns null for a non-object graph', () => {
    expect(extractFlowWebhookBindingFromGraph(null, intg, 'story_moved')).toBeNull();
  });

  it('returns null when no webhook_trigger matches integration + event', () => {
    const graph = {
      nodes: [
        {
          id: 'w',
          blockType: 'webhook_trigger',
          config: { integrationId: 'aaa', eventType: 'other' },
        },
      ],
    };
    expect(extractFlowWebhookBindingFromGraph(graph, intg, 'story_moved')).toBeNull();
  });

  it('returns conditions and actionConfig on match', () => {
    const graph = {
      nodes: [
        {
          id: 'w',
          blockType: 'webhook_trigger',
          config: {
            integrationId: intg,
            eventType: 'story_moved',
            conditions: { assignee: 'me' },
            actionConfig: { project_id: 'p1' },
          },
        },
      ],
    };
    expect(extractFlowWebhookBindingFromGraph(graph, intg, 'story_moved')).toEqual({
      conditions: { assignee: 'me' },
      actionConfig: { project_id: 'p1' },
    });
  });

  it('defaults missing conditions/actionConfig to empty objects', () => {
    const graph = {
      nodes: [
        {
          id: 'w',
          blockType: 'webhook_trigger',
          config: { integrationId: intg, eventType: 'story_assigned' },
        },
      ],
    };
    expect(extractFlowWebhookBindingFromGraph(graph, intg, 'story_assigned')).toEqual({
      conditions: {},
      actionConfig: {},
    });
  });
});

describe('unreadableWebhookFilterMessage', () => {
  const ok = { field: 'storyName', operator: 'contains', value: 'bug' };
  const messageFor = (conditions: WebhookBinding['conditions']) =>
    unreadableWebhookFilterMessage('W', { conditions });

  it('names an unknown operator', () => {
    expect(messageFor({ filters: [{ ...ok, operator: 'regex' }] })).toBe(
      `Webhook trigger "W" filter 1 (unknown operator 'regex') can't match any event, so this trigger will never start. Fix or remove it.`,
    );
  });

  it('names a value that is neither text nor a list of text', () => {
    expect(messageFor({ filters: [{ ...ok, value: 5 }] })).toContain(
      'filter 1 (value must be text or a list of text)',
    );
  });

  it('flags filters that are not a list', () => {
    for (const filters of [{ 0: ok }, 'storyName=bug']) {
      expect(messageFor({ filters })).toBe(
        'Webhook trigger "W" filters must be a list, so this trigger will never start. Fix or remove them.',
      );
    }
  });

  // The schema accepts these, but the matcher's operators can never pass them.
  it('flags an operator paired with the wrong kind of value', () => {
    expect(messageFor({ filters: [{ ...ok, value: ['bug'] }] })).toContain(
      'filter 1 (contains needs a text value, not a list)',
    );
    expect(messageFor({ filters: [{ ...ok, operator: 'in_list' }] })).toContain(
      'filter 1 (in_list needs a list value)',
    );
    expect(messageFor({ filters: [{ ...ok, operator: 'in_list', value: [] }] })).toContain(
      'filter 1 (in_list needs at least one value)',
    );
  });

  it('names only the bad filter in a list', () => {
    expect(messageFor({ filters: [ok, { operator: 'equals', value: 'x' }, ok] })).toBe(
      `Webhook trigger "W" filter 2 (no field) can't match any event, so this trigger will never start. Fix or remove it.`,
    );
    expect(messageFor({ filters: [{ field: 'f', value: 'x' }] })).toContain('(no operator)');
  });

  it('names at most five filters', () => {
    const message = messageFor({ filters: Array(7).fill(null) });
    expect(message).toContain('filter 5 (not a filter) and 2 more');
    expect(message).not.toContain('filter 6');
    expect(message).toContain('Fix or remove them.');
  });

  it('stays silent for valid, empty or absent filters', () => {
    const valid = [ok, { field: 'labels', operator: 'in_list', value: ['a', 'b'] }];
    expect(messageFor({ filters: valid })).toBeNull();
    expect(messageFor({ filters: [] })).toBeNull();
    expect(messageFor({ assignee: 'me' })).toBeNull();
    expect(unreadableWebhookFilterMessage('W', undefined)).toBeNull();
  });

  // Agents add keys the editor never writes; the matcher ignores them, so no warning either.
  it('does not flag a readable filter that carries extra keys', () => {
    expect(messageFor({ filters: [{ ...ok, id: 'f1', caseSensitive: true }] })).toBeNull();
    expect(matchesConditions({ filters: [{ ...ok, id: 'f1' }] }, event({ storyName: 'bug' }))).toBe(
      true,
    );
  });

  // The binding reads non-object conditions as {}, which matches every event.
  it('does not flag conditions that are not an object', () => {
    for (const conditions of [['x'], 'storyName=bug', null]) {
      expect(unreadableWebhookFilterMessage('W', { conditions })).toBeNull();
    }
  });

  it('agrees with the matcher: every flagged list blocks an event that a valid one lets through', () => {
    const story = event({ storyName: 'bug report', labels: ['a'] });
    expect(matchesConditions({ filters: [ok] }, story)).toBe(true);
    for (const filters of [[{ ...ok, operator: 'regex' }], [{ ...ok, value: ['bug'] }], {}]) {
      expect(messageFor({ filters })).not.toBeNull();
      expect(matchesConditions({ filters }, story)).toBe(false);
    }
  });
});
