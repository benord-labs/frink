/** What the background-work row lists: the held snapshot (the Stop hook's view, which alone ends a
 * wait) reconciled with the live roster (`background_tasks_changed`, in every phase). */

import type { WakeHoldItem, WakeHoldState } from '../../../shared/types/wake-hold';
import type { BackgroundRosterTask } from '../../../shared/types/wake-hold/subagent-task';

const SCHEDULED_WAKE_LABEL = 'Scheduled wake';

/** The CLI's raw task kinds, plus the Stop hook's friendly ones, on the snapshot's label set. */
const ROSTER_LABELS = new Map<string, string>([
  ['local_bash', 'Command'],
  ['shell', 'Command'],
  ['local_agent', 'Agent'],
  ['subagent', 'Agent'],
  ['local_workflow', 'Workflow'],
  ['workflow', 'Workflow'],
  ['monitor', 'Monitor'],
]);

/** Stands in when a held wait's tasks have all left the roster but its settling wake has not run:
 * the row keeps its Stop without listing finished work. */
const FINISHING_UP: WakeHoldItem = {
  id: 'finishing-up',
  label: 'Background task',
  description: 'Finishing up',
  stoppable: false,
};

/** A task only the roster knows (started since the last snapshot) has no command and no stop
 * route yet — main's per-item stop addresses its own snapshot. */
function rosterItem(task: BackgroundRosterTask): WakeHoldItem {
  return {
    id: task.id,
    label: ROSTER_LABELS.get(task.type) ?? 'Background task',
    description: task.description,
    stoppable: false,
  };
}

/**
 * Held: the snapshot minus tasks the roster says are gone (crons stay), plus non-ambient tasks it has
 * not caught up with. Not held: the roster, only while a turn streams. A null roster changes nothing.
 *
 * A held, idle chat never comes back empty: the row's Stop is the wait's only exit between bursts.
 */
export function backgroundWorkItems(
  hold: WakeHoldState | null,
  roster: BackgroundRosterTask[] | null,
  isTurnActive: boolean,
): WakeHoldItem[] {
  const base = hold?.waitingOn ?? [];
  if (!hold && !isTurnActive) return [];
  if (!roster) return base;
  const live = new Set(roster.map((task) => task.id));
  const kept = base.filter((item) => item.label === SCHEDULED_WAKE_LABEL || live.has(item.id));
  const known = new Set(base.map((item) => item.id));
  const added = roster.filter((task) => !task.ambient && !known.has(task.id)).map(rosterItem);
  const items = [...kept, ...added];
  return items.length === 0 && hold && !isTurnActive ? [FINISHING_UP] : items;
}
