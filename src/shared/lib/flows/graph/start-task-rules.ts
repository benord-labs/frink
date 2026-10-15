/**
 * Start Task rules for Flow graph validation; the run guard shares the wait message.
 */

import { z } from 'zod';
import { isRemovedWaitStartMode } from '../../trigger-rule-config';
import type { FlowNode } from '../../validate-flow-graph';

const startInWorktreeSchema = z.boolean().optional();
const branchSchema = z.string().nullish();

/** Why a Start Task still set to the removed "wait" mode cannot save or run; null when it can. */
export function startTaskWaitError(n: FlowNode, label: (n: FlowNode) => string): string | null {
  if (n.blockType !== 'start_task' || !isRemovedWaitStartMode(String(n.config?.startMode)))
    return null;
  return `Wait is no longer a start mode, so choose Execute or Plan for "${label(n)}"`;
}

/** Worktree settings a Start Task must have well-formed before it can run. */
export function startTaskRunErrors(n: FlowNode, label: (n: FlowNode) => string): string[] {
  if (n.blockType !== 'start_task') return [];
  const c = n.config ?? {};
  const errors: string[] = [];
  if (!startInWorktreeSchema.safeParse(c.startInWorktree).success) {
    errors.push(`Start Task node "${label(n)}" startInWorktree must be a boolean when present`);
  }
  if (c.startInWorktree === true && !branchSchema.safeParse(c.branch).success) {
    errors.push(`Start Task node "${label(n)}" branch must be a string when present`);
  }
  return errors;
}
