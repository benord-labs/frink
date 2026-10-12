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

/** What the editor adds to the next message: a code selection outranks the open file, and a removed
 * file adds nothing. The composer chip and every send path read this one rule. */
export function attachedContextFile<T>(
  file: T | null | undefined,
  dismissed: boolean,
  selection: CodeSelectionMentionSource | null | undefined,
): T | null {
  return selection || dismissed ? null : (file ?? null);
}

/** Open-file token for a message; null for `/compact` (see isCompactCommand) and when `text`
 * already carries it, as an edited queued message does. */
export function openFileMention(file: { path: string } | null, text: string): string | null {
  if (!file || isCompactCommand(text)) return null;
  const token = `@[${MENTION_PREFIXES.FILE}local:${file.path}]`;
  return text.includes(token) ? null : token;
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
