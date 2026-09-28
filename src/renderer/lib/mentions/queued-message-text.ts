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
  codeSelectionContexts?: Array<CodeSelectionMentionSource>;
  pastedTexts?: Array<PastedTextMentionSource>;
};

type CodeSelectionMentionSource = {
  text: string;
  fileName: string;
  startLine: number;
  endLine: number;
  preview?: string;
};

type PastedTextMentionSource = { size: number; preview: string; filePath: string };

function preview(text: string): string {
  return text.slice(0, PREVIEW_LENGTH).replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
}

/** Code-selection token — shared by the direct send and the queue drain so they cannot drift. */
export function codeSelectionMention(code: CodeSelectionMentionSource): string {
  const shown = (code.preview ?? code.text.slice(0, PREVIEW_LENGTH)).replace(
    MENTION_PREVIEW_SANITIZE_REGEX,
    '',
  );
  return `@[code:${encodeURIComponent(code.fileName)}:${code.startLine}-${code.endLine}:${shown}:${encodeForMentionToken(code.text)}]`;
}

/** Pasted-text token (`pasted:size:preview|path`): `|` separates the path because paths can
 * contain colons, and brackets are stripped so neither part can close the token early. */
export function pastedTextMention(pasted: PastedTextMentionSource): string {
  const safePreview = pasted.preview.replace(/[[\]]/g, '');
  const safePath = pasted.filePath.replace(/[[\]]/g, '');
  return `@[${MENTION_PREFIXES.PASTED}${pasted.size}:${safePreview}|${safePath}]`;
}

/**
 * The text part for a queued message as it drains: attached quote/diff/code/pasted contexts as
 * mention tokens, ahead of the message (the direct-send order). `/compact` is exempt — see isCompactCommand.
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

  const codeMentions = (item.codeSelectionContexts ?? []).map(codeSelectionMention);
  const pastedMentions = (item.pastedTexts ?? []).map(pastedTextMention);

  const mentions = [...quoteMentions, ...diffMentions, ...codeMentions, ...pastedMentions];
  return [...mentions, message].filter(Boolean).join(' ');
}
