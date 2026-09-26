import { Navigation } from 'lucide-react';
import type { MessagePart } from '../../stores/message-store';
import type { ToolMeta } from '../tool-registry-shared';

function steerText(part: MessagePart): string {
  const text = (part.input as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * A message the user steered INTO a turn while it was running. Not a tool call — it rides the
 * tool-part shape (as the Thinking card does) so it renders inline in the assistant message the
 * agent was already streaming, rather than opening a second one.
 *
 * The card marks WHEN THE USER SENT IT, not when the model read it: the CLI never announces that it
 * dequeued a steered message, so any "picked up here" claim would be invented.
 *
 * Lives outside agent-tool-registry.tsx because that file sits on its size ratchet with a single
 * line of headroom — the entry is spread in there instead.
 */
export const STEER_TOOL_ENTRY: Record<string, ToolMeta> = {
  'tool-Steer': {
    icon: Navigation,
    title: () => 'You steered',
    subtitle: steerText,
    subtitleLong: steerText,
    variant: 'simple',
  },
};
