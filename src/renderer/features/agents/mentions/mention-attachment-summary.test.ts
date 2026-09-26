// @vitest-environment happy-dom
/**
 * Seam test: every mention type `extractTextMentions` can emit must produce a non-empty
 * "Using X" label.
 *
 * The two sides drifted once already — the producer emitted a `code` type that the label
 * helper did not count, so an editor-selection-only message rendered a styled bubble around
 * an empty string. A unit test over hand-built `{ type }` objects cannot catch that class of
 * bug, because whoever writes it already knows which types to list. This test drives real
 * mention tokens (the exact strings the composer builds) through the real parser instead.
 *
 * If you add a prefix to `extractTextMentions`, add its token here.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatAttachmentSummaryLabel } from '@/lib/agent-chat/format-attachment-summary';
import { encodeForMentionToken } from '@/lib/mentions/briefing-base64';

// Mock trpc (pulled in by the agents-file-mention transitive dep, unused by the parser).
vi.mock('../../../lib/trpc', () => ({
  trpc: {},
}));

import { extractTextMentions } from './render-file-mentions';

/** Mirrors MENTION_PREVIEW_SANITIZE_REGEX, which every producer applies to preview text. */
const sanitisePreview = (preview: string) => preview.replace(/[:[\]]/g, '');

const quoteToken = (text: string) =>
  `@[quote:${sanitisePreview(text)}:${encodeForMentionToken(text)}]`;

const diffToken = (filePath: string, line: number, text: string) =>
  `@[diff:${filePath}:${line}:${sanitisePreview(text)}:${encodeForMentionToken(text)}]`;

const codeToken = (fileName: string, startLine: number, endLine: number, text: string) =>
  `@[code:${encodeURIComponent(fileName)}:${startLine}-${endLine}:${sanitisePreview(text)}:${encodeForMentionToken(text)}]`;

const pastedToken = (size: number, preview: string, filePath: string) =>
  `@[pasted:${size}:${sanitisePreview(preview)}|${filePath}]`;

const labelFor = (text: string, imageCount = 0) =>
  formatAttachmentSummaryLabel(imageCount, extractTextMentions(text).textMentions);

describe('mention token -> attachment summary label', () => {
  it.each([
    ['quote', quoteToken('const total = sum(items);'), 'Using selected text'],
    ['pasted', pastedToken(4096, 'a long pasted blob', '/tmp/pasted-1.txt'), 'Using selected text'],
    ['diff', diffToken('src/app.ts', 12, 'return cached;'), 'Using code selection'],
    ['code', codeToken('src/app.ts', 13, 26, 'export function run() {}'), 'Using code selection'],
  ])('%s tokens produce a labelled bubble, never a blank one', (_type, token, expected) => {
    expect(labelFor(token)).toBe(expected);
  });

  it('leaves no text behind, so the message is genuinely attachment-only', () => {
    const { textMentions, cleanedText } = extractTextMentions(
      codeToken('src/app.ts', 13, 26, 'export function run() {}'),
    );

    // Both conditions the render branch checks: empty prose, and at least one mention.
    expect(cleanedText.trim()).toBe('');
    expect(textMentions).toHaveLength(1);
  });

  it('survives previews carrying colons, unicode and code punctuation', () => {
    // The sanitiser strips ':' '[' ']' from previews; everything else reaches the parser raw,
    // including the braces and operators that make up most real selections.
    const gnarly = 'const map: Record<string, number> = { "café": arr[0] ?? -1 };';

    expect(labelFor(codeToken('src/i18n.ts', 1, 1, gnarly))).toBe('Using code selection');
    expect(labelFor(quoteToken(gnarly))).toBe('Using selected text');
  });

  it('labels a Windows drive-letter diff path, whose colons split the token oddly', () => {
    // filePath is interpolated unsanitised, so 'C:\\...' yields extra ':' segments. The parser
    // mis-slices the label internals on Windows, but the mention type — and therefore the
    // summary label — must still be correct.
    expect(labelFor(diffToken('C:\\Users\\dev\\app.ts', 12, 'return cached;'))).toBe(
      'Using code selection',
    );
  });

  it('composes images with a code selection in one attachment-only message', () => {
    expect(labelFor(codeToken('src/app.ts', 13, 26, 'run();'), 2)).toBe(
      'Using 2 images, code selection',
    );
  });

  it('counts a diff and a code selection as two of the same thing', () => {
    const both = `${diffToken('src/a.ts', 1, 'a')} ${codeToken('src/b.ts', 2, 3, 'b')}`;

    expect(labelFor(both)).toBe('Using 2 code selections');
  });
});
