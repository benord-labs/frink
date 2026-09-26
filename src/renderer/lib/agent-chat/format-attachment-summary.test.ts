/* eslint-disable project-structure/folder-structure */
import { describe, expect, it } from 'vitest';
import { formatAttachmentSummaryLabel } from '@/lib/agent-chat/format-attachment-summary';

const mentions = (...types: string[]) => types.map((type) => ({ type }));

describe('formatAttachmentSummaryLabel', () => {
  it('counts images, pluralising past one', () => {
    expect(formatAttachmentSummaryLabel(1, [])).toBe('Using image');
    expect(formatAttachmentSummaryLabel(2, [])).toBe('Using 2 images');
  });

  it('labels quote and pasted mentions as selected text', () => {
    expect(formatAttachmentSummaryLabel(0, mentions('quote'))).toBe('Using selected text');
    expect(formatAttachmentSummaryLabel(0, mentions('pasted'))).toBe('Using selected text');
    expect(formatAttachmentSummaryLabel(0, mentions('quote', 'pasted'))).toBe(
      'Using 2 text selections',
    );
  });

  it('labels both code-selection gestures — diff-viewer and editor — as code selection', () => {
    expect(formatAttachmentSummaryLabel(0, mentions('diff'))).toBe('Using code selection');
    expect(formatAttachmentSummaryLabel(0, mentions('code'))).toBe('Using code selection');
  });

  it('shares one counter across diff and code so they pluralise together', () => {
    expect(formatAttachmentSummaryLabel(0, mentions('diff', 'code'))).toBe(
      'Using 2 code selections',
    );
  });

  it('orders clauses images, then text selections, then code selections', () => {
    expect(formatAttachmentSummaryLabel(2, mentions('quote'))).toBe(
      'Using 2 images, selected text',
    );
    expect(formatAttachmentSummaryLabel(1, mentions('quote', 'diff'))).toBe(
      'Using image, selected text, code selection',
    );
  });

  // The callers render the summary bubble on mention presence alone, so an unrecognised type
  // degrades to an empty bubble. Pinning '' here turns the next vocabulary drift in
  // extractTextMentions into a test failure rather than a blank bubble in the chat.
  it('returns an empty string when nothing is recognised', () => {
    expect(formatAttachmentSummaryLabel(0, [])).toBe('');
    expect(formatAttachmentSummaryLabel(0, mentions('skill', 'agent'))).toBe('');
  });
});
