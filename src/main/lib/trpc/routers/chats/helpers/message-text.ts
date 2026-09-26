/**
 * Extract plain text from initial message input (multipart or string).
 * Returns null when no meaningful text is present.
 */
import { stripMessageMarkersToOneLine } from '../../../../../../shared/lib/message-markers/strip-message-markers';

const WHITESPACE_REGEX = /\s+/g;

export function extractInitialMessageText(input: {
  taskTitle?: string;
  initialMessage?: string;
  initialMessageParts?: Array<{ type: string; text?: string }>;
}): string | null {
  if (Array.isArray(input.initialMessageParts) && input.initialMessageParts.length > 0) {
    const text = input.initialMessageParts
      .filter(
        (part): part is { type: 'text'; text: string } =>
          part.type === 'text' && typeof part.text === 'string',
      )
      .map((part) => stripMessageMarkersToOneLine(part.text))
      .join(' ')
      .replace(WHITESPACE_REGEX, ' ')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  if (typeof input.initialMessage === 'string') {
    const trimmed = stripMessageMarkersToOneLine(input.initialMessage);
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (typeof input.taskTitle === 'string') {
    const trimmedTaskTitle = input.taskTitle.trim();
    if (trimmedTaskTitle.length > 0) {
      return trimmedTaskTitle;
    }
  }

  return null;
}
