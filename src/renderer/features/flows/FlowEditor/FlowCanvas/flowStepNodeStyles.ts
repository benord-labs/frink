/**
 * Block-type visuals for flow step nodes on the canvas.
 */

import { isRegisteredBlockType } from '../../../../../shared/lib/block-registry';
import type { FlowBlockType } from '../../../../../shared/types/flow';

const MUTED_SURFACE = 'bg-muted text-muted-foreground ring-1 ring-inset ring-border';

function blockIconSurfaceClassForRegistered(blockType: FlowBlockType): string {
  switch (blockType) {
    case 'manual_trigger':
      return 'bg-violet-500/15 text-violet-700 dark:text-violet-300 ring-1 ring-inset ring-violet-500/35';
    case 'webhook_trigger':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-1 ring-inset ring-sky-500/35';
    case 'post_task_trigger':
      return 'bg-lime-500/15 text-lime-700 dark:text-lime-200 ring-1 ring-inset ring-lime-500/35';
    case 'schedule_trigger':
      return 'bg-orange-500/15 text-orange-700 dark:text-orange-200 ring-1 ring-inset ring-orange-500/35';
    case 'start_task':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-200 ring-1 ring-inset ring-rose-500/35';
    case 'agent':
      return 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 ring-1 ring-inset ring-fuchsia-500/35';
    case 'chat_reply':
      return 'bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-1 ring-inset ring-teal-500/35';
    case 'run_command':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-200 ring-1 ring-inset ring-amber-500/35';
    case 'http_request':
      return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-1 ring-inset ring-blue-500/35';
    case 'condition':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-500/35';
    case 'fan_out':
      return 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-500/35';
    case 'approval':
      return 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-1 ring-inset ring-cyan-500/35';
    case 'end':
      return 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-300 ring-1 ring-inset ring-neutral-500/35';
    default: {
      // biome-ignore lint/style/useNamingConvention: exhaustiveness check variable
      const _exhaustive: never = blockType;
      return _exhaustive;
    }
  }
}

/** Icon chip surface for a flow block. Unknown / unregistered types use the muted fallback. */
export function blockIconSurfaceClass(blockType: FlowBlockType | string): string {
  if (!isRegisteredBlockType(blockType)) {
    return MUTED_SURFACE;
  }
  return blockIconSurfaceClassForRegistered(blockType);
}
