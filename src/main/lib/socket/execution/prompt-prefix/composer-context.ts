import {
  isCompactCommand,
  SLASH_COMMAND_REGEX,
} from '../../../../../shared/commands/expand-slash-command';
import {
  findMentionTokens,
  OPEN_EDITOR_FILE_SOURCE,
} from '../../../../../shared/lib/mentions/mention-grammar';
import type { CodexContextEntry } from '../../../../../shared/lib/message-markers/message-provenance';
import { type ParsedMention, parseMention } from '../../../../../shared/lib/mentions/parse-mention';
import { wrapRemindersForPrompt } from '../../operator-reminders';
import type { MessageDelivery } from '../message-provenance/origin';

/** Claude Code's cap on the selected lines it quotes to the model. */
const SELECTION_LIMIT = 2000;
const MAY_BE_UNRELATED = 'This may or may not be related to the current task.';

/** A sentence for the model. A selection's body is text the user picked, which Frink cannot vouch for. */
export type ComposerNote = { kind: 'open_file' | 'mentioned_paths' | 'selection'; text: string };

/** A message as its provider reads it: the text for the prompt, the notes for its context channel. */
type ComposerProjection = { text: string; notes: ComposerNote[] };

/** What one token becomes: the text left in its place, and the note it adds, if any. */
type Projection = { text: string; note?: ComposerNote };

function isOpenEditorFile(mention: ParsedMention): boolean {
  return mention.type === 'file' && mention.repository === OPEN_EDITOR_FILE_SOURCE;
}

/** A file or folder the user picked from the @ menu. */
function isPicked(mention: ParsedMention): boolean {
  return (mention.type === 'file' || mention.type === 'folder') && !isOpenEditorFile(mention);
}

/** Claude Code escapes a path in a note, so the path cannot close the note's tag. */
function notePath(path: string): string {
  return path.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function pickedNote(paths: string[]): string {
  return `The user @-mentioned ${paths.map(notePath).join(', ')}. File contents are not attached automatically in this session: if these are files or directories in your working directory, read them with your file tools before responding.`;
}

function truncateSelection(text: string): string {
  return text.length > SELECTION_LIMIT
    ? `${text.slice(0, SELECTION_LIMIT)}\n... (truncated)`
    : text;
}

/** Claude Code's sentence for an attached selection, or null for any other kind of token. */
function selectionNote(mention: ParsedMention, content: string): string | null {
  if (mention.type === 'code') {
    const [start, end = start] = (mention.lineRange ?? '').split('-');
    return `The user selected the lines ${start} to ${end} from ${notePath(mention.path)}:\n${truncateSelection(content)}\n\n${MAY_BE_UNRELATED}`;
  }
  if (mention.type === 'diff') {
    const count = content.split('\n').length;
    const where = mention.path ? ` (in ${notePath(mention.path)})` : '';
    return `The user selected the following ${count} ${count === 1 ? 'line' : 'lines'} from the diff view${where}:\n${truncateSelection(content)}`;
  }
  if (mention.type === 'quote') {
    return `The user selected the following text from an earlier message in this conversation:\n${truncateSelection(content)}`;
  }
  return null;
}

function projectMention(mention: ParsedMention, pickedPaths: string[]): Projection | null {
  if (isOpenEditorFile(mention)) {
    if (pickedPaths.includes(mention.path)) return { text: '' };
    const text = `The user opened the file ${notePath(mention.path)} in the IDE. ${MAY_BE_UNRELATED}`;
    return { text: '', note: { kind: 'open_file', text } };
  }
  // A plain path: a leading `@` would make the Claude CLI attach the file itself.
  if (isPicked(mention)) {
    return { text: mention.path, note: { kind: 'mentioned_paths', text: pickedNote(pickedPaths) } };
  }
  const text = mention.fullText ? selectionNote(mention, mention.fullText) : null;
  return text ? { text: '', note: { kind: 'selection', text } } : null;
}

/** A person typed it, or retried a turn no task dispatched (a new chat's first message is sent so).
 * Flow, dispatch, wake and plan-approval text can quote outside text that looks like a token. */
export function isPersonAuthored(delivery: MessageDelivery | undefined): boolean {
  const origin = delivery?.messageOrigin;
  const retried = origin?.source === 'internal' && origin.kind === 'regenerate';
  return origin?.source === 'person' || (retried && !delivery?.dispatchTaskId);
}

/** Says what the composer's file and selection tokens mean, in Claude Code's own sentences. The
 * notes go to the provider's own context channel; `/compact` and other tokens stay as sent. */
export function projectComposerContext(message: string): ComposerProjection {
  if (isCompactCommand(message)) return { text: message, notes: [] };
  const tokens = findMentionTokens(message).map((token) => ({
    ...token,
    mention: parseMention(token.id),
  }));
  const pickedPaths = [
    ...new Set(
      tokens.flatMap(({ mention }) => (mention && isPicked(mention) ? [mention.path] : [])),
    ),
  ];
  const notes = new Map<string, ComposerNote>();
  let text = '';
  let cursor = 0;
  for (const { start, end, mention } of tokens) {
    const projection = mention && projectMention(mention, pickedPaths);
    if (!projection) continue;
    text += message.slice(cursor, start) + projection.text;
    // A removed token takes the space that separated it from the text after it.
    cursor = !projection.text && message[end] === ' ' ? end + 1 : end;
    if (projection.note) notes.set(projection.note.text, projection.note);
  }
  if (notes.size === 0) return { text: message, notes: [] };
  text += message.slice(cursor);
  // Inline when nothing was typed, so no prompt is empty, and when the tokens were all that kept a
  // typed slash command off the start of the prompt, so the Claude CLI still does not run it.
  const exposesCommand = SLASH_COMMAND_REGEX.test(text) && !SLASH_COMMAND_REGEX.test(message);
  if (text.trim() && !exposesCommand) return { text, notes: [...notes.values()] };
  const reminders = wrapRemindersForPrompt([...notes.keys()]);
  return { text: text.trim() ? `${reminders}\n\n${text}` : reminders, notes: [] };
}

/** The notes as Codex host context. One entry each: Codex cuts every value at 1,000 tokens. */
export function codexComposerContext(notes: ComposerNote[]) {
  const counts = new Map<ComposerNote['kind'], number>();
  return Object.fromEntries(
    notes.map(({ kind, text }): [string, CodexContextEntry] => {
      const index = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, index);
      const trust = kind === 'selection' ? 'untrusted' : 'application';
      return [`frink_${kind}_${index}`, { kind: trust, value: text }];
    }),
  );
}
