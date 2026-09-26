import { isCompactCommand } from '@/lib/commands/expand-slash-command';
import { encodeForMentionToken } from './briefing-base64';
import { MENTION_PREFIXES, MENTION_PREVIEW_SANITIZE_REGEX } from './agents-mentions-types';

const PREVIEW_LENGTH = 50;

/** The queued-item fields this needs, structurally — so the mentions domain does not reach into
 * the agents feature for its queue type. */
type QueuedMessage = {
  message: string;
  textContexts?: Array<{ text: string }>;
  diffTextContexts?: Array<{ text: string; filePath: string; lineNumber?: number }>;
};

function preview(text: string): string {
  return text.slice(0, PREVIEW_LENGTH).replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
}

/**
 * The text part for a queued message as it drains: attached quote/diff contexts as mention tokens,
 * ahead of the message. `/compact` is exempt — see isCompactCommand.
 */
export function buildQueuedMessageText(item: QueuedMessage): string {
  const message = item.message || '';
  if (isCompactCommand(message)) return message;

  const quoteMentions = (item.textContexts ?? []).map(
    (tc) => `@[${MENTION_PREFIXES.QUOTE}${preview(tc.text)}:${encodeForMentionToken(tc.text)}]`,
  );
  const diffMentions = (item.diffTextContexts ?? []).map(
    (dtc) =>
      `@[${MENTION_PREFIXES.DIFF}${dtc.filePath}:${dtc.lineNumber || 0}:${preview(dtc.text)}:${encodeForMentionToken(dtc.text)}]`,
  );

  const mentions = [...quoteMentions, ...diffMentions];
  return mentions.length > 0 ? `${mentions.join(' ')} ${message}` : message;
}
