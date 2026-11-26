// Barrel the `src/main` folder-structure rule requires; exports only what the execution loop
// imports through it. Every other module here is imported directly by its sibling callers.
export {
  admitTurnFrame,
  isAnyResult,
  isIdleActivity,
  isMainTurnStart,
  isRunningState,
  startsIdleTurn,
  turnBoundaryFor,
  isSetterEcho,
} from './ambient-idle-frame';
export { noteSubagentTaskFrame } from './subagent-task-status';
