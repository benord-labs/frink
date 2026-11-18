import { describe, expect, it } from 'vitest';
import { diffText } from './text-diff';

const PROMPT = [
  'You are shipping the work for this story. Open a pull request with devkit ship.',
  "Write the PR description from the story's acceptance criteria. Keep it short.",
  'Link every follow-up story you filed.',
  'Do not merge the PR. Stop once it is open and report the URL.',
].join('\n\n');

describe('diffText', () => {
  it('sizes a one-word typo fix as a tiny edit and previews the exact swap', () => {
    const diff = diffText(PROMPT.replace('acceptance', 'acceptence'), PROMPT);

    expect(diff).toMatchObject({ size: 'tiny', addedWords: 1, removedWords: 1 });
    expect(diff.preview).toEqual([
      { kind: 'removed', text: 'acceptence' },
      { kind: 'added', text: 'acceptance' },
    ]);
  });

  it('sizes an added sentence as a small edit and folds the paragraphs it did not touch', () => {
    const after = PROMPT.replace(
      'Keep it short.',
      'Keep it short. If the change touches the UI, attach before and after screenshots.',
    );

    const diff = diffText(PROMPT, after);

    expect(diff).toMatchObject({ size: 'small', addedWords: 11, removedWords: 0 });
    expect(diff.paragraphs.map((paragraph) => paragraph.changed)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(diff.preview[0]?.text).toBe(
      'If the change touches the UI, attach before and after screenshots.',
    );
  });

  it('calls mostly new text a rewrite, previews its opening line and skips the word diff', () => {
    const diff = diffText(PROMPT, 'Ship this story as one PR.\nRun every gate first.');

    expect(diff.size).toBe('rewritten');
    expect(diff.paragraphs).toEqual([]);
    expect(diff.preview).toEqual([{ kind: 'same', text: 'Ship this story as one PR.' }]);
  });

  it('calls a short field with every word replaced a rewrite, not a tiny edit', () => {
    expect(diffText('Ship it now', 'Merge that please').size).toBe('rewritten');
  });

  it('clips a long preview without splitting an emoji', () => {
    const after = `${'a'.repeat(158)}🚀 and more words after the cut`;

    const [opening] = diffText('Completely different text here', after).preview;

    expect(opening?.text).toBe(`${'a'.repeat(158)}🚀…`);
  });

  it('reports a whitespace-only edit as formatting with no word counts or preview', () => {
    const diff = diffText(PROMPT, PROMPT.replaceAll('\n\n', '\n\n\n'));

    expect(diff).toMatchObject({ size: 'formatting', addedWords: 0, removedWords: 0, preview: [] });
  });

  it('stops diffing an edit too large to compute cheaply, without guessing word counts', () => {
    const before = Array.from({ length: 4000 }, (_, index) => `old${index}`).join(' ');
    const after = Array.from({ length: 4000 }, (_, index) => `new${index}`).join(' ');

    const diff = diffText(before, after);

    expect(diff).toMatchObject({ size: 'rewritten', paragraphs: [] });
    expect(diff.addedWords).toBeUndefined();
  });
});
