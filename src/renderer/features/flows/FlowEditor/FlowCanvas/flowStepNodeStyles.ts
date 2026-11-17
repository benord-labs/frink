/**
 * Block-type visuals for flow step nodes on the canvas.
 */

import { isRegisteredBlockType } from '../../../../../shared/lib/block-registry';
import type { FlowBlockType } from '../../../../../shared/types/flow';

const MUTED_SURFACE = 'bg-muted text-muted-foreground ring-1 ring-inset ring-border';

/** A lit top edge on every colour tile, like the rim on Frink Glass. */
const TILE_LIGHT = 'text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]';

/** Each block's colour: a full tile for its icon and a faint wash for its card header. */
const BLOCK_COLOURS = {
  manual_trigger: { tile: 'from-violet-400 to-violet-600', tint: 'from-violet-500/18' },
  webhook_trigger: { tile: 'from-sky-400 to-sky-600', tint: 'from-sky-500/18' },
  post_task_trigger: { tile: 'from-lime-400 to-lime-600', tint: 'from-lime-500/18' },
  schedule_trigger: { tile: 'from-orange-400 to-orange-600', tint: 'from-orange-500/18' },
  start_task: { tile: 'from-rose-400 to-rose-600', tint: 'from-rose-500/18' },
  agent: { tile: 'from-fuchsia-400 to-violet-600', tint: 'from-fuchsia-500/18' },
  chat_reply: { tile: 'from-teal-400 to-teal-600', tint: 'from-teal-500/18' },
  run_command: { tile: 'from-amber-400 to-amber-600', tint: 'from-amber-500/18' },
  http_request: { tile: 'from-blue-400 to-blue-600', tint: 'from-blue-500/18' },
  condition: { tile: 'from-emerald-400 to-emerald-600', tint: 'from-emerald-500/18' },
  fan_out: { tile: 'from-indigo-400 to-indigo-600', tint: 'from-indigo-500/18' },
  approval: { tile: 'from-cyan-400 to-cyan-600', tint: 'from-cyan-500/18' },
  end: { tile: 'from-neutral-400 to-neutral-600', tint: 'from-neutral-500/18' },
} satisfies Record<FlowBlockType, { tile: string; tint: string }>;

/** Icon chip surface for a flow block. Unknown / unregistered types use the muted fallback. */
export function blockIconSurfaceClass(blockType: FlowBlockType | string): string {
  if (!isRegisteredBlockType(blockType)) return MUTED_SURFACE;
  return `bg-linear-to-b ${BLOCK_COLOURS[blockType].tile} ${TILE_LIGHT}`;
}

/** Header wash for a step card, fading out from the left; none for unregistered types. */
export function blockHeaderTintClass(blockType: FlowBlockType | string): string {
  if (!isRegisteredBlockType(blockType)) return '';
  return `bg-linear-to-r to-transparent to-60% ${BLOCK_COLOURS[blockType].tint}`;
}
