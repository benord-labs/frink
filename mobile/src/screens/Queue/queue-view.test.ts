import { describe, expect, it } from 'vitest';
import type { MobileOverview } from '../../../../src/shared/types/remote/mobile';
import { needsYouCount, queueView } from './queue-view';

const overview: MobileOverview = {
  machineName: 'Mac',
  executionReady: true,
  appVersion: '0.0.13',
  counts: { attention: 2, inbox: 1, running: 1 },
  more: { attention: false, inbox: false, running: false },
  questions: [
    {
      id: 'q1',
      source: 'live',
      chatId: 'chat',
      subChatId: 'sub',
      title: 'Release checks',
      questions: [
        {
          header: 'Env',
          question: 'Which environment should I use?',
          options: [],
          multiSelect: false,
        },
      ],
    },
  ],
  permissions: [
    {
      requestId: 'p1',
      chatId: 'chat',
      subChatId: 'sub',
      title: 'Allow the release command?',
      description: 'Runs the staging checks.',
      supported: true,
    },
  ],
  queue: [
    {
      id: 'duplicate-of-question',
      title: 'Release checks',
      summary: 'Waiting for your choice.',
      status: 'needs_attention',
      section: 'attention',
      chatId: 'chat',
      subChatId: 'sub',
      flowRunId: null,
      projectName: null,
      activityAt: '2026-09-29T00:00:00Z',
    },
    {
      id: 'review',
      title: 'Approve the rollout plan',
      summary: 'Flow review',
      status: 'needs_attention',
      section: 'attention',
      chatId: null,
      subChatId: null,
      flowRunId: 'run',
      projectName: null,
      activityAt: '2026-09-29T00:00:00Z',
    },
    {
      id: 'running',
      title: 'Review incoming issues',
      summary: 'Morning triage',
      status: 'running',
      section: 'running',
      chatId: 'chat',
      subChatId: 'sub',
      flowRunId: 'run',
      projectName: null,
      activityAt: '2026-09-29T00:00:00Z',
    },
    {
      id: 'next',
      title: 'Index the repository',
      summary: 'Preparing',
      status: 'queued',
      section: 'inbox',
      chatId: null,
      subChatId: null,
      flowRunId: null,
      projectName: null,
      activityAt: '2026-09-29T00:00:00Z',
    },
  ],
};

describe('queue view', () => {
  it('counts each decision once for the tab badge', () => {
    expect(needsYouCount(overview)).toBe(3);
    expect(needsYouCount(undefined)).toBe(0);
  });

  it('shows every section for all work and only the chosen one for a filter', () => {
    const all = queueView(overview, '', 'all');
    expect([all.showAttention, all.showRunning, all.showInbox]).toEqual([true, true, true]);
    const attention = queueView(overview, '', 'attention');
    expect([attention.showAttention, attention.showRunning, attention.showInbox]).toEqual([
      true,
      false,
      false,
    ]);
    const running = queueView(overview, '', 'running');
    expect([running.showAttention, running.showRunning, running.showInbox]).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('hides empty sections while searching instead of claiming everything is done', () => {
    const view = queueView(overview, 'triage', 'all');
    expect(view.showAttention).toBe(false);
    expect(view.running.map((item) => item.id)).toEqual(['running']);
    expect(view.noMatches).toBe(false);
  });

  it('reports no matches only for a search that finds nothing in the chosen filter', () => {
    expect(queueView(overview, 'index', 'running').noMatches).toBe(true);
    expect(queueView(overview, 'index', 'all').noMatches).toBe(false);
    expect(queueView(overview, '', 'running').noMatches).toBe(false);
  });
});
