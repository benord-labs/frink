export { createChildProcessCloseBarrier } from './child-process-close-barrier';
export { killProcessTree, processTreeGone, signalProcessTree } from './signal-process-tree';
export {
  adoptAgentProcess,
  noteTaskGroupsNow,
  reapAllTaskGroupsSync,
  reapStoppedTaskGroups,
  TASK_GROUP_CONTROLS,
  type TaskGroupControls,
  trackAgentProcess,
  trackClaudeCli,
} from './task-group-reaper';
