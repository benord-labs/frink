import { isCompactCommand } from '@/lib/commands/expand-slash-command';
import {
  MENTION_PREFIXES,
  MENTION_PREVIEW_SANITIZE_REGEX,
  OPEN_EDITOR_FILE_SOURCE,
} from '../../../shared/lib/mentions/mention-grammar';
import { encodeForMentionToken } from '../../../shared/lib/mentions/mention-token-codec';

const PREVIEW_LENGTH = 50;

/** The queued-item fields this needs, structurally — so the mentions domain does not reach into
 * the agents feature for its queue type. */
type QueuedMessage = {
  message: string;
  textContexts?: Array<{ text: string }>;
  diffTextContexts?: Array<DiffMentionSource>;
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

type DiffMentionSource = { text: string; filePath: string; lineNumber?: number };

/** One-line preview of `text`: whitespace collapsed, truncated with `...` past `maxLength`. */
export function createTextPreview(text: string, maxLength: number = PREVIEW_LENGTH): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  // Drop a high surrogate left at the cut, so an emoji is never halved.
  const cut = /[\uD800-\uDBFF]$/.test(trimmed.slice(0, maxLength)) ? maxLength - 1 : maxLength;
  return `${trimmed.slice(0, cut)}...`;
}

function mentionPreview(text: string): string {
  return createTextPreview(text).replace(MENTION_PREVIEW_SANITIZE_REGEX, '');
}

/** Quote token (`quote:preview:base64`) — every send path calls this so the chip label cannot drift. */
export function quoteMention(quote: { text: string }): string {
  return `@[${MENTION_PREFIXES.QUOTE}${mentionPreview(quote.text)}:${encodeForMentionToken(quote.text)}]`;
}

/** Diff token (`diff:path:line:preview:base64`), line 0 when there is none. The path is
 * URI-encoded, as in a code token: a raw `]` (`app/[id]`) or `:` (`C:\`) would break the token. */
export function diffMention(diff: DiffMentionSource): string {
  return `@[${MENTION_PREFIXES.DIFF}${encodeURIComponent(diff.filePath)}:${diff.lineNumber || 0}:${mentionPreview(diff.text)}:${encodeForMentionToken(diff.text)}]`;
}

/** Code-selection token — shared by the direct send and the queue drain so they cannot drift. */
export function codeSelectionMention(code: CodeSelectionMentionSource): string {
  const shown = (code.preview ?? code.text.slice(0, PREVIEW_LENGTH)).replace(
    MENTION_PREVIEW_SANITIZE_REGEX,
    '',
  );
  return `@[${MENTION_PREFIXES.CODE}${encodeURIComponent(code.fileName)}:${code.startLine}-${code.endLine}:${shown}:${encodeForMentionToken(code.text)}]`;
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

function fileToken(source: string, path: string): string {
  return `@[${MENTION_PREFIXES.FILE}${source}:${path}]`;
}

/** Open-file token for a message; null for `/compact` (see isCompactCommand) and when `text`
 * already carries that file, as an open-file token or one the user picked. */
export function openFileMention(file: { path: string } | null, text: string): string | null {
  if (!file || isCompactCommand(text)) return null;
  const sources = [OPEN_EDITOR_FILE_SOURCE, 'local'];
  if (sources.some((source) => text.includes(fileToken(source, file.path)))) return null;
  return fileToken(OPEN_EDITOR_FILE_SOURCE, file.path);
}

/**
 * The text part for a queued message as it drains: attached quote/diff/code/pasted contexts as
 * mention tokens, ahead of the message (the direct-send order). `/compact` is exempt — see isCompactCommand.
 */
export function buildQueuedMessageText(item: QueuedMessage): string {
  const message = item.message || '';
  if (isCompactCommand(message)) return message;

  const quoteMentions = (item.textContexts ?? []).map(quoteMention);
  const diffMentions = (item.diffTextContexts ?? []).map(diffMention);
  const codeMentions = (item.codeSelectionContexts ?? []).map(codeSelectionMention);
  const pastedMentions = (item.pastedTexts ?? []).map(pastedTextMention);

  const mentions = [...quoteMentions, ...diffMentions, ...codeMentions, ...pastedMentions];
  return [...mentions, message].filter(Boolean).join(' ');
}
