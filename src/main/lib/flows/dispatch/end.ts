/**
 * End block — terminates this branch with no work. Engine treats `end` as
 * the natural terminator and finalizes the run.
 */

import type { Dispatcher } from './types';

export const dispatchEnd: Dispatcher = async () => ({
  type: 'completed',
  output: {
    status: 'completed',
    outputs: {},
    artifacts: [],
    durationMs: 0,
  },
});
