import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TriggerContext, TriggerSource } from '../types/trigger-context';
import { buildTriggerSummary, type TriggerSummary } from './trigger-summary';

const FIX = join(process.cwd(), 'src/shared/webhooks/extractors/__fixtures__');
const load = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIX, rel), 'utf8')) as Record<string, unknown>;

function ctx(source: TriggerSource, fullContent: Record<string, unknown>): TriggerContext {
  return {
    source,
    sourceAccountId: 'acc',
    eventType: `${source}_event`,
    triggeredBy: { name: 'Benji' },
    timestamp: '2026-06-01T12:00:00.000Z',
    fullContent,
  } as TriggerContext;
}

const fieldVal = (s: TriggerSummary, label: string): string | number | undefined =>
  s.fields.find((f) => f.label === label)?.value;
const fieldHref = (s: TriggerSummary, label: string): string | undefined =>
  s.fields.find((f) => f.label === label)?.href;

describe('buildTriggerSummary — shortcut (raw webhook + references[])', () => {
  it('story.created → title, type/state/project/epic/labels/owners from references, link', () => {
    const s = buildTriggerSummary(ctx('shortcut', load('shortcut/story.created.json')));
    expect(s.provider).toBe('Shortcut');
    expect(s.title).toBe('[platform] Add Postgres connection pool warm-up');
    expect(fieldVal(s, 'Type')).toBe('feature');
    expect(fieldVal(s, 'State')).toBe('Ready for Dev');
    expect(fieldVal(s, 'Project')).toBe('Platform');
    expect(fieldVal(s, 'Epic')).toBe('Database reliability');
    expect(fieldVal(s, 'Labels')).toBe('performance, backend');
    expect(fieldVal(s, 'Owners')).toBe('Benji Norval');
    expect(fieldVal(s, 'Story ID')).toBe('#4821');
    expect(fieldHref(s, 'Story ID')).toBe('https://app.shortcut.com/slice/story/4821');
    expect(s.description).toContain('cold-start latency');
  });

  it('story.moved → changes State from→to via references', () => {
    const s = buildTriggerSummary(ctx('shortcut', load('shortcut/story.moved.json')));
    expect(s.changes).toEqual(
      expect.arrayContaining([{ label: 'State', from: 'Ready for Dev', to: 'In Development' }]),
    );
    expect(fieldVal(s, 'State')).toBe('In Development'); // current state = changes.new
  });

  it('story.assigned → changes Owners added (member name resolved)', () => {
    const s = buildTriggerSummary(ctx('shortcut', load('shortcut/story.assigned.json')));
    expect(s.changes?.some((c) => c.label === 'Owners added' && c.to?.includes('Benji'))).toBe(
      true,
    );
  });
});

describe('buildTriggerSummary — gmail (slim extractor shape, no body)', () => {
  it('renders subject/from/snippet, no description', () => {
    const s = buildTriggerSummary(
      ctx('gmail', {
        from: 'Ana <ana@b.dev>',
        to: 'me@b.dev',
        subject: 'Quarterly tables',
        snippet: 'rows attached',
      }),
    );
    expect(s.title).toBe('Quarterly tables');
    expect(fieldVal(s, 'From')).toBe('Ana');
    expect(s.subtitle).toBe('rows attached');
    expect(s.description).toBeUndefined();
  });
});

describe('buildTriggerSummary — linear (declarative alias fallback, no bespoke builder)', () => {
  it('issue_assigned → title from the alias map, url promoted to the card link', () => {
    const s = buildTriggerSummary(ctx('linear', load('linear/issue_assigned.json')));
    expect(s.title).toBe('Retry queue drains twice on reconnect');
    expect(s.link).toBe(
      'https://linear.app/acme/issue/ENG-412/retry-queue-drains-twice-on-reconnect',
    );
    // Promoted fields must not ALSO render as rows, or the card repeats itself.
    expect(fieldVal(s, 'Issue URL')).toBeUndefined();
    expect(fieldVal(s, 'Issue title')).toBeUndefined();
    expect(fieldVal(s, 'Issue key')).toBe('ENG-412');
    expect(fieldVal(s, 'Priority')).toBe('High');
  });

  it('comment_created → the comment body renders, issue-only aliases stay absent', () => {
    const s = buildTriggerSummary(ctx('linear', load('linear/comment_created.json')));
    expect(fieldVal(s, 'Comment body')).toContain('Reproduced on staging');
    expect(fieldVal(s, 'Issue key')).toBeUndefined();
  });

  it('drops a url whose origin is not the provider, rather than rendering it raw', () => {
    // resolveSafeLink is the same origin allowlist the bespoke builders use; a
    // rejected url must vanish, never fall through to an <a href> or a text row.
    const s = buildTriggerSummary(
      ctx('linear', { action: 'create', type: 'Issue', url: 'https://evil.example/pwn', data: {} }),
    );
    expect(s.link).toBeUndefined();
    expect(fieldVal(s, 'Issue URL')).toBeUndefined();
  });

  it('survives an event carrying none of its aliases', () => {
    const s = buildTriggerSummary(ctx('linear', {}));
    expect(s.title).toBeUndefined();
    expect(s.link).toBeUndefined();
    // Context metadata (Event / Triggered by / at) always renders; what must not
    // appear is an empty row per unresolved alias.
    for (const label of ['Issue title', 'Issue key', 'Issue URL', 'Comment body', 'Priority']) {
      expect(fieldVal(s, label)).toBeUndefined();
    }
  });
});

describe('buildTriggerSummary — empty + scalar safety', () => {
  it('empty fullContent → only envelope fields, no title, no crash', () => {
    const s = buildTriggerSummary(ctx('shortcut', {}));
    expect(s.title).toBeUndefined();
    // envelope rows still render; no provider rows
    expect(fieldVal(s, 'Event')).toBe('shortcut_event');
    expect(fieldVal(s, 'Triggered by')).toBe('Benji');
    expect(s.fields.every((f) => typeof f.value === 'string' || typeof f.value === 'number')).toBe(
      true,
    );
  });

  it('keeps a legitimate numeric 0 (estimate), drops empty strings', () => {
    const s = buildTriggerSummary(
      ctx('shortcut', {
        primary_id: 1,
        actions: [{ entity_type: 'story', name: 'X', estimate: 0 }],
      }),
    );
    expect(fieldVal(s, 'Estimate')).toBe(0);
  });
});

describe('buildTriggerSummary — ClickUp raw signed webhook', () => {
  it('shows the task ID and event from the body ClickUp sends', () => {
    const summary = buildTriggerSummary(
      ctx('clickup', { event: 'taskCreated', task_id: '86a123', webhook_id: 'hook-clickup' }),
    );
    expect(summary.provider).toBe('ClickUp');
    expect(fieldVal(summary, 'Task ID')).toBe('86a123');
    expect(fieldVal(summary, 'Event')).toBe('taskCreated');
    expect(summary.link).toBeUndefined();
  });
});
