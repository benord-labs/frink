import type { FlowSettings, RunFirstRow } from '../../types/flow-settings-schema';

/** Template paths stop at five segments, `trigger` included, so a deeper detail could never be read. */
const MAX_DETAIL_SEGMENTS = 5;
const DETAIL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const WRAPPED_IN_BRACES = /^\{\{\s*(.*?)\s*\}\}$/;

export type ReadyRunFirstRow = { path: string; operator: RunFirstRow['operator']; value: string };

export type PriorityQueueMode = 'off' | 'every' | 'match';

/** How the Priority queue setting reads: the editor shows this and admission applies it. */
export function priorityQueueMode(
  settings: Pick<FlowSettings, 'runFirst' | 'runFirstWhen'> | undefined,
): PriorityQueueMode {
  if (settings?.runFirst === true) return 'every';
  return settings?.runFirstWhen?.length ? 'match' : 'off';
}

/** `trigger.story.title`, braces allowed as copied from Available variables; null when unreadable. */
function detailPath(detail: string): string | null {
  const path = detail.trim().replace(WRAPPED_IN_BRACES, '$1');
  const segments = path.split('.');
  const readable =
    segments[0] === 'trigger' &&
    segments.length >= 2 &&
    segments.length <= MAX_DETAIL_SEGMENTS &&
    segments.every((segment) => DETAIL_SEGMENT.test(segment));
  return readable ? path : null;
}

/** The rule ready to match, or null when any row is blank or unreadable: runs then keep their place. */
export function readyRunFirstRule(rows: readonly RunFirstRow[]): ReadyRunFirstRow[] | null {
  const ready: ReadyRunFirstRow[] = [];
  for (const row of rows) {
    const path = detailPath(row.detail);
    const value = row.value.trim();
    if (!path || !value) return null;
    ready.push({ path, operator: row.operator, value });
  }
  return ready.length > 0 ? ready : null;
}

/** True when every row matches; `read` gives the run's text at a path, or null when it has none. */
export function runFirstRuleMatches(
  rule: readonly ReadyRunFirstRow[],
  read: (path: string) => string | null,
): boolean {
  return rule.every((row) => {
    const actual = read(row.path);
    if (actual === null) return false;
    if (row.operator === 'contains') return actual.toLowerCase().includes(row.value.toLowerCase());
    return (actual === row.value) === (row.operator === 'equals');
  });
}
