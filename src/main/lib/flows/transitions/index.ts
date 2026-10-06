/** Flow-run lifecycle changes as synchronous commands: no await and no admission controller, runtime
 * or drain call inside one. Invariants: docs/decisions/flow-run-transition-serialization.md. */
import type { getDatabase } from '../../db';

export { type CancelRunOutcome, cancelRunCommand, cancelWorkQueueRunCommand } from './cancel-run';
export {
  HeldQuestionParkDeclined,
  type HeldQuestionTask,
  parkHeldQuestionCommand,
} from './held-question';
export {
  countSlotDispatches,
  type DispatchSlot,
  dispatchCeilingFailure,
  insertNodeRunUnderCeiling,
  MAX_NODE_DISPATCHES_PER_ADMISSION,
} from './dispatch-ceiling';
export { insertNodeRunIfFenced, type RunFence, readRunFence, setFencedRunStatus } from './fence';
export { cancelRunRows } from './run-rows';
export {
  isPlanApprovalResume,
  type ParkedTask,
  type ResumedBy,
  resumeParkedTaskCommand,
  reviveInPlaceCommand,
} from './resume-task';
export {
  type DrivingTaskRow,
  flowStillRunning,
  isRestartInterrupted,
  type ReopenDeclined,
  reopenPausedRunCommand,
  restartMarkedNode,
  unparkFailedRunCommand,
  unparkFlowCommand,
} from './unpark';

type Db = ReturnType<typeof getDatabase>;

export function runTransition<T>(db: Db, command: () => T): T {
  return db.transaction(command, { behavior: 'immediate' });
}
