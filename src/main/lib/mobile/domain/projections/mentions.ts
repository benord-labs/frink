import {
  findMentionTokens,
  MENTION_PREFIXES,
} from '../../../../../shared/lib/mentions/mention-grammar';
import { parseMention } from '../../../../../shared/lib/mentions/parse-mention';
import type { MobileMessagePart } from '../../../../../shared/types/remote/mobile';

const KNOWN_PREFIXES: readonly string[] = Object.values(MENTION_PREFIXES);

// As on the desktop: files, folders, skills, agents and tools read as part of the sentence, while
// selections, pastes and briefings sit beside it as attachments.
const INLINE_PREFIXES: readonly string[] = [
  MENTION_PREFIXES.FILE,
  MENTION_PREFIXES.FOLDER,
  MENTION_PREFIXES.SKILL,
  MENTION_PREFIXES.AGENT,
  MENTION_PREFIXES.TOOL,
];

type TokenProjection = { inline: string } | { attachment: string };

/** A token's readable form, or null to leave a token of unknown kind as the user wrote it. */
function projectToken(id: string): TokenProjection | null {
  const prefix = KNOWN_PREFIXES.find((known) => id.startsWith(known));
  if (!prefix) return null;
  const label = parseMention(id)?.label;
  if (INLINE_PREFIXES.includes(prefix)) return { inline: label || id.slice(prefix.length) || id };
  return { attachment: label || 'Attachment' };
}

/** Replaces each token with its name; `lift` takes attachments out of the text into `names`. */
function rewriteMentions(body: string, lift: boolean) {
  const names: string[] = [];
  let text = '';
  let cursor = 0;
  for (const { id, start, end } of findMentionTokens(body)) {
    const projection = projectToken(id);
    if (!projection) continue;
    text += body.slice(cursor, start);
    if ('inline' in projection || !lift) {
      text += 'inline' in projection ? projection.inline : projection.attachment;
      cursor = end;
    } else {
      names.push(projection.attachment);
      // A token lifted out of the text takes the space that separated it from the text after it.
      cursor = body[end] === ' ' ? end + 1 : end;
    }
  }
  return { text: (text + body.slice(cursor)).trim(), names };
}

/** A user's message as the phone shows it: mention tokens become names and attachment chips, never
 * raw tokens or the base64 a selection carries. */
export function projectMentions(body: string): MobileMessagePart[] {
  const { text, names } = rewriteMentions(body, true);
  const chips = names.map((name) => ({ type: 'attachment', kind: 'file', name }) as const);
  return text ? [...chips, { type: 'text', text }] : chips;
}

/** A user's text as one plain note with every name where it was typed, for a steer (no chips). */
export function projectMentionsAsText(body: string): string {
  return rewriteMentions(body, false).text;
}
