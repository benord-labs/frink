import { describe, expect, it } from 'vitest';
import type { MobileRunNode } from '@frink/shared/types/remote/mobile';
import {
  isLive,
  isTerminal,
  plainDetail,
  runHeadline,
  runElapsed,
  runProgress,
  runWhen,
  stepStatus,
  stepTrailing,
} from './run-view';

const NOW = Date.parse('2026-09-29T14:30:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function node(overrides: Partial<MobileRunNode>): MobileRunNode {
  return {
    id: 'n',
    label: 'Step',
    status: 'pending',
    detail: '',
    chatId: null,
    subChatId: null,
    actions: [],
    actionToken: 'a'.repeat(64),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('run states', () => {
  it('knows which runs are over and which are moving', () => {
    expect(['completed', 'failed', 'cancelled'].every(isTerminal)).toBe(true);
    expect(isTerminal('paused')).toBe(false);
    expect(isLive('running')).toBe(true);
    expect(isLive('awaiting_input')).toBe(false);
    expect(isLive(null)).toBe(false);
  });

  it('treats an unreached step as not started rather than starting', () => {
    expect(stepStatus(node({})).word).toBe('Not started');
    expect(stepStatus(node({ startedAt: ago(1) })).word).toBe('Starting');
  });
});

describe('stepTrailing', () => {
  it('counts up while a step runs and shows what a finished step took', () => {
    expect(stepTrailing(node({ status: 'running', startedAt: ago(2) }), NOW)).toEqual({
      text: '2m 0s',
      tone: 'live',
    });
    expect(
      stepTrailing(node({ status: 'completed', startedAt: ago(9), completedAt: ago(3) }), NOW),
    ).toEqual({ text: '6m 0s', tone: 'quiet' });
  });

  it('stays empty for instant or unreached steps and names the rest', () => {
    expect(
      stepTrailing(node({ status: 'completed', startedAt: ago(1), completedAt: ago(1) }), NOW),
    ).toBeNull();
    expect(stepTrailing(node({}), NOW)).toBeNull();
    expect(stepTrailing(node({ status: 'awaiting_input' }), NOW)).toEqual({
      text: 'Waiting for you',
      tone: 'attention',
    });
  });
});

describe('run summary', () => {
  it('reports the current step, then the total', () => {
    const steps = (...statuses: string[]) => ({
      nodes: statuses.map((status) => node({ status })),
    });
    expect(runProgress(steps('completed', 'running', 'pending'))).toBe('Step 2 of 3');
    expect(runProgress(steps('completed', 'skipped'))).toBe('2 steps');
    expect(runProgress(steps())).toBe('Getting ready');
  });

  it('measures elapsed time until the run completes', () => {
    expect(runElapsed({ startedAt: ago(9), completedAt: null }, NOW)).toBe('9m 0s');
    expect(runElapsed({ startedAt: ago(9), completedAt: ago(7) }, NOW)).toBe('2m 0s');
  });

  it('names nearby days in words', () => {
    const now = new Date(2026, 8, 29, 15, 0);
    expect(runWhen(new Date(2026, 8, 29, 9, 5).toISOString(), now)).toMatch(/^Today, /);
    expect(runWhen(new Date(2026, 8, 28, 9, 5).toISOString(), now)).toMatch(/^Yesterday, /);
    expect(runWhen(new Date(2026, 8, 20, 9, 5).toISOString(), now)).not.toMatch(/Today|2026/);
    expect(runWhen(new Date(2025, 8, 20, 9, 5).toISOString(), now)).toMatch(/2025/);
  });

  it('flattens Markdown to one readable line', () => {
    expect(plainDetail('Updated **14** packages in `bun.lock`')).toBe(
      'Updated 14 packages in bun.lock',
    );
  });

  it('keeps the first line of a heading followed by a list', () => {
    expect(plainDetail('\n## Announcement plan\n\n1. Post the notes\n2. Share a thread')).toBe(
      'Announcement plan',
    );
    expect(plainDetail('- Labelled 4 issues\n- Closed 2')).toBe('Labelled 4 issues');
    expect(plainDetail('  \n')).toBe('');
  });
});

describe('runHeadline', () => {
  const run = (status: string, nodes: MobileRunNode[]) => ({ status, nodes });
  it('says a paused run with a decision is waiting for you', () => {
    expect(
      runHeadline(
        run('paused', [node({ status: 'completed' }), node({ status: 'awaiting_input' })]),
      ).word,
    ).toBe('Waiting for you');
    expect(runHeadline(run('paused', [node({ status: 'failed', actions: ['skip'] })])).word).toBe(
      'Waiting for you',
    );
  });

  it('says a paused run with a working step is running', () => {
    expect(runHeadline(run('paused', [node({ status: 'running' })]))).toMatchObject({
      word: 'Running',
      tone: 'live',
    });
  });

  it('otherwise reports the run itself', () => {
    expect(runHeadline(run('paused', [node({ status: 'completed' })])).word).toBe('Paused');
    expect(runHeadline(run('completed', [node({ status: 'completed' })])).word).toBe('Done');
    expect(runHeadline(run('failed', [node({ status: 'failed' })])).word).toBe('Failed');
  });
});
