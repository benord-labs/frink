// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PastedTextFile } from '../../hooks/use-pasted-text-files';
import { getSubChatDraftFull, writeSubChatDraft } from '../drafts';
import { useComposerDraft } from '.';

const report: PastedTextFile = {
  id: 'p1',
  filePath: '/s/pasted/1a2b3c4d-report.pdf',
  filename: '1a2b3c4d-report.pdf',
  size: 2048,
  preview: 'report.pdf',
  createdAt: new Date(0),
};

function renderDraft(text: string, pastedTexts: PastedTextFile[], chatId: string | null = 'c1') {
  // SAFETY: useComposerDraft only calls getValue and setValue on the editor handle.
  const editorRef = { current: { getValue: () => text, setValue: vi.fn() } as never };
  return renderHook(() =>
    useComposerDraft({
      editorRef,
      chatIdRef: { current: chatId },
      subChatIdRef: { current: 's1' },
      draftTextRef: { current: text },
      images: [],
      pastedTexts,
      textContexts: [],
      extraContextCount: 0,
      onContentChange: vi.fn(),
    }),
  );
}

describe('useComposerDraft blur save', () => {
  beforeEach(() => localStorage.clear());

  it('keeps an attached file with the sub-chat draft, even with no text', () => {
    const { result } = renderDraft('', [report]);

    result.current();

    expect(getSubChatDraftFull('c1', 's1')?.pastedTexts).toEqual([
      expect.objectContaining({ filePath: report.filePath, preview: 'report.pdf' }),
    ]);
  });

  it('clears the draft once the composer holds nothing', () => {
    writeSubChatDraft('c1', 's1', { text: 'old', pastedTexts: [report] });
    const { result } = renderDraft('  ', []);

    result.current();

    expect(getSubChatDraftFull('c1', 's1')).toBeNull();
  });

  it('writes nothing before the chat exists', () => {
    const { result } = renderDraft('typed', [report], null);

    result.current();

    expect(localStorage.length).toBe(0);
  });
});
