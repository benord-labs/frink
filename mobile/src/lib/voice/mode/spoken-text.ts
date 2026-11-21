/** The prose of a markdown reply, as sentences worth reading aloud. */
export type Spoken = {
  sentences: string[];
  /** Something was left out: code, a table, a diff or a bare file path. */
  hidden: boolean;
};

/** A code fence: its mark (backtick or tilde), how many, and any text after them. */
type Fence = { mark: string; size: number; info: string };

const FENCE = /^(`{3,}|~{3,})(.*)$/;
/** Indent and quote marks: all that may come before a closing fence. */
const QUOTED = /^\s*(?:>\s*)*/;
const TABLE_ROW = /^\|/;
/** A bare path with a slash: ending in a file name with an extension, or at least three parts deep,
 *  so "yes/no" is still read. */
const PATH_ONLY =
  /^`?(?:[~.]?\/)?(?:(?:[\w.@-]+\/)+[\w@-]*\.\w+|(?:[\w.@-]+\/){2,}[\w.@-]+)\/?`?[.:]?\s*$/;
const MARKERS = /^\s*(?:#{1,6}\s+|>\s*|(?:[-*+]|\d+[.)])\s+)+/;
/** A sentence ends at a stop, with any closing quote or bracket, before a space or the line's end. */
const SENTENCE_END = /[.!?…]+["'”’)\]]*(\s+|$)/g;
const HAS_WORDS = /[\p{L}\p{N}]/u;
/** A link or image not yet closed at the end of the text so far. */
const OPEN_LINK = /!?\[[^\]]*(?:\](?:\([^)]*)?)?$/;
/** A tag not yet closed at the end of the text so far. */
const OPEN_TAG = /(?:^|[^\w])(<[a-z][^<>]*)$|(<\/[^<>]*)$/i;
/** An HTML tag: a closing one, or a name right after a `<` that starts a word, so `x<y and y>2`
 *  is not one. */
const TAG = /(^|[^\w])<[a-z][^<>]*>|<\/[a-z][^<>]*>/gi;
/** A web address, without the stop or bracket that ends the sentence around it. */
const URL = /https?:\/\/\S+?(?=[.,!?;:)\]'"”’]*(?:\s|$))/g;

/** A line without its indent, quote marks, heading marks or list marker. */
function bare(line: string): string {
  return line.replace(MARKERS, '').trimStart();
}

/** The fence a line opens or closes, if it is one. A backtick fence's text holds no backtick. */
function fenceOf(text: string): Fence | null {
  const match = FENCE.exec(text);
  if (!match) return null;
  const [, run, info] = match;
  if (run[0] === '`' && info.includes('`')) return null;
  return { mark: run[0], size: run.length, info };
}

/** A block ends only at a bare fence of the same mark, at least as long as the one that opened it;
 *  a list marker inside code is code. */
function closes(open: Fence, line: string): boolean {
  const fence = fenceOf(line.replace(QUOTED, ''));
  return !!fence && fence.mark === open.mark && fence.size >= open.size && !fence.info.trim();
}

/** Where markup still arriving begins: an unclosed link, image, tag or code span. */
function openMarkupAt(text: string): number {
  const ticks = [...text.matchAll(/`/g)];
  const open = OPEN_TAG.exec(text);
  const tag = open?.[1] ?? open?.[2];
  const starts = [
    text.search(OPEN_LINK),
    tag ? text.length - tag.length : -1,
    ticks.length % 2 ? (ticks.at(-1)?.index ?? -1) : -1,
  ].filter((at) => at >= 0);
  return starts.length ? Math.min(...starts) : text.length;
}

/** Markdown inline formatting reduced to the words a listener needs. Spaces are kept. */
function plainWords(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(URL, 'a link')
    .replace(TAG, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|__|~~|\*/g, '');
}

/** Sentences of one line, split after formatting is removed. An open line is still arriving, so
 *  markup not yet closed and the unfinished tail are held back. */
function lineSentences(line: string, open: boolean): string[] {
  const settled = open ? line.slice(0, openMarkupAt(line)) : line;
  const text = plainWords(settled.replace(MARKERS, ''));
  const pieces: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (open && end === text.length && !match[1]) break;
    pieces.push(text.slice(start, end));
    start = end;
  }
  if (!open) pieces.push(text.slice(start));
  return pieces.map((piece) => piece.trim()).filter((sentence) => HAS_WORDS.test(sentence));
}

/** Tables and bare paths are left out of what is read aloud. */
function unreadable(line: string): boolean {
  return TABLE_ROW.test(bare(line)) || PATH_ONLY.test(bare(line));
}

/**
 * The sentences of `markdown` to read aloud. Until `complete`, the text may still grow, so only
 * sentences that can no longer change are given: growing text keeps every sentence given before.
 */
export function spokenText(markdown: string, complete: boolean): Spoken {
  const lines = markdown.split(/\r?\n/);
  const sentences: string[] = [];
  let hidden = false;
  let fence: Fence | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      if (closes(fence, line)) fence = null;
      continue;
    }
    const open = !complete && index === lines.length - 1;
    fence = fenceOf(bare(line));
    // A line still arriving may yet turn into prose, so only a fence marks it hidden.
    if (fence || unreadable(line)) hidden ||= !!line.trim() && (!!fence || !open);
    else sentences.push(...lineSentences(line, open));
  }
  return { sentences, hidden };
}
