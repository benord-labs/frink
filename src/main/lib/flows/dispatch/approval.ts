/**
 * Approval block — pauses the run. resumeFlowRun(action='approve'|'skip')
 * unblocks it; 'retry' is treated as approve (re-evaluates downstream).
 */

import type { Dispatcher } from './types';

export const dispatchApproval: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as { message?: string };
  return {
    type: 'awaiting_input',
    reason: config.message?.trim() || 'Awaiting approval',
  };
};
