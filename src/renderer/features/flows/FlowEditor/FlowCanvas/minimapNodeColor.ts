/**
 * MiniMap node color resolver matching blockIconSurfaceClass colors.
 */

import type { FlowBlockType } from '../../../../../shared/types/flow';

export function minimapNodeColor(blockType: FlowBlockType | string): string {
  switch (blockType) {
    case 'manual_trigger':
      return 'rgb(139, 92, 246)'; // violet-500
    case 'webhook_trigger':
      return 'rgb(14, 165, 233)'; // sky-500
    case 'post_task_trigger':
      return 'rgb(132, 204, 22)'; // lime-500
    case 'schedule_trigger':
      return 'rgb(249, 115, 22)'; // orange-500
    case 'start_task':
      return 'rgb(244, 63, 94)'; // rose-500
    case 'agent':
      return 'rgb(217, 70, 239)'; // fuchsia-500
    case 'chat_reply':
      return 'rgb(20, 184, 166)'; // teal-500
    case 'run_command':
      return 'rgb(245, 158, 11)'; // amber-500
    case 'http_request':
      return 'rgb(59, 130, 246)'; // blue-500
    case 'condition':
      return 'rgb(16, 185, 129)'; // emerald-500
    case 'fan_out':
      return 'rgb(99, 102, 241)'; // indigo-500
    case 'approval':
      return 'rgb(6, 182, 212)'; // cyan-500
    case 'end':
      return 'rgb(115, 115, 115)'; // neutral-500
    default:
      return 'hsl(var(--muted-foreground) / 0.45)';
  }
}
