import { describe, expect, it } from 'vitest';
import { dayKey, summarizeUsage, type TranscriptUsage } from './aggregate';
import { integrationLabel, modelLabel } from './labels';
import type { UsageRecord } from './transcripts';

const NOW = new Date(2026, 8, 23, 15, 0); // Wed 23 Sep 2026, local time

function rec(day: Date, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: 'claude',
    timestampMs: day.getTime(),
    model: 'claude-opus-5',
    inputTokens: 10,
    outputTokens: 90,
    dedupeKey: null,
    tools: [],
    ...overrides,
  };
}
const daysAgo = (n: number, hour = 10) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n, hour);

describe('summarizeUsage', () => {
  it('counts a repeated Claude message once, even across transcripts', () => {
    const repeated = rec(daysAgo(0), { dedupeKey: 'msg:req' });
    const transcripts: TranscriptUsage[] = [
      { conversation: 'chat-a', records: [repeated, repeated] },
      { conversation: 'chat-a', records: [repeated] },
    ];
    expect(summarizeUsage(transcripts, NOW).totalTokens).toBe(100);
  });

  it('counts a streamed message at its fullest snapshot, not its first', () => {
    const early = rec(daysAgo(0), { dedupeKey: 'msg:req', outputTokens: 3 });
    const final = rec(daysAgo(0), { dedupeKey: 'msg:req', outputTokens: 400 });
    const transcripts: TranscriptUsage[] = [{ conversation: 'a', records: [early, final, early] }];
    expect(summarizeUsage(transcripts, NOW).totalTokens).toBe(410);
  });

  it('ranks integrations by how many conversations used them', () => {
    const transcripts: TranscriptUsage[] = [
      {
        conversation: 'a',
        records: [rec(daysAgo(0), { tools: ['mcp:shortcut', 'mcp:shortcut'] })],
      },
      {
        conversation: 'b',
        records: [rec(daysAgo(0), { tools: ['mcp:shortcut', 'skill:commit-gates'] })],
      },
      { conversation: null, records: [rec(daysAgo(0), { tools: ['mcp:linear'] })] },
    ];
    const summary = summarizeUsage(transcripts, NOW);
    expect(summary.integrations).toEqual([
      { kind: 'mcp', name: integrationLabel('shortcut'), conversations: 2 },
      { kind: 'skill', name: 'commit-gates', conversations: 1 },
    ]);
    expect(summary.conversations).toBe(2);
  });

  it("counts each day's chats per provider, once per conversation", () => {
    const transcripts: TranscriptUsage[] = [
      { conversation: 'a', records: [rec(daysAgo(0)), rec(daysAgo(0))] },
      { conversation: 'b', records: [rec(daysAgo(0), { provider: 'codex' })] },
      { conversation: null, records: [rec(daysAgo(0), { provider: 'codex' })] },
    ];
    const today = summarizeUsage(transcripts, NOW).weeks[52][3];
    expect(today.chats).toEqual({ claude: 1, codex: 1 });
  });

  it('keeps a streak going through today even before today has any usage', () => {
    const transcripts: TranscriptUsage[] = [
      { conversation: 'a', records: [1, 2, 3, 6, 7].map((n) => rec(daysAgo(n))) },
    ];
    const summary = summarizeUsage(transcripts, NOW);
    expect(summary.currentStreak).toBe(3);
    expect(summary.longestStreak).toBe(3);
  });

  it('lays out 53 Sunday-first weeks ending today, with later days left blank', () => {
    const transcripts: TranscriptUsage[] = [
      {
        conversation: 'a',
        records: [rec(daysAgo(0)), rec(daysAgo(0)), rec(daysAgo(2), { provider: 'codex' })],
      },
    ];
    const { weeks, since, busiestDay, providers } = summarizeUsage(transcripts, NOW);
    expect(weeks).toHaveLength(53);
    const lastWeek = weeks[52];
    expect(lastWeek[0].date).toBe(dayKey(daysAgo(3))); // Sunday 20 Sep
    expect(lastWeek[3]).toMatchObject({
      date: dayKey(NOW),
      claude: 200,
      level: { all: 4, codex: 0 },
    });
    expect(lastWeek[4].date).toBe('');
    expect(since).toBe(dayKey(daysAgo(2)));
    expect(busiestDay).toEqual({ date: dayKey(NOW), tokens: 200 });
    expect(providers).toEqual({ claude: true, codex: true });
  });

  it('reports the busiest local hour and the top model by share of tokens', () => {
    const transcripts: TranscriptUsage[] = [
      {
        conversation: 'a',
        records: [
          rec(daysAgo(1, 22), { model: 'claude-opus-5', outputTokens: 290 }),
          rec(daysAgo(1, 9), { model: 'claude-sonnet-5' }),
        ],
      },
    ];
    const summary = summarizeUsage(transcripts, NOW);
    expect(summary.busiestHour).toBe(22);
    expect(summary.topModel).toEqual({ model: modelLabel('claude-opus-5'), share: 0.75 });
  });

  it('starts the history on the first day with real usage, not a zero-token message', () => {
    const transcripts: TranscriptUsage[] = [
      {
        conversation: 'a',
        records: [rec(daysAgo(9), { inputTokens: 0, outputTokens: 0 }), rec(daysAgo(2))],
      },
    ];
    expect(summarizeUsage(transcripts, NOW).since).toBe(dayKey(daysAgo(2)));
    const onlySynthetic = [
      { conversation: 'a', records: [rec(daysAgo(9), { inputTokens: 0, outputTokens: 0 })] },
    ];
    expect(summarizeUsage(onlySynthetic, NOW).since).toBeNull();
  });

  it('is empty before any usage', () => {
    expect(summarizeUsage([], NOW)).toMatchObject({
      since: null,
      totalTokens: 0,
      busiestDay: null,
      busiestHour: null,
      topModel: null,
      currentStreak: 0,
    });
  });
});
