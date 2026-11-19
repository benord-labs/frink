/** Start Task rules for Flow graph validation. */

import { z } from 'zod';
import { TRIGGER_START_MODES, triggerStartModeSchema } from '../../../types/trigger-context';
import type { FlowNode } from '../../validate-flow-graph';

const startInWorktreeSchema = z.boolean().optional();
const branchSchema = z.string().nullish();
const startModeSchema = triggerStartModeSchema.nullish();

/** Why a Start Task's startMode cannot be saved, read the way dispatch reads it; empty when the
 *  mode is unset or valid. */
export function startTaskModeErrors(n: FlowNode, label: (n: FlowNode) => string): string[] {
  if (n.blockType !== 'start_task') return [];
  const mode = n.config?.startMode ?? n.config?.start_mode;
  if (startModeSchema.safeParse(mode).success) return [];
  return [
    `Start Task node "${label(n)}" start mode "${String(mode)}" is not valid; choose one of: ${TRIGGER_START_MODES.join(', ')}`,
  ];
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
