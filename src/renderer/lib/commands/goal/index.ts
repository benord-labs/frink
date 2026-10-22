import { type Atom, atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import type { GoalPartData } from '../../../../shared/types/goal';

export type ActiveGoal = { objective: string; lastCheck?: string };

/** The fields of a stored chat message the goal is read from. */
export type GoalMessage = {
  role: string;
  parts?: { type: string; data?: unknown }[];
  metadata?: { resultSubtype?: string; outputTokens?: number };
};

/** Claude's goal check blocks every clean stop until the goal is met, so such a turn ends one. */
function endedModelTurn(message: GoalMessage): boolean {
  const meta = message.metadata;
  return (
    meta?.resultSubtype === 'success' &&
    (meta.outputTokens ?? 0) > 0 &&
    !message.parts?.some((part) => part.type === 'data-compact')
  );
}

/** A message's goal part, if any, and its checks of goals set earlier, newest first. */
function goalParts(message: GoalMessage) {
  const parts = (message.parts ?? []).flatMap((part) =>
    // SAFETY: only the main-process goal mapper writes `data-goal` parts.
    part.type === 'data-goal' ? [part.data as GoalPartData] : [],
  );
  return {
    goal: parts.findLast((part) => part.state !== 'checked'),
    checks: parts.flatMap((part) => (part.state === 'checked' ? [part] : [])).reverse(),
  };
}

/** The goal Claude still holds, read newest message first; null once it is met or cleared. */
export function activeGoal(newestFirst: Iterable<GoalMessage | null>): ActiveGoal | null {
  const checks: ActiveGoal[] = [];
  for (const message of newestFirst) {
    if (message?.role !== 'assistant') continue;
    const { goal, checks: newer } = goalParts(message);
    if (goal?.state === 'cleared' || endedModelTurn(message)) return null;
    if (goal) return withCheck(goal, [...newer, ...checks]);
    checks.push(...newer);
  }
  return null;
}

/** A goal resumed in a later turn takes the newest check of that same objective. */
function withCheck(goal: ActiveGoal, checks: ActiveGoal[]): ActiveGoal {
  const check = checks.find((entry) => entry.objective === goal.objective);
  return { objective: goal.objective, lastCheck: goal.lastCheck ?? check?.lastCheck };
}

function* newestFirst(ids: string[], read: (id: string) => GoalMessage | null) {
  for (let i = ids.length - 1; i >= 0; i--) yield read(ids[i]);
}

function sameGoal(a: ActiveGoal | null, b: ActiveGoal | null): boolean {
  return a?.objective === b?.objective && a?.lastCheck === b?.lastCheck;
}

/** Reads lazily from the newest message, so a streaming turn re-derives from one or two atoms;
 * keeps its value while the goal is unchanged so the card does not re-render on every token. */
export function activeGoalAtom(
  messageIds: Atom<string[]>,
  messageAt: (id: string) => Atom<GoalMessage | null>,
): Atom<ActiveGoal | null> {
  const derived = atom((get) =>
    activeGoal(newestFirst(get(messageIds), (id) => get(messageAt(id)))),
  );
  return selectAtom(derived, (goal) => goal, sameGoal);
}
