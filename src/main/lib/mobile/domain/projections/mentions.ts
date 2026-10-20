import {
  findMentionTokens,
  MENTION_PREFIXES,
} from '../../../../../shared/lib/mentions/mention-grammar';
import { type ParsedMention, parseMention } from '../../../../../shared/lib/mentions/parse-mention';
import type { MobileMessagePart, MobileTextRun } from '../../../../../shared/types/remote/mobile';

type Attachment = Extract<MobileMessagePart, { type: 'attachment' }>;

const KNOWN_PREFIXES: readonly string[] = Object.values(MENTION_PREFIXES);

// As on the desktop: files, folders, skills, agents and tools are badges inside the sentence, while
// selections and pastes sit beside it as attachments.
const BADGE_KINDS = new Map<string, NonNullable<MobileTextRun['mention']>>([
  [MENTION_PREFIXES.FILE, 'file'],
  [MENTION_PREFIXES.FOLDER, 'folder'],
  [MENTION_PREFIXES.SKILL, 'skill'],
  [MENTION_PREFIXES.AGENT, 'agent'],
  [MENTION_PREFIXES.TOOL, 'tool'],
]);

/** A selection as the desktop's chip: the file and its lines, or the first line of quoted words. */
function attachment(mention: ParsedMention | null): Attachment {
  if (mention?.type === 'quote')
    return {
      type: 'attachment',
      kind: 'text',
      name: mention.label.trim().split('\n')[0] || 'Quote',
    };
  if (mention?.type === 'code' || mention?.type === 'diff') {
    const lines = mention.lineRange ?? mention.lineNumber;
    const chip: Attachment = {
      type: 'attachment',
      kind: 'file',
      name: mention.path.split('/').pop() || 'Attachment',
    };
    if (lines) chip.detail = `L${lines}`;
    return chip;
  }
  return { type: 'attachment', kind: 'file', name: mention?.label || 'Attachment' };
}

/** A token's badge or attachment, or null to leave a token of unknown kind as the user wrote it. */
function projectToken(id: string): MobileTextRun | Attachment | null {
  const prefix = KNOWN_PREFIXES.find((known) => id.startsWith(known));
  if (!prefix) return null;
  const mention = parseMention(id);
  const badge = BADGE_KINDS.get(prefix);
  if (badge) {
    // A token with nothing to name shows its kind ("Skill"), never a fragment like "editor:".
    const name = mention ? mention.label.trim() : id.slice(prefix.length);
    return { text: name || badge[0].toUpperCase() + badge.slice(1), mention: badge };
  }
  return attachment(mention);
}

/** The text's ends trimmed, as the bubble shows it, without the runs the trim empties. */
function trimRuns(runs: MobileTextRun[]) {
  const first = runs[0];
  if (first && !first.mention) first.text = first.text.trimStart();
  const last = runs.at(-1);
  if (last && !last.mention) last.text = last.text.trimEnd();
  return runs.filter((run) => run.text);
}

/** The text as runs with every token replaced; `lift` takes attachments out of the text. */
function rewriteMentions(body: string, lift: boolean) {
  const runs: MobileTextRun[] = [];
  const attachments: Attachment[] = [];
  const write = (run: MobileTextRun) => {
    const last = runs.at(-1);
    if (!run.mention && last && !last.mention) last.text += run.text;
    else if (run.text) runs.push(run);
  };
  let cursor = 0;
  for (const { id, start, end } of findMentionTokens(body)) {
    const projection = projectToken(id);
    if (!projection) continue;
    write({ text: body.slice(cursor, start) });
    cursor = end;
    if (!('type' in projection)) write(projection);
    else if (!lift) write({ text: [projection.name, projection.detail].filter(Boolean).join(' ') });
    else {
      attachments.push(projection);
      // A token lifted out of the text takes the space that separated it from the text after it.
      if (body[end] === ' ') cursor = end + 1;
    }
  }
  write({ text: body.slice(cursor) });
  return { runs: trimRuns(runs), attachments };
}

/** The runs' text, carrying the runs only when one of them is a badge. */
function withRuns(runs: MobileTextRun[]) {
  const text = runs.map((run) => run.text).join('');
  return runs.some((run) => run.mention) ? { text, runs } : { text };
}

/** A user's message as the phone shows it: names as badges and selections as attachment chips,
 * never raw tokens or the base64 a selection carries. */
export function projectMentions(body: string): MobileMessagePart[] {
  const { runs, attachments } = rewriteMentions(body, true);
  const text = withRuns(runs);
  return text.text ? [...attachments, { type: 'text', ...text }] : attachments;
}

/** A user's text as one note with every name where it was typed, for a steer (no chips). */
export function projectMentionsAsText(body: string) {
  return withRuns(rewriteMentions(body, false).runs);
}
