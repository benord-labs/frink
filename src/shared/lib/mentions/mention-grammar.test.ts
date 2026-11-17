import { describe, expect, it } from 'vitest';
import { findMentionTokens } from './mention-grammar';

describe('findMentionTokens', () => {
  it.each(['', 'plain text, user@example.com and [brackets]', '@[]'])(
    'finds no token in %j',
    (text) => {
      expect(findMentionTokens(text)).toStrictEqual([]);
    },
  );

  it('finds adjacent tokens with touching offsets', () => {
    expect(findMentionTokens('@[skill:a]@[agent:b]')).toStrictEqual([
      { id: 'skill:a', start: 0, end: 10 },
      { id: 'agent:b', start: 10, end: 20 },
    ]);
  });

  it('finds a token at the start and at the end of the text', () => {
    const text = '@[file:local:a.ts] then @[skill:x]';
    const tokens = findMentionTokens(text);

    expect(tokens).toStrictEqual([
      { id: 'file:local:a.ts', start: 0, end: 18 },
      { id: 'skill:x', start: 24, end: text.length },
    ]);
    expect(tokens.map(({ start, end }) => text.slice(start, end))).toStrictEqual([
      '@[file:local:a.ts]',
      '@[skill:x]',
    ]);
  });

  it('reads an id that spans line breaks', () => {
    expect(findMentionTokens('a @[quote:one\ntwo] b')).toStrictEqual([
      { id: 'quote:one\ntwo', start: 2, end: 18 },
    ]);
  });

  it('ignores an unterminated token', () => {
    expect(findMentionTokens('see @[file:local:a.ts')).toStrictEqual([]);
  });

  it('reads an unterminated opener through to the next closing bracket', () => {
    expect(findMentionTokens('@[oops then @[skill:x] end')).toStrictEqual([
      { id: 'oops then @[skill:x', start: 0, end: 22 },
    ]);
  });

  it.each(['src/app/[id]/page.tsx', 'app/[[...slug]]/page.tsx', 'src/[a]/[b].ts'])(
    'keeps the paired brackets of the route path %s inside the token',
    (path) => {
      const text = `@[file:local:${path}] fix it`;

      expect(findMentionTokens(text)).toStrictEqual([
        { id: `file:local:${path}`, start: 0, end: text.indexOf(' fix') },
      ]);
    },
  );

  it.each([
    ['@[file:local:notes[draft.md] summarise', ['file:local:notes[draft.md']],
    ['@[file:local:notes[draft.md] is great] ok', ['file:local:notes[draft.md']],
    ['@[file:a[b] @[file:c] d] e', ['file:a[b', 'file:c']],
    ['@[file:notes[draft.md] see @[file:b.md] ok]', ['file:notes[draft.md', 'file:b.md']],
  ])('ends an id with an unpaired bracket at the first closing bracket: %j', (text, ids) => {
    expect(findMentionTokens(text).map(({ id }) => id)).toStrictEqual(ids);
  });

  it('returns the same tokens when called twice in a row', () => {
    const text = 'a @[skill:x] b @[agent:y]';
    const first = findMentionTokens(text);

    expect(first).toStrictEqual([
      { id: 'skill:x', start: 2, end: 12 },
      { id: 'agent:y', start: 15, end: 25 },
    ]);
    expect(findMentionTokens(text)).toStrictEqual(first);
  });

  it('starts every scan at the beginning, whatever text the previous call scanned', () => {
    findMentionTokens('a long text that ends in a token @[skill:x]');

    expect(findMentionTokens('@[agent:y]')).toStrictEqual([{ id: 'agent:y', start: 0, end: 10 }]);
  });
});
