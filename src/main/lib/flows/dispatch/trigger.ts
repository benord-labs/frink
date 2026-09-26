/**
 * Trigger blocks (manual, webhook, post_task, schedule). They produce no work
 * themselves — they just propagate the run's `triggerContext` as `outputs` so
 * downstream nodes can reference `{{trigger.*}}`.
 */

import type { Dispatcher } from './types';

export const dispatchTrigger: Dispatcher = async (ctx) => {
  const outputs: Record<string, unknown> = ctx.triggerContext ? { ...ctx.triggerContext } : {};
  return {
    type: 'completed',
    output: {
      status: 'completed',
      outputs,
      artifacts: [],
      durationMs: 0,
    },
  };
};
