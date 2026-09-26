import type {
  UsageHistory,
  UsageHistoryDay,
  UsageLevel,
} from '../../../../shared/types/usage-history';
import { integrationLabel, modelLabel } from './labels';
import type { UsageProvider, UsageRecord } from './transcripts';

/** One transcript's records and the conversation it belongs to (null: not a conversation of
 * its own, e.g. a Codex subagent run, whose tokens still count). */
export type TranscriptUsage = { conversation: string | null; records: UsageRecord[] };

const WEEKS = 53;
const TOP_INTEGRATIONS = 10;

/** Local calendar day, `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

type Tally = {
  days: Map<string, Record<UsageProvider, number>>;
  hours: number[];
  models: Map<string, number>;
  tools: Map<string, Set<string>>;
  conversations: Set<string>;
  /** Per local day, the conversations with usage that day, per provider. */
  dayChats: Map<string, Record<UsageProvider, Set<string>>>;
};

function addTokens(t: Tally, record: UsageRecord): void {
  const tokens = record.inputTokens + record.outputTokens;
  const at = new Date(record.timestampMs);
  const day = t.days.get(dayKey(at)) ?? { claude: 0, codex: 0 };
  day[record.provider] += tokens;
  t.days.set(dayKey(at), day);
  t.hours[at.getHours()] += tokens;
  t.models.set(record.model, (t.models.get(record.model) ?? 0) + tokens);
}

function addTools(t: Tally, record: UsageRecord, conversation: string): void {
  t.conversations.add(conversation);
  const day = dayKey(new Date(record.timestampMs));
  const chats = t.dayChats.get(day) ?? { claude: new Set<string>(), codex: new Set<string>() };
  chats[record.provider].add(conversation);
  t.dayChats.set(day, chats);
  for (const tool of record.tools) {
    // A plugin's namespaced server and the vendor's own server are one integration to the user.
    const key = tool.startsWith('mcp:') ? `mcp:${integrationLabel(tool.slice(4))}` : tool;
    t.tools.set(key, (t.tools.get(key) ?? new Set()).add(conversation));
  }
}

function tally(transcripts: TranscriptUsage[]): Tally {
  const t: Tally = {
    days: new Map(),
    hours: new Array<number>(24).fill(0),
    models: new Map(),
    tools: new Map(),
    conversations: new Set(),
    dayChats: new Map(),
  };
  // Claude repeats a message's usage on every content block and while it streams, so each message
  // counts once, at its fullest snapshot.
  const messages = new Map<string, UsageRecord>();
  for (const { conversation, records } of transcripts) {
    for (const record of records) {
      if (conversation) addTools(t, record, conversation);
      if (record.dedupeKey === null) addTokens(t, record);
      else if ((messages.get(record.dedupeKey)?.outputTokens ?? -1) < record.outputTokens) {
        messages.set(record.dedupeKey, record);
      }
    }
  }
  for (const record of messages.values()) addTokens(t, record);
  return t;
}

/** Quartile thresholds of the active days, so one heavy day doesn't wash the rest out. */
function levelOf(value: number, sortedActive: number[]): UsageLevel {
  if (value <= 0) return 0;
  const quartile = (q: number): number =>
    sortedActive[Math.floor((sortedActive.length - 1) * q)] ?? 0;
  if (value <= quartile(0.25)) return 1;
  if (value <= quartile(0.5)) return 2;
  if (value <= quartile(0.75)) return 3;
  return 4;
}

function streaks(activeDays: Set<string>, today: Date) {
  // Today still counts as "in progress": the current streak may end yesterday.
  let cursor = activeDays.has(dayKey(today)) ? today : addDays(today, -1);
  let current = 0;
  while (activeDays.has(dayKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  for (const key of activeDays) {
    const [y, m, d] = key.split('-').map(Number);
    if (activeDays.has(dayKey(new Date(y, m - 1, d - 1)))) continue;
    let run = 1;
    while (activeDays.has(dayKey(new Date(y, m - 1, d + run)))) run += 1;
    longest = Math.max(longest, run);
  }
  return { current, longest };
}

function heatmap({ days, dayChats }: Tally, today: Date): UsageHistoryDay[][] {
  const sorted = (pick: (v: Record<UsageProvider, number>) => number): number[] =>
    [...days.values()]
      .map(pick)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
  const all = sorted((v) => v.claude + v.codex);
  const claude = sorted((v) => v.claude);
  const codex = sorted((v) => v.codex);
  const firstSunday = addDays(today, -today.getDay() - (WEEKS - 1) * 7);
  return Array.from({ length: WEEKS }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = addDays(firstSunday, week * 7 + weekday);
      const chats = dayChats.get(dayKey(date));
      const empty = { claude: 0, codex: 0 };
      if (date > today) {
        return { date: '', ...empty, chats: empty, level: { all: 0, claude: 0, codex: 0 } };
      }
      const usage = days.get(dayKey(date)) ?? empty;
      return {
        date: dayKey(date),
        claude: usage.claude,
        codex: usage.codex,
        chats: { claude: chats?.claude.size ?? 0, codex: chats?.codex.size ?? 0 },
        level: {
          all: levelOf(usage.claude + usage.codex, all),
          claude: levelOf(usage.claude, claude),
          codex: levelOf(usage.codex, codex),
        },
      };
    }),
  );
}

function maxEntry<K>(entries: Iterable<[K, number]>): [K, number] | null {
  let best: [K, number] | null = null;
  for (const entry of entries) if (entry[1] > 0 && (!best || entry[1] > best[1])) best = entry;
  return best;
}

/** The whole Usage history page, ready to render. `now` fixes "today" for tests. */
export function summarizeUsage(transcripts: TranscriptUsage[], now: Date): UsageHistory {
  const t = tally(transcripts);
  const dayTotals = [...t.days].map(([date, v]): [string, number] => [date, v.claude + v.codex]);
  const totalTokens = dayTotals.reduce((sum, [, tokens]) => sum + tokens, 0);
  const busiestDay = maxEntry(dayTotals);
  const busiestHour = maxEntry(t.hours.map((tokens, hour): [number, number] => [hour, tokens]));
  const byLabel = new Map<string, number>();
  for (const [model, tokens] of t.models) {
    byLabel.set(modelLabel(model), (byLabel.get(modelLabel(model)) ?? 0) + tokens);
  }
  const topModel = maxEntry(byLabel);
  const activeDays = dayTotals.filter(([, tokens]) => tokens > 0).map(([day]) => day);
  const { current, longest } = streaks(new Set(activeDays), now);
  return {
    since: activeDays.length > 0 ? activeDays.sort()[0] : null,
    totalTokens,
    weeks: heatmap(t, now),
    busiestDay: busiestDay && { date: busiestDay[0], tokens: busiestDay[1] },
    currentStreak: current,
    longestStreak: longest,
    busiestHour: busiestHour && busiestHour[0],
    topModel: topModel && { model: topModel[0], share: topModel[1] / totalTokens },
    conversations: t.conversations.size,
    integrations: [...t.tools]
      .map(([tool, used]) => {
        const [kind, name] = tool.split(/:(.*)/s);
        return {
          kind: kind === 'skill' ? ('skill' as const) : ('mcp' as const),
          name,
          conversations: used.size,
        };
      })
      .sort((a, b) => b.conversations - a.conversations || a.name.localeCompare(b.name))
      .slice(0, TOP_INTEGRATIONS),
    providers: {
      claude: [...t.days.values()].some((v) => v.claude > 0),
      codex: [...t.days.values()].some((v) => v.codex > 0),
    },
    updatedAt: now.getTime(),
  };
}
