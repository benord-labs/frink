import type { MobileRun, MobileRunNode } from '../../../../src/shared/types/remote/mobile';
import { dateBucket, duration, runStatus, type Status, type StatusTone } from '../../lib/status';

const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'cancelled']);
const LIVE = new Set(['running', 'pending', 'queued']);
const FINISHED_STEP = new Set(['completed', 'succeeded', 'skipped']);

export const isTerminal = (status: string) => TERMINAL.has(status);
/** Work is under way (not waiting on you, not paused, not over). */
export const isLive = (status: string | null | undefined) => !!status && LIVE.has(status);

/** A step the engine has not reached yet is "pending" too, but it is not starting. */
export function stepStatus(node: Pick<MobileRunNode, 'status' | 'startedAt'>): Status {
  if (node.status === 'pending' && !node.startedAt)
    return { word: 'Not started', tone: 'quiet', glyph: 'never' };
  return runStatus(node.status);
}

/** A step's right-hand slot: time so far while live, time taken when done, else the state. */
export function stepTrailing(
  node: MobileRunNode,
  now = Date.now(),
): { text: string; tone: StatusTone } | null {
  const status = stepStatus(node);
  if (status.glyph === 'live')
    return node.startedAt ? { text: duration(node.startedAt, now), tone: 'live' } : null;
  if (status.glyph === 'never') return null;
  if (status.glyph === 'done') {
    const took = node.completedAt ? duration(node.startedAt, Date.parse(node.completedAt)) : '';
    return took && took !== '0s' ? { text: took, tone: 'quiet' } : null;
  }
  return { text: status.word, tone: status.tone };
}

/** "Step 2 of 4" while a run is on its way, "4 steps" once every step is behind it. */
export function runProgress(run: Pick<MobileRun, 'nodes'>): string {
  const total = run.nodes.length;
  if (!total) return 'Getting ready';
  const current = run.nodes.findIndex((node) => !FINISHED_STEP.has(node.status));
  if (current === -1) return total === 1 ? '1 step' : `${total} steps`;
  return `Step ${current + 1} of ${total}`;
}

/** How long a run took, or has taken so far. */
export function runElapsed(
  run: { startedAt: string | null; completedAt: string | null },
  now = Date.now(),
): string {
  return duration(run.startedAt, run.completedAt ? Date.parse(run.completedAt) : now);
}

/** "Today, 2:21 PM", "Yesterday, 9:00 AM", then "22 Sep, 9:00 AM". */
export function runWhen(iso: string, now = new Date()): string {
  const time = new Date(iso);
  const clock = time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const bucket = dateBucket(iso, now);
  if (bucket === 'Today' || bucket === 'Yesterday') return `${bucket}, ${clock}`;
  const day = time.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(time.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day}, ${clock}`;
}

/** A step summary's first line with Markdown markers stripped: headings and list numbers run
 *  together into noise when a block is flattened. */
export function plainDetail(text: string): string {
  return (
    text
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*(#+|[-*>]|\d+\.)\s*/, '')
          .replace(/[*_`]+/g, '')
          .trim(),
      )
      .find(Boolean) ?? ''
  );
}

/** The run's state as a person sees it. The engine parks a run at "paused" both while it waits on
 *  a decision and while an agent step works, so the steps tell which it is. */
export function runHeadline(run: Pick<MobileRun, 'status' | 'nodes'>): Status {
  if (run.nodes.some((node) => node.actions.length > 0 || node.status === 'awaiting_input'))
    return runStatus('awaiting_input');
  if (run.status === 'paused' && run.nodes.some((node) => node.status === 'running'))
    return runStatus('running');
  return runStatus(run.status);
}

/** The Text colour that carries each status tone. */
export const TONE_TEXT = {
  quiet: 'muted',
  live: 'live',
  accent: 'accent',
  attention: 'attention',
  danger: 'danger',
} as const satisfies Record<StatusTone, string>;
