import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyProviderAliases } from './provider-trigger-aliases';

describe('applyProviderAliases', () => {
  it('resolves Shortcut friendly aliases from the raw webhook body', () => {
    const out = applyProviderAliases({
      source: 'shortcut',
      payload: {
        primary_id: 4821,
        actions: [
          { name: 'Add connection pool warm-up', action: 'update', app_url: 'https://x/4821' },
        ],
      },
    });
    expect(out.story).toEqual({
      title: 'Add connection pool warm-up',
      id: 4821,
      url: 'https://x/4821',
      action: 'update',
    });
  });

  it('renders an absent declared alias as empty (never a literal {{...}})', () => {
    const out = applyProviderAliases({ source: 'shortcut', payload: { primary_id: 7 } });
    const story = out.story as Record<string, unknown>;
    expect(story.id).toBe(7);
    // Present-but-absent path → empty string, so {{trigger.story.title}} renders "" not literal.
    expect(story.title).toBe('');
    expect(story.url).toBe('');
  });

  it('matches the editor by lowercasing the provider (no chip/resolve divergence)', () => {
    const out = applyProviderAliases({
      source: 'Shortcut',
      payload: { primary_id: 1, actions: [{ name: 'X' }] },
    });
    expect((out.story as Record<string, unknown>).title).toBe('X');
  });

  it('is a no-op for an unknown provider or missing payload', () => {
    expect(applyProviderAliases({ source: 'unknownprov', payload: { x: 1 } })).toEqual({
      source: 'unknownprov',
      payload: { x: 1 },
    });
    expect(applyProviderAliases({ source: 'shortcut' })).toEqual({ source: 'shortcut' });
  });
});

// Ground-truth: run the resolver against the REAL captured webhook fixtures so the
// alias paths are proven correct against production shapes — a wrong/drifted path
// fails here, and refreshing a fixture turns into a drift alarm.
describe('applyProviderAliases — against captured production fixtures', () => {
  const FIXTURES = join(process.cwd(), 'src/shared/webhooks/extractors/__fixtures__');
  const load = (rel: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8')) as Record<string, unknown>;
  it('shortcut story fixture → story.title/id/url resolve', () => {
    const body = load('shortcut/story.assigned.json');
    const out = applyProviderAliases({ source: 'shortcut', payload: body }) as {
      story: Record<string, unknown>;
    };
    const action0 = (body.actions as Array<Record<string, unknown>>)[0];
    expect(out.story.title).toBe(action0.name);
    expect(out.story.id).toBe(body.primary_id);
    expect(out.story.url).toBe(action0.app_url);
  });
});

describe('ClickUp raw webhook aliases', () => {
  it('exposes the task ID and event without claiming an enriched task body', () => {
    const payload = { event: 'taskCreated', task_id: '86a123', webhook_id: 'hook-clickup' };
    const out = applyProviderAliases({ source: 'clickup', payload });
    expect(out).toMatchObject({
      task: { id: '86a123' },
      webhook: { id: 'hook-clickup' },
      action: 'taskCreated',
    });
    expect(out).not.toHaveProperty('task.title');
  });
});
