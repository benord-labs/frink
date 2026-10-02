/**
 * Boot step: park questions a dead process was still holding, before the restart sweeps cancel them
 * and carry-on resumes the agent without the question (the CLI drops the unanswered ask).
 */

import log from 'electron-log';
import { z } from 'zod';
import type { TaskSignalPayload } from '../../../../shared/types/task-signal';
import type { getDatabase } from '../../db';
import { parseResultRecord } from '../../db/repos/tasks';
import { listTasksHoldingQuestions } from '../../db/repos/task-parking/held-question-marker';
import type { Task } from '../../db/schema';
import { captureMainException } from '../../sentry/init';
import { agentUserQuestionsSchema } from '../../trpc/routers/frink-task-signal';
import { HeldQuestionParkDeclined, parkHeldQuestionCommand, runTransition } from '../transitions';

type Db = ReturnType<typeof getDatabase>;

const heldSignalSchema = z.object({
  summary: z.string().min(1),
  questions: agentUserQuestionsSchema.min(1),
  at: z.string(),
});

/** The earliest well-formed held question on a task: the one the turn was blocked on first. */
function earliestHeldSignal(result: Task['result']): TaskSignalPayload | null {
  const held = parseResultRecord(result).heldQuestions;
  if (!held || typeof held !== 'object' || Array.isArray(held)) return null;
  const signals = Object.values(held)
    .map((entry) => heldSignalSchema.safeParse(entry))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)
    .sort((a, b) => a.at.localeCompare(b.at));
  const first = signals[0];
  return first ? { state: 'awaiting_input', ...first } : null;
}

/** Returns how many held questions were parked. Must run BEFORE `recoverOrphans`. */
export function parkQuestionsHeldAtShutdown(db: Db): number {
  let parked = 0;
  for (const task of listTasksHoldingQuestions(db)) {
    try {
      const signal = earliestHeldSignal(task.result);
      // A malformed marker falls through to the ordinary restart sweep, exactly as before.
      if (!signal) continue;
      if (runTransition(db, () => parkHeldQuestionCommand(db, task, signal))) parked += 1;
    } catch (error) {
      // The task left `running` between the read and the write: nothing was parked, nothing to report.
      if (error instanceof HeldQuestionParkDeclined) continue;
      log.warn('[FlowsStartup] held question park skipped a task', { taskId: task.id, error });
      captureMainException(error, { surface: 'held-question-recovery', taskId: task.id });
    }
  }
  if (parked > 0) log.info('[FlowsStartup] parked questions held at shutdown', { count: parked });
  return parked;
}
