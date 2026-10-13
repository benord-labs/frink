import {
  isCompactCommand,
  SLASH_COMMAND_REGEX,
} from '../../../../../shared/commands/expand-slash-command';
import {
  findMentionTokens,
  OPEN_EDITOR_FILE_SOURCE,
} from '../../../../../shared/lib/mentions/mention-grammar';
import { type ParsedMention, parseMention } from '../../../../../shared/lib/mentions/parse-mention';
import { wrapRemindersForPrompt } from '../../operator-reminders';
import type { MessageDelivery } from '../message-provenance/origin';

/** Claude Code's cap on the selected lines it quotes to the model. */
const SELECTION_LIMIT = 2000;
const MAY_BE_UNRELATED = 'This may or may not be related to the current task.';

/** What one token becomes: the text left in its place, and the note it adds, if any. */
type Projection = { text: string; note?: string };

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
    return `The user selected the following text from an earlier message in this conversation:\n${content}`;
  }
  return null;
}

function projectMention(mention: ParsedMention, pickedPaths: string[]): Projection | null {
  if (isOpenEditorFile(mention)) {
    if (pickedPaths.includes(mention.path)) return { text: '' };
    const note = `The user opened the file ${notePath(mention.path)} in the IDE. ${MAY_BE_UNRELATED}`;
    return { text: '', note };
  }
  // A plain path: a leading `@` would make the Claude CLI attach the file itself.
  if (isPicked(mention)) return { text: mention.path, note: pickedNote(pickedPaths) };
  const note = mention.fullText ? selectionNote(mention, mention.fullText) : null;
  return note ? { text: '', note } : null;
}

/** A person typed it, or retried a turn no task dispatched (a new chat's first message is sent so).
 * Flow, dispatch, wake and plan-approval text can quote outside text that looks like a token. */
export function isPersonAuthored(delivery: MessageDelivery | undefined): boolean {
  const origin = delivery?.messageOrigin;
  const retried = origin?.source === 'internal' && origin.kind === 'regenerate';
  return origin?.source === 'person' || (retried && !delivery?.dispatchTaskId);
}

/** Says what the composer's file and selection tokens mean, in Claude Code's own sentences. Notes
 * lead unless the message opens with a slash command; `/compact` and other tokens stay as sent. */
export function projectComposerContext(message: string): string {
  if (isCompactCommand(message)) return message;
  const tokens = findMentionTokens(message).map((token) => ({
    ...token,
    mention: parseMention(token.id),
  }));
  const pickedPaths = [
    ...new Set(
      tokens.flatMap(({ mention }) => (mention && isPicked(mention) ? [mention.path] : [])),
    ),
  ];
  const notes = new Set<string>();
  let text = '';
  let cursor = 0;
  for (const { start, end, mention } of tokens) {
    const projection = mention && projectMention(mention, pickedPaths);
    if (!projection) continue;
    text += message.slice(cursor, start) + projection.text;
    // A removed token takes the space that separated it from the text after it.
    cursor = !projection.text && message[end] === ' ' ? end + 1 : end;
    if (projection.note) notes.add(projection.note);
  }
  if (notes.size === 0) return message;
  text += message.slice(cursor);
  const reminders = wrapRemindersForPrompt([...notes]);
  // The Claude CLI runs a slash command only from the start of the prompt.
  if (SLASH_COMMAND_REGEX.test(message)) return `${text}\n\n${reminders}`;
  return text.trim() ? `${reminders}\n\n${text}` : reminders;
}
