import { describe, expect, it } from 'vitest';
import type { MobileOverview, MobileQueueItem } from '@frink/shared/types/remote/mobile';
import { expandedLimits, needsYouCount, queueSections } from './queue-view';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 29, 12, 60 - minutes)).toISOString();

function item(overrides: Partial<MobileQueueItem> & Pick<MobileQueueItem, 'id'>): MobileQueueItem {
  return {
    title: overrides.id,
    summary: '',
    status: 'needs_attention',
    section: 'attention',
    chatId: null,
    subChatId: null,
    flowRunId: null,
    projectName: null,
    activityAt: at(1),
    actions: [],
    ...overrides,
  };
}

const overview: MobileOverview = {
  machineName: 'Mac',
  executionReady: true,
  appVersion: '0.0.13',
  agents: { running: 1, needsYou: 2 },
  questions: [
    {
      id: 'q1',
      source: 'live',
      chatId: 'chat',
      subChatId: 'sub',
      title: 'Release checks',
      questions: [
        { header: 'Env', question: 'Which environment should I use?', options: [], multiSelect: false },
      ],
    },
  ],
  permissions: [
    {
      requestId: 'p1',
      chatId: 'other',
      subChatId: 'other-sub',
      title: 'Allow the release command?',
      description: 'Runs the staging checks.',
      supported: true,
    },
  ],
  queue: [
    item({
      id: 'duplicate-of-question',
      title: 'Release checks',
      chatId: 'chat',
      subChatId: 'sub',
      projectName: 'frink',
      activityAt: at(3),
    }),
    item({
      id: 'old-failure',
      status: 'failed',
      flowRunId: 'run-a',
      summary: 'Step 3 of 5 failed: rate limit',
      activityAt: at(40),
    }),
    item({
      id: 'new-plan',
      status: 'plan_ready',
      chatId: 'c2',
      subChatId: 's2',
      summary: 'Plan is ready for your review',
      activityAt: at(2),
    }),
    item({
      id: 'finished',
      status: 'done',
      chatId: 'c3',
      subChatId: 's3',
      summary: '4 files',
      actions: ['completeTask'],
    }),
    item({
      id: 'flow-running',
      section: 'running',
      status: 'running',
      chatId: 'c4',
      flowRunId: 'run-b',
      projectName: 'design-system',
      summary: 'Step 2 of 4 · Update packages',
    }),
    item({ id: 'next', section: 'inbox', status: 'pending', summary: 'From Gmail' }),
  ],
  counts: { attention: 4, running: 1, inbox: 1 },
  more: { attention: false, running: false, inbox: false },
};

const section = (data: MobileOverview, key: string) =>
  queueSections(data).find((entry) => entry.key === key);

describe('needsYouCount', () => {
  it('counts each decision once, finished work included', () => {
    // q1 (its task is the same decision) + p1 + old-failure + new-plan + finished.
    expect(needsYouCount(overview)).toBe(5);
    expect(needsYouCount(undefined)).toBe(0);
  });
});

describe('queueSections', () => {
  it('orders the sections and drops empty ones', () => {
    expect(queueSections(overview).map((entry) => entry.key)).toEqual([
      'needsYou',
      'running',
      'review',
      'upNext',
    ]);
    const onlyRunning = { ...overview, questions: [], permissions: [], queue: [overview.queue[4]] };
    expect(queueSections(onlyRunning).map((entry) => entry.key)).toEqual(['running']);
  });

  it('puts decisions first, then tasks newest first', () => {
    expect(section(overview, 'needsYou')?.rows.map((row) => row.key)).toEqual([
      'question:q1',
      'permission:p1',
      'new-plan',
      'old-failure',
    ]);
  });

  it('opens a decision at its question, a Flow item at its run and a task at its chat', () => {
    const [question, , plan, failure] = section(overview, 'needsYou')!.rows;
    expect(question.target).toEqual({
      screen: 'Chat',
      id: 'chat',
      subChatId: 'sub',
      decisionTarget: { type: 'question', id: 'q1' },
    });
    expect(plan.target).toEqual({ screen: 'Chat', id: 'c2', subChatId: 's2' });
    expect(failure.target).toEqual({ screen: 'Run', id: 'run-a' });
    expect(section(overview, 'upNext')?.rows[0].target).toBeNull();
  });

  it('writes line two as kind, project and what is needed', () => {
    const [question, permission] = section(overview, 'needsYou')!.rows;
    expect(question.title).toBe('Which environment should I use?');
    expect(question.detail).toBe('Chat · frink · Wants your answer');
    expect(question.activityAt).toBe(at(3));
    expect(permission.detail).toBe('Chat · Wants your approval');
    expect(section(overview, 'running')?.rows[0]).toMatchObject({
      kind: 'flow',
      detail: 'Flow · design-system · Step 2 of 4',
    });
    expect(section(overview, 'upNext')?.rows[0]).toMatchObject({ kind: 'inbox', detail: 'From Gmail' });
  });

  it('keeps line two to what the status word does not already say', () => {
    const [, , plan, failure] = section(overview, 'needsYou')!.rows;
    expect(plan.detail).toBe('Chat');
    expect(failure.detail).toBe('Flow · Step 3 of 5 failed: rate limit');
    expect(section(overview, 'upNext')?.rows[0].status.word).toBe('Queued');
    expect(section(overview, 'review')?.rows[0].detail).toBe('Chat');
  });

  it('colours by state: amber needs you, red failed, green live, finished work muted', () => {
    const tones = (key: string) => section(overview, key)!.rows.map((row) => row.status.tone);
    expect(tones('needsYou')).toEqual(['attention', 'attention', 'attention', 'danger']);
    expect(tones('running')).toEqual(['live']);
    expect(section(overview, 'review')?.rows[0].status).toMatchObject({ word: 'Ready', tone: 'quiet' });
  });

  it('gives every Needs you row room for a two-line title', () => {
    const emphasis = (key: string) => section(overview, key)!.rows.map((row) => row.emphasis);
    expect(emphasis('needsYou')).toEqual([true, true, true, true]);
    expect([...emphasis('running'), ...emphasis('review'), ...emphasis('upNext')]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('carries the computer’s actions onto task rows, never onto decisions', () => {
    expect(section(overview, 'review')?.rows[0].actions).toEqual(['completeTask']);
    expect(section(overview, 'needsYou')?.rows.map((row) => row.actions)).toEqual([[], [], [], []]);
  });

  it('counts the rows it was sent and offers more when the computer holds more', () => {
    const paged = {
      ...overview,
      counts: { attention: 9, running: 12, inbox: 1 },
      more: { attention: true, running: true, inbox: false },
    };
    // Unsent attention rows may be finished work, so Needs you counts the rows it holds.
    expect(section(paged, 'needsYou')).toMatchObject({ total: 4, hasMore: true });
    expect(section(paged, 'running')).toMatchObject({ total: 12, hasMore: true });
    expect(section(paged, 'review')).toMatchObject({ total: 1, hasMore: true });
    expect(section(paged, 'upNext')).toMatchObject({ total: 1, hasMore: false });
  });
});

describe('expandedLimits', () => {
  const counts = { attention: 30, running: 3, inbox: 500 };

  it('asks for nothing extra until a section is expanded', () => {
    expect(expandedLimits(new Set(), counts)).toEqual({});
  });

  it('pages the whole attention list for either attention section, whichever expands last', () => {
    expect(expandedLimits(new Set(['needsYou', 'review'] as const), counts)).toEqual({ attention: 30 });
    expect(expandedLimits(new Set(['review', 'needsYou'] as const), counts)).toEqual({ attention: 30 });
  });

  it('follows the live count and caps at the largest page', () => {
    expect(expandedLimits(new Set(['running', 'upNext'] as const), counts)).toEqual({
      running: 3,
      inbox: 200,
    });
  });
});
