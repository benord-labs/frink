// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSubChatDraftFull, hasDraftContent } from '../../../../lib/drafts';
import { createQueueItem } from '../../../../lib/queue-utils';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';
import { shouldReleaseEdit, useQueueEdit } from '.';

const CHAT = 'chat-edit';
const SUB = 'sub-edit';

function renderQueueEdit() {
  const editor = { setValue: vi.fn(), focus: vi.fn(), clear: vi.fn() };
  const pasted = { clearPastedTexts: vi.fn(), setPastedTextsFromDraft: vi.fn() };
  const hook = renderHook(() =>
    useQueueEdit({
      subChatId: SUB,
      parentChatId: CHAT,
      editorRef: { current: editor as never },
      inputHasContent: false,
      upload: { clearAll: vi.fn(), setImagesFromDraft: vi.fn() },
      textContexts: {
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        setTextContextsFromDraft: vi.fn(),
        setDiffTextContextsFromDraft: vi.fn(),
      },
      pasted,
    }),
  );
  return { ...hook, editor, pasted };
}

describe('useQueueEdit', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useMessageQueueStore.setState({
      queues: { [SUB]: [createQueueItem('q', 'queued text')] },
      editingItemIds: {},
      chatIds: {},
    });
  });

  it('saves the loaded text as the draft at once, so a reload before blur keeps the edit', () => {
    const { result, editor } = renderQueueEdit();

    act(() => result.current.handleEditFromQueue('q'));

    expect(editor.setValue).toHaveBeenCalledWith('queued text');
    expect(useMessageQueueStore.getState().editingItemIds[SUB]).toBe('q');
    const draft = getSubChatDraftFull(CHAT, SUB);
    expect(draft?.text).toBe('queued text');
    expect(draft && hasDraftContent(draft)).toBe(true);
  });

  it('saves inline images and text contexts with the draft, not just the text', () => {
    useMessageQueueStore.setState({
      queues: {
        [SUB]: [
          {
            ...createQueueItem('img', ''),
            images: [{ id: 'i', url: '', mediaType: 'image/png', base64Data: 'QUJD' }],
            textContexts: [{ id: 't', text: 'quoted', sourceMessageId: 'm1' }],
          },
        ],
      },
    });
    const { result } = renderQueueEdit();

    act(() => result.current.handleEditFromQueue('img'));

    const draft = getSubChatDraftFull(CHAT, SUB);
    expect(draft && hasDraftContent(draft)).toBe(true);
    expect(draft?.images).toHaveLength(1);
    expect(draft?.textContexts.map((c) => c.text)).toEqual(['quoted']);
  });

  it('loads and saves an attached file chip with the draft, so it survives a reload', () => {
    const chip = {
      id: 'p',
      filePath: '/s/pasted/1a2b3c4d-a.pdf',
      filename: 'a.pdf',
      size: 3,
      preview: 'a.pdf',
    };
    useMessageQueueStore.setState({
      queues: { [SUB]: [{ ...createQueueItem('f', 'with file'), pastedTexts: [chip] }] },
    });
    const { result, pasted } = renderQueueEdit();

    act(() => result.current.handleEditFromQueue('f'));

    expect(pasted.setPastedTextsFromDraft).toHaveBeenCalledWith([expect.objectContaining(chip)]);
    expect(getSubChatDraftFull(CHAT, SUB)?.pastedTexts).toEqual([expect.objectContaining(chip)]);
  });

  it('clears the eagerly saved draft when the edit is abandoned or its item removed', () => {
    const { result } = renderQueueEdit();
    act(() => result.current.handleEditFromQueue('q'));
    expect(getSubChatDraftFull(CHAT, SUB)?.text).toBe('queued text');

    act(() => result.current.handleAbandonEdit());

    expect(getSubChatDraftFull(CHAT, SUB)).toBeNull();
    expect(useMessageQueueStore.getState().editingItemIds[SUB]).toBeNull();
  });

  it('keeps the flag across unmount, leaving release to the next mount', () => {
    const { result, unmount } = renderQueueEdit();
    act(() => result.current.handleEditFromQueue('q'));

    unmount();

    expect(useMessageQueueStore.getState().editingItemIds[SUB]).toBe('q');
  });
});

describe('shouldReleaseEdit', () => {
  const empty = {
    text: null,
    images: [],
    textContexts: [],
    pastedTexts: [],
    task: null,
    subChatId: null,
  };

  beforeEach(() => {
    localStorage.clear();
    useMessageQueueStore.setState({
      queues: { [SUB]: [createQueueItem('q', 'text')] },
      editingItemIds: { [SUB]: 'q' },
      chatIds: {},
    });
  });

  it('releases an edit whose saved draft is empty', () => {
    expect(shouldReleaseEdit(SUB, null)).toBe(true);
    expect(shouldReleaseEdit(SUB, empty)).toBe(true);
  });

  it('keeps an edit whose draft holds content', () => {
    expect(shouldReleaseEdit(SUB, { ...empty, text: 'edited' })).toBe(false);
  });

  it('does nothing when no edit is in progress', () => {
    useMessageQueueStore.setState({ editingItemIds: {} });

    expect(shouldReleaseEdit(SUB, empty)).toBe(false);
  });

  it('keeps an edit whose draft holds only an attached file', () => {
    const chip = { id: 'p', filePath: '/p', filename: 'a.pdf', size: 1, preview: 'a.pdf' };
    expect(
      shouldReleaseEdit(SUB, { ...empty, pastedTexts: [{ ...chip, createdAt: new Date() }] }),
    ).toBe(false);
  });
});
