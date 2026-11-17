import { describe, expect, it } from 'vitest';
import { parseMention } from '../../../shared/lib/mentions/parse-mention';
import {
  attachedContextFile,
  buildQueuedMessageText,
  createTextPreview,
  diffMention,
  openFileMention,
  quoteMention,
} from './queued-message-text';

type Item = Parameters<typeof buildQueuedMessageText>[0];
const item = (over: Partial<Item>): Item => ({ message: 'do the thing', ...over });

describe('buildQueuedMessageText', () => {
  it('prefixes a normal queued message with its quote and diff mentions', () => {
    const text = buildQueuedMessageText(
      item({
        textContexts: [{ text: 'quoted source' }],
        diffTextContexts: [{ text: 'diff body', filePath: 'a.ts', lineNumber: 7 }],
      }),
    );

    expect(text.endsWith('do the thing')).toBe(true);
    expect(text).toContain('@[');
    expect(text.startsWith('@[')).toBe(true);
  });

  it('leaves a queued /compact at position 0 despite attached context', () => {
    const text = buildQueuedMessageText(
      item({
        message: '/compact',
        textContexts: [{ text: 'quoted source' }],
        diffTextContexts: [{ text: 'diff body', filePath: 'a.ts', lineNumber: 7 }],
      }),
    );

    expect(text).toBe('/compact');
  });

  it('returns the bare message when no context is attached', () => {
    expect(buildQueuedMessageText(item({}))).toBe('do the thing');
  });

  it('returns an empty string for an empty message with no context', () => {
    // The caller pushes a text part only when this is non-empty; an images-only queue item
    // must not gain a stray blank text part.
    expect(buildQueuedMessageText(item({ message: '' }))).toBe('');
  });

  it('serializes a pasted-text chip so a queued paste is not dropped (sc-3666)', () => {
    const text = buildQueuedMessageText(
      item({
        message: '',
        pastedTexts: [
          { size: 6000, preview: 'Build a [cron] flow...', filePath: '/s/pasted/p_1.txt' },
        ],
      }),
    );

    // Brackets are stripped so the token cannot terminate early; `|` separates the path.
    expect(text).toBe('@[pasted:6000:Build a cron flow...|/s/pasted/p_1.txt]');
  });

  it('carries a terminal chip label through to the parsed mention', () => {
    const text = buildQueuedMessageText(
      item({
        message: '',
        pastedTexts: [
          { size: 9, preview: 'Terminal 1 output', filePath: '/s/pasted/terminal_1.txt' },
        ],
      }),
    );

    expect(parseMention(text.slice(2, -1))).toMatchObject({
      type: 'pasted',
      label: 'Terminal 1 output',
      path: '/s/pasted/terminal_1.txt',
    });
  });

  it('keeps a path that contains colons intact after the | separator', () => {
    const text = buildQueuedMessageText(
      item({ pastedTexts: [{ size: 1, preview: 'p', filePath: 'C:\\Users\\a\\pasted\\x.txt' }] }),
    );

    expect(text).toBe('@[pasted:1:p|C:\\Users\\a\\pasted\\x.txt] do the thing');
  });

  it('serializes a code selection in the direct-send token shape', () => {
    const text = buildQueuedMessageText(
      item({
        codeSelectionContexts: [
          { text: 'const ü = 1;', fileName: 'a b.ts', startLine: 3, endLine: 4 },
        ],
      }),
    );

    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode('const ü = 1;')));
    expect(text).toBe(`@[code:a%20b.ts:3-4:const ü = 1;:${encoded}] do the thing`);
  });

  it('drains a quote and a diff as the same tokens a direct send builds', () => {
    // Queued contexts carry no preview, so the drain once re-derived a raw 50-char slice and the
    // same quote got a different chip label than when it was sent directly.
    const long = `line one: [a]\n\n  line two ${'x'.repeat(60)}`;
    const text = buildQueuedMessageText(
      item({
        message: '',
        textContexts: [{ text: long }],
        diffTextContexts: [{ text: long, filePath: 'src/a.ts', lineNumber: 3 }],
      }),
    );

    expect(text).toBe(
      `${quoteMention({ text: long })} ${diffMention({ text: long, filePath: 'src/a.ts', lineNumber: 3 })}`,
    );
  });

  it('orders quote, diff, code, pasted mentions exactly once ahead of the message', () => {
    const text = buildQueuedMessageText(
      item({
        textContexts: [{ text: 'q' }],
        diffTextContexts: [{ text: 'd', filePath: 'a.ts', lineNumber: 1 }],
        codeSelectionContexts: [{ text: 'c', fileName: 'b.ts', startLine: 1, endLine: 1 }],
        pastedTexts: [{ size: 9, preview: 'p', filePath: '/p.txt' }],
      }),
    );

    const order = ['@[quote:', '@[diff:', '@[code:', '@[pasted:', 'do the thing'].map((t) =>
      text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.match(/@\[pasted:/g)).toHaveLength(1);
  });

  it('still leaves /compact bare when a pasted chip is attached', () => {
    expect(
      buildQueuedMessageText(
        item({ message: '/compact', pastedTexts: [{ size: 1, preview: 'p', filePath: '/p' }] }),
      ),
    ).toBe('/compact');
  });
});

describe('quoteMention / diffMention', () => {
  const base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const long = `const ü: Item[] = [];\n\n  return   ${'y'.repeat(40)}`;

  // The exact strings the direct send built before the builders existed: the stored
  // createTextPreview preview, sanitised, then base64 of the UTF-8 bytes.
  it('keeps the quote wire format byte-identical', () => {
    expect(quoteMention({ text: 'café ✓' })).toBe(`@[quote:café ✓:${base64('café ✓')}]`);
    expect(quoteMention({ text: long })).toBe(
      `@[quote:const ü Item = ; return ${'y'.repeat(21)}...:${base64(long)}]`,
    );
  });

  // Same as before except the path, now URI-encoded like a code token's file name.
  it('pins the diff wire format, with line 0 when there is none', () => {
    expect(diffMention({ text: 'ok', filePath: 'src/a b.ts', lineNumber: 12 })).toBe(
      `@[diff:src%2Fa%20b.ts:12:ok:${base64('ok')}]`,
    );
    expect(diffMention({ text: long, filePath: 'src/a.ts' })).toBe(
      `@[diff:src%2Fa.ts:0:const ü Item = ; return ${'y'.repeat(21)}...:${base64(long)}]`,
    );
  });
});

describe('createTextPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(createTextPreview('  a\n\n b\tc  ')).toBe('a b c');
  });

  it('truncates past the limit with an ellipsis', () => {
    expect(createTextPreview('x'.repeat(50))).toBe('x'.repeat(50));
    expect(createTextPreview('x'.repeat(51))).toBe(`${'x'.repeat(50)}...`);
    expect(createTextPreview('abcdef', 3)).toBe('abc...');
  });

  it('never cuts an emoji in half at the limit', () => {
    // Half a surrogate pair renders as � in the chip label.
    expect(createTextPreview(`${'a'.repeat(49)}😀 more`)).toBe(`${'a'.repeat(49)}...`);
    expect(createTextPreview(`${'a'.repeat(48)}😀 more`)).toBe(`${'a'.repeat(48)}😀...`);
  });
});

describe('attachedContextFile', () => {
  const file = { name: 'notes.md', path: '/repo/notes.md' };
  const selection = { text: 'const a = 1;', fileName: 'other.ts', startLine: 1, endLine: 2 };

  it('attaches the open file by default', () => {
    expect(attachedContextFile(file, false, null)).toBe(file);
  });

  it('attaches nothing once the user removed the file', () => {
    expect(attachedContextFile(file, true, null)).toBeNull();
  });

  it('lets a code selection stand in for the file, whichever file it came from', () => {
    expect(attachedContextFile(file, false, selection)).toBeNull();
  });

  it('attaches nothing when no file was ever opened', () => {
    expect(attachedContextFile(null, false, null)).toBeNull();
    expect(attachedContextFile(undefined, false, null)).toBeNull();
  });
});

describe('openFileMention', () => {
  const file = { path: '/repo/notes.md' };
  const token = '@[file:editor:/repo/notes.md]';

  it('builds the open-file token for an attached file', () => {
    expect(openFileMention(file, 'hello')).toBe(token);
    expect(openFileMention(file, '')).toBe(token);
  });

  it('returns null when nothing is attached', () => {
    expect(openFileMention(null, 'hello')).toBeNull();
  });

  it('keeps /compact context-free', () => {
    expect(openFileMention(file, '/compact')).toBeNull();
  });

  it('skips a file the text already mentions, and only that file', () => {
    expect(openFileMention(file, `${token} hello`)).toBeNull();
    expect(openFileMention(file, '@[file:editor:/repo/other.md] hello')).toBe(token);
  });

  it('skips a file the user already picked from the @ menu', () => {
    expect(openFileMention(file, 'read @[file:local:/repo/notes.md] first')).toBeNull();
    expect(openFileMention(file, 'read @[file:local:/repo/other.md] first')).toBe(token);
  });
});
