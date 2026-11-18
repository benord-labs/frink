import { type Change, diffWords } from 'diff';

export type TextDiffSize = 'formatting' | 'tiny' | 'small' | 'edited' | 'rewritten';

export type DiffSegment = { kind: 'same' | 'added' | 'removed'; text: string };

export type DiffParagraph = { changed: boolean; segments: DiffSegment[] };

export type TextDiff = {
  size: TextDiffSize;
  /** Absent when the edit was too large to diff, so counts would be guesses. */
  addedWords?: number;
  removedWords?: number;
  /** Empty for a rewrite: a word diff of mostly-new text is unreadable, so callers show the text. */
  paragraphs: DiffParagraph[];
  /** One-line collapsed preview: the swapped words, the first changed phrase, or the new opening. */
  preview: DiffSegment[];
};

/** Bounds the diff's cost on the renderer thread; a longer edit script is treated as a rewrite. */
const MAX_EDIT_LENGTH = 1500;
const TINY_EDIT_WORDS = 3;
const SMALL_EDIT_KEPT = 0.75;
const EDITED_KEPT = 0.4;
const PREVIEW_CHARS = 160;
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/;
const WORD = /\S+/g;

function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

function segmentKind(change: Change): DiffSegment['kind'] {
  if (change.added) return 'added';
  return change.removed ? 'removed' : 'same';
}

function classify(addedWords: number, removedWords: number, keptWords: number): TextDiffSize {
  if (addedWords + removedWords === 0) return 'formatting';
  const kept = keptWords / Math.max(keptWords + removedWords, keptWords + addedWords);
  if (kept < EDITED_KEPT) return 'rewritten';
  if (addedWords <= TINY_EDIT_WORDS && removedWords <= TINY_EDIT_WORDS) return 'tiny';
  return kept >= SMALL_EDIT_KEPT ? 'small' : 'edited';
}

function clip(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function toParagraphs(segments: DiffSegment[]): DiffParagraph[] {
  const paragraphs: DiffParagraph[] = [{ changed: false, segments: [] }];
  for (const segment of segments) {
    // diffWords attaches surrounding whitespace, so a paragraph break can sit inside any segment.
    segment.text.split(PARAGRAPH_BREAK).forEach((text, index) => {
      if (index > 0) paragraphs.push({ changed: false, segments: [] });
      if (!text) return;
      const current = paragraphs[paragraphs.length - 1];
      const kind = /\S/.test(text) ? segment.kind : 'same';
      current.segments.push({ kind, text });
      if (kind !== 'same') current.changed = true;
    });
  }
  return paragraphs.filter((paragraph) => paragraph.segments.length > 0);
}

function previewFor(size: TextDiffSize, changed: DiffSegment[], after: string): DiffSegment[] {
  if (size === 'formatting') return [];
  if (size === 'rewritten') {
    const opening = clip(after.trim().split('\n')[0] ?? '');
    return opening ? [{ kind: 'same', text: opening }] : [];
  }
  if (size === 'tiny') return changed.map((segment) => ({ ...segment, text: clip(segment.text) }));
  const phrase = changed.find((segment) => countWords(segment.text) >= 3) ?? changed[0];
  return phrase ? [{ ...phrase, text: clip(phrase.text) }] : [];
}

/** Word-level diff of one text field, sized so a reader can tell a typo fix from a rewrite. */
export function diffText(before: string, after: string): TextDiff {
  const changes = diffWords(before, after, { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) {
    return {
      size: 'rewritten',
      paragraphs: [],
      preview: previewFor('rewritten', [], after),
    };
  }
  const segments = changes.map((change) => ({ kind: segmentKind(change), text: change.value }));
  const words = { added: 0, removed: 0, same: 0 };
  for (const segment of segments) words[segment.kind] += countWords(segment.text);
  const size = classify(words.added, words.removed, words.same);
  const changed = segments.filter((segment) => segment.kind !== 'same');
  return {
    size,
    addedWords: words.added,
    removedWords: words.removed,
    paragraphs: size === 'rewritten' ? [] : toParagraphs(segments),
    preview: previewFor(size, changed, after),
  };
}
