import { describe, expect, it } from 'vitest';
import { flowSettingsSchema, type RunFirstRow } from '../../types/flow-settings-schema';
import { priorityQueueMode, readyRunFirstRule, runFirstRuleMatches } from './run-first-rule';

const title = (value: string, operator: RunFirstRow['operator'] = 'contains'): RunFirstRow => ({
  detail: 'trigger.story.title',
  operator,
  value,
});

describe('priorityQueueMode', () => {
  it('reads every new run, a rule, or off, with the Flow-wide setting winning', () => {
    expect(priorityQueueMode(undefined)).toBe('off');
    expect(priorityQueueMode({ runFirstWhen: [] })).toBe('off');
    expect(priorityQueueMode({ runFirstWhen: [title('x')] })).toBe('match');
    expect(priorityQueueMode({ runFirst: true, runFirstWhen: [title('x')] })).toBe('every');
  });
});

describe('readyRunFirstRule', () => {
  it('accepts a detail as written in Available variables, braces included', () => {
    const rows = [{ ...title(' [Follow-up] '), detail: ' {{ trigger.story.title }} ' }];
    expect(readyRunFirstRule(rows)).toEqual([
      { path: 'trigger.story.title', operator: 'contains', value: '[Follow-up]' },
    ]);
  });

  it.each([
    ['no rows', []],
    ['a blank value', [title('')]],
    ['a whitespace value', [title('  ')]],
    ['a blank detail', [{ ...title('x'), detail: '' }]],
    ['a detail outside trigger', [{ ...title('x'), detail: 'previous.output' }]],
    ['the bare trigger root', [{ ...title('x'), detail: 'trigger' }]],
    ['a path deeper than five segments', [{ ...title('x'), detail: 'trigger.payload.a.b.c.d' }]],
    ['a malformed path', [{ ...title('x'), detail: 'trigger.story title' }]],
    ['a valid row beside a blank one', [title('x'), title('')]],
  ])('is not ready with %s', (_label, rows) => {
    expect(readyRunFirstRule(rows)).toBeNull();
  });
});

describe('runFirstRuleMatches', () => {
  const read = (values: Record<string, string>) => (path: string) => values[path] ?? null;
  const ready = (rows: RunFirstRow[]) => readyRunFirstRule(rows) ?? [];

  it('matches contains ignoring case, and equals or not_equals exactly', () => {
    const run = read({ 'trigger.story.title': '[Follow-up] Retry the card' });
    expect(runFirstRuleMatches(ready([title('[follow-up]')]), run)).toBe(true);
    expect(runFirstRuleMatches(ready([title('[Follow-up] Retry the card', 'equals')]), run)).toBe(
      true,
    );
    expect(runFirstRuleMatches(ready([title('[follow-up] retry the card', 'equals')]), run)).toBe(
      false,
    );
    expect(runFirstRuleMatches(ready([title('Draft', 'not_equals')]), run)).toBe(true);
  });

  it('needs every row to match', () => {
    const run = read({ 'trigger.story.title': 'Fix login', 'trigger.story.action': 'update' });
    const action = { detail: 'trigger.story.action', operator: 'equals' as const, value: 'update' };
    expect(runFirstRuleMatches(ready([action, title('fix')]), run)).toBe(true);
    expect(runFirstRuleMatches(ready([action, title('[Follow-up]')]), run)).toBe(false);
  });

  it('never matches a detail the run does not have, even with not_equals', () => {
    expect(runFirstRuleMatches(ready([title('Draft', 'not_equals')]), read({}))).toBe(false);
  });
});

describe('Flow settings runFirstWhen', () => {
  const row = title('[Follow-up]');

  it('keeps rows as typed, blank ones included, so a save never drops one', () => {
    const parsed = flowSettingsSchema.safeParse({ runFirstWhen: [row, title('')] });
    expect(parsed.success && parsed.data?.runFirstWhen).toEqual([row, title('')]);
  });

  it('refuses an unknown operator, an eleventh row and over-long text', () => {
    const refused = [
      [{ ...row, operator: 'starts_with' }],
      Array.from({ length: 11 }, () => row),
      [{ ...row, value: 'x'.repeat(501) }],
    ];
    for (const runFirstWhen of refused) {
      expect(flowSettingsSchema.safeParse({ runFirstWhen }).success).toBe(false);
    }
  });
});
