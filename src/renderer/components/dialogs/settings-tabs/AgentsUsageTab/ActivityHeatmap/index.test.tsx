// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageHistory, UsageHistoryDay } from '../../../../../../shared/types/usage-history';
import { UsageInsights } from '../UsageInsights';
import { UsageStats } from '../UsageStats';
import { ActivityHeatmap } from './index';

afterEach(cleanup);

function day(date: string, claude: number, codex: number): UsageHistoryDay {
  const level = (v: number) => (v > 0 ? 4 : 0);
  return {
    date,
    claude,
    codex,
    chats: { claude: claude > 0 ? 2 : 0, codex: codex > 0 ? 1 : 0 },
    level: { all: level(claude + codex), claude: level(claude), codex: level(codex) },
  };
}

function history(overrides: Partial<UsageHistory> = {}): UsageHistory {
  const week = [day('2026-09-20', 0, 0), day('2026-09-21', 1_500, 0), day('2026-09-22', 0, 700)];
  return {
    since: '2026-09-21',
    totalTokens: 2_200,
    weeks: [[...week, day('', 0, 0), day('', 0, 0), day('', 0, 0), day('', 0, 0)]],
    busiestDay: { date: '2026-09-21', tokens: 1_500 },
    currentStreak: 2,
    longestStreak: 2,
    busiestHour: 22,
    topModel: { model: 'Opus 5', share: 0.71 },
    conversations: 3,
    integrations: [{ kind: 'skill', name: 'commit-gates', conversations: 1 }],
    providers: { claude: true, codex: true },
    updatedAt: 0,
    ...overrides,
  };
}

describe('ActivityHeatmap', () => {
  it("shows a day's tokens and chats on hover, for the chosen provider", () => {
    const { container } = render(<ActivityHeatmap history={history()} />);
    const tuesday = container.querySelectorAll('[role="img"] span')[2];
    fireEvent.mouseEnter(tuesday);
    expect(screen.getByRole('tooltip').textContent).toContain('700 tokens · 1 chat');
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
    fireEvent.mouseEnter(tuesday);
    expect(screen.getByRole('tooltip').textContent).toContain('No activity');
  });

  it('says what the colours measure', () => {
    render(<ActivityHeatmap history={history()} />);
    expect(screen.getByText('Tokens per day')).toBeTruthy();
  });

  it('hides the provider filter when only one provider has been used', () => {
    render(<ActivityHeatmap history={history({ providers: { claude: true, codex: false } })} />);
    expect(screen.queryByRole('button', { name: 'OpenAI' })).toBeNull();
  });
});

describe('UsageStats and UsageInsights', () => {
  it('shows the headline numbers and what chats used most, in plain words', () => {
    render(
      <>
        <UsageStats history={history()} />
        <UsageInsights
          history={history()}
          activity={{ flowRuns: 12, tasksFinished: 4, topFlows: [{ name: 'Triage', runs: 1 }] }}
        />
      </>,
    );
    expect(screen.getByText('Best 2 days')).toBeTruthy();
    expect(screen.getByText('Triage · 1 run')).toBeTruthy();
    expect(screen.getByText('Opus 5 · 71%')).toBeTruthy();
    expect(screen.getByText('Skill · 1 chat')).toBeTruthy();
  });
});
