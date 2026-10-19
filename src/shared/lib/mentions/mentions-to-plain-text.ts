import { findMentionTokens } from './mention-grammar';
import { isOpenEditorFile, type ParsedMention, parseMention } from './parse-mention';

const WHITESPACE_RE = /\s+/g;

/** A token the user chose and named, so its label reads as part of their sentence. */
function keepsLabelInline(mention: ParsedMention): boolean {
  switch (mention.type) {
    case 'file':
      return !isOpenEditorFile(mention);
    case 'folder':
    case 'skill':
    case 'agent':
    case 'tool':
      return true;
    default:
      return false;
  }
}

/** A message's own words, and the label of every token it carried. */
export type PlainTextMessage = { text: string; labels: string[] };

/** A message as readable text: chosen files, folders, skills, agents and tools read as their labels;
 * the open editor file and every selection or paste are removed. */
export function mentionsToPlainText(text: string): PlainTextMessage {
  const labels: string[] = [];
  let plain = '';
  let cursor = 0;
  for (const token of findMentionTokens(text)) {
    plain += `${text.slice(cursor, token.start)} `;
    cursor = token.end;
    const mention = parseMention(token.id);
    if (!mention) continue;
    if (mention.label) labels.push(mention.label);
    if (keepsLabelInline(mention)) plain += `${mention.label} `;
  }
  plain += text.slice(cursor);
  return { text: plain.replace(WHITESPACE_RE, ' ').trim(), labels };
}
