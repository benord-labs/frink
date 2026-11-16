import { LAUNCH_FLAGS } from '../../../../../shared/launch-flags';
import type { AgentActionDefinition } from '../types';

function destinationAction(
  id: string,
  label: string,
  hotkey: string,
  destination: 'flows' | 'workqueue',
  enabled: boolean,
): AgentActionDefinition {
  return {
    id,
    label,
    category: 'navigation',
    hotkey,
    isAvailable: (context) => enabled && context.openDestination !== undefined,
    handler: (context) => {
      context.openDestination?.(destination);
      return { success: true };
    },
  };
}

/** Shortcuts that open a full-page destination, gated by the same launch flags as the sidebar. */
export const DESTINATION_ACTIONS = [
  destinationAction('open-flows', 'Flows', 'cmd+1', 'flows', LAUNCH_FLAGS.flows),
  destinationAction('open-work-queue', 'Work Queue', 'cmd+2', 'workqueue', LAUNCH_FLAGS.workQueue),
];
