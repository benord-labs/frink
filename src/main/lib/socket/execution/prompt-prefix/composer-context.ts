import { isCompactCommand } from '../../../../../shared/commands/expand-slash-command';
import {
  findMentionTokens,
  OPEN_EDITOR_FILE_SOURCE,
} from '../../../../../shared/lib/mentions/mention-grammar';
import type { CodexContextEntry } from '../../../../../shared/lib/message-markers/message-provenance';
import {
  isMachineSource,
  isMachineText,
} from '../../../../../shared/lib/message-markers/person-authored';
import { type ParsedMention, parseMention } from '../../../../../shared/lib/mentions/parse-mention';
import { wrapRemindersForPrompt } from '../../operator-reminders';
import type { MessageDelivery } from '../message-provenance/origin';

/** Claude Code's cap on the selected lines it quotes to the model. */
const SELECTION_LIMIT = 2000;
const MAY_BE_UNRELATED = 'This may or may not be related to the current task.';

type NoteKind =
  | 'open_file'
  | 'mentioned_paths'
  | 'selection'
  | 'attached_file'
  | 'skill'
  | 'agent'
  | 'tool';

/** A sentence for the model. A selection's body is text the user picked, which Frink cannot vouch for. */
export type ComposerNote = { kind: NoteKind; text: string };

/** A message as its provider reads it: the text for the prompt, the notes for its context channel. */
type ComposerProjection = { text: string; notes: ComposerNote[] };

/** What one token becomes: the text left in its place, and the note it adds, if any. */
type Projection = { text: string; note?: ComposerNote };

/** One token's rewrite, or null to leave it as written. */
type TokenRewrite = (mention: ParsedMention, pickedPaths: string[]) => Projection | null;

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

/** A code selection's first and last line, from its `start-end` range. */
function lineSpan(lineRange = ''): [string, string] {
  const [start, end = start] = lineRange.split('-');
  return [start, end];
}

function lineCount(text: string): string {
  const count = text.split('\n').length;
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

/** Claude Code's sentence for an attached selection, or null for any other kind of token. */
function selectionNote(mention: ParsedMention, content: string): string | null {
  if (mention.type === 'code') {
    const [start, end] = lineSpan(mention.lineRange);
    return `The user selected the lines ${start} to ${end} from ${notePath(mention.path)}:\n${truncateSelection(content)}\n\n${MAY_BE_UNRELATED}`;
  }
  if (mention.type === 'diff') {
    const where = mention.path ? ` (in ${notePath(mention.path)})` : '';
    return `The user selected the following ${lineCount(content)} from the diff view${where}:\n${truncateSelection(content)}`;
  }
  if (mention.type === 'quote') {
    return `The user selected the following text from an earlier message in this conversation:\n${truncateSelection(content)}`;
  }
  return null;
}

function unavailable(what: string): string {
  return `If no ${what} is available to you, say so.`;
}

/** `mcp__<server>__<tool>` as the tool and its server, or the id whole when it has another shape. */
function toolNote(id: string): string {
  const [prefix, server, ...rest] = id.split('__');
  const named =
    prefix === 'mcp' && server && rest.length > 0
      ? `"${notePath(rest.join('__'))}" from the "${notePath(server)}" MCP server (\`${notePath(id)}\`)`
      : `"${notePath(id)}"`;
  return `The user picked the tool ${named}. Use it where it fits their request. ${unavailable('such tool')}`;
}

/** A pasted file or MCP tool, both named by a path. */
function pathAttachment({ type, path, label }: ParsedMention): Projection | null {
  if (!path) return null;
  if (type === 'pasted') {
    const text = `The user attached the file \`${notePath(path)}\`. Its contents are not in this message: read it with your file tools before responding.`;
    // In backticks, so a path cannot start a slash command and its spaces stay one path.
    return { text: `\`${path}\``, note: { kind: 'attached_file', text } };
  }
  if (type === 'tool') return { text: label || path, note: { kind: 'tool', text: toolNote(path) } };
  return null;
}

/** A skill or agent, named by its label. */
function namedAttachment({ type, label }: ParsedMention): Projection | null {
  if (!label) return null;
  const name = notePath(label);
  if (type === 'skill') {
    const text = `The user's message names the skill "${name}". If they are asking you to run it, run that skill with any arguments they gave (in Claude Code, with the Skill tool). If they only mention it, do not run it. ${unavailable('skill by that name')}`;
    return { text: label, note: { kind: 'skill', text } };
  }
  if (type === 'agent') {
    const text = `The user has expressed a desire to invoke the agent "${name}". Please invoke the agent appropriately, passing in the required context to it. ${unavailable('agent by that name')}`;
    return { text: label, note: { kind: 'agent', text } };
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
  if (text) return { text: '', note: { kind: 'selection', text } };
  return pathAttachment(mention) ?? namedAttachment(mention);
}

/** A selection in a replayed turn: where it came from and the text it quoted. */
function recapSelection({ type, path, fullText, lineRange }: ParsedMention): string | null {
  if (!fullText) return null;
  const body = truncateSelection(fullText);
  if (type === 'code')
    return `[selected lines ${lineSpan(lineRange).join('-')} of ${path}:\n${body}]`;
  if (type === 'diff') {
    const where = path ? `the diff of ${path}` : 'the diff view';
    return `[selected ${lineCount(fullText)} from ${where}:\n${body}]`;
  }
  return type === 'quote' ? `[quoted an earlier message:\n${body}]` : null;
}

/** A pasted file, skill, agent or tool in a replayed turn, by what it was called. */
function recapAttachment({ type, path, label }: ParsedMention): string | null {
  if (type === 'pasted' || type === 'tool') {
    return path ? `[${type === 'pasted' ? 'attached file' : 'tool'} ${path}]` : null;
  }
  return (type === 'skill' || type === 'agent') && label ? `[${type} ${label}]` : null;
}

/** A token as a past fact in a replayed turn: nothing in it asks the model to act again. */
function recapMention(mention: ParsedMention, pickedPaths: string[]): Projection | null {
  const { path } = mention;
  if (isOpenEditorFile(mention)) {
    return { text: pickedPaths.includes(path) ? '' : `[had ${path} open in the IDE]` };
  }
  if (isPicked(mention)) return { text: path };
  const text = recapSelection(mention) ?? recapAttachment(mention);
  return text ? { text } : null;
}

/** Rewrites each token `rewrite` knows; the text is the message itself when none was rewritten. */
function rewriteTokens(message: string, rewrite: TokenRewrite) {
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
    const projection = mention && rewrite(mention, pickedPaths);
    if (!projection) continue;
    text += message.slice(cursor, start) + projection.text;
    // A removed token takes the space that separated it from the text after it.
    cursor = !projection.text && message[end] === ' ' ? end + 1 : end;
    if (projection.note) notes.set(projection.note.text, projection.note);
  }
  return { text: cursor ? text + message.slice(cursor) : message, notes: [...notes.values()] };
}

/** A person typed it, or retried a turn no task dispatched (a new chat's first message is sent so).
 * Text Frink, a flow or a Work Queue task wrote can quote outside text that looks like a token. */
export function isPersonAuthored(delivery: MessageDelivery | undefined, raw: string): boolean {
  const origin = delivery?.messageOrigin;
  const retried = origin?.source === 'internal' && origin.kind === 'regenerate';
  const person = origin?.source === 'person' || (retried && !delivery?.dispatchTaskId);
  return person && !isMachineSource(delivery?.messageSource) && !isMachineText(raw);
}

/** Says what the composer's tokens mean, in notes for the provider's own context channel.
 * `/compact` and unknown tokens stay as sent. */
export function projectComposerContext(message: string): ComposerProjection {
  if (isCompactCommand(message)) return { text: message, notes: [] };
  const { text, notes } = rewriteTokens(message, projectMention);
  if (notes.length === 0) return { text: message, notes: [] };
  // Inline only when nothing was typed, so no prompt is empty.
  if (text.trim()) return { text, notes };
  const reminders = wrapRemindersForPrompt(notes.map((note) => note.text));
  return { text: text.trim() ? `${reminders}\n\n${text}` : reminders, notes: [] };
}

/** A person's earlier turn for a replayed transcript, its tokens written as what they were. */
export function recapComposerTokens(content: string): string {
  return rewriteTokens(content, recapMention).text;
}

/** Only a selection carries text the user picked; every other note is Frink's own sentence. */
const CODEX_TRUST = {
  open_file: 'application',
  mentioned_paths: 'application',
  selection: 'untrusted',
  attached_file: 'application',
  skill: 'application',
  agent: 'application',
  tool: 'application',
} satisfies Record<NoteKind, CodexContextEntry['kind']>;

/** The notes as Codex host context. One entry each: Codex cuts every value at 1,000 tokens. */
export function codexComposerContext(notes: ComposerNote[]) {
  const counts = new Map<NoteKind, number>();
  return Object.fromEntries(
    notes.map(({ kind, text }): [string, CodexContextEntry] => {
      const index = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, index);
      return [`frink_${kind}_${index}`, { kind: CODEX_TRUST[kind], value: text }];
    }),
  );
}
