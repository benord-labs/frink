import type { UIMessage } from 'ai';
import { stripMessageMarkers } from '../../../../../../shared/lib/message-markers/strip-message-markers';
import { SUBAGENT_TEXT_PART_TYPE } from '../../../../../../shared/subagent-parts';
import {
  hasCurrentUnapprovedPlan,
  type PlanMessageLike,
} from '../../../../../../shared/types/plan';
import type { Message, MessagePart } from '../../../stores/message-store';

/**
 * Extract text content from a message.
 *
 * Subagent prose counts: it reads as text in the transcript (nested in its card) and travels as a
 * tool part only because that shape can carry the id that attributes it to a parent.
 */
export const getMessageTextContent = (msg: Message): string => {
  return (
    msg.parts
      ?.map((p: MessagePart) =>
        p.type === 'text'
          ? p.text
          : p.type === SUBAGENT_TEXT_PART_TYPE && typeof p.input?.text === 'string'
            ? p.input.text
            : undefined,
      )
      // A prose part with nothing to say is skipped, not copied as an empty line.
      .filter((text): text is string => text !== undefined && text.trim() !== '')
      .join('\n') || ''
  );
};

/**
 * Copy message content to clipboard (matches displayed text, including emoji)
 */
export const copyMessageContent = (msg: Message): void => {
  // Display markers are never shown, so they must never be pasted either.
  const textContent = stripMessageMarkers(getMessageTextContent(msg));
  if (textContent) {
    navigator.clipboard.writeText(textContent);
  }
};

/**
 * Check if there's an unapproved plan in the messages.
 * Uses canonical Frink plan tool parts only (`tool-frink-plan`).
 */
export const hasUnapprovedPlan = (messages: UIMessage[], isPlanMode: boolean): boolean =>
  hasCurrentUnapprovedPlan(messages as unknown as PlanMessageLike[], isPlanMode);
