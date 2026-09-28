// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as drafts from '../../../../lib/drafts';
import { getSubChatDraftFull, hasDraftContent } from '../../../../lib/drafts';
import { createQueueItem } from '../../../../lib/queue-utils';
import { useMessageQueueStore } from '../../../../stores/message-queue-store';
import { shouldReleaseEdit, useQueueEdit } from '.';

const CHAT = 'chat-edit';
const SUB = 'sub-edit';

function renderQueueEdit() {
  const editor = { setValue: vi.fn(), focus: vi.fn(), clear: vi.fn() };
  const hook = renderHook(() =>
    useQueueEdit({
      subChatId: SUB,
      parentChatId: CHAT,
      editorRef: { current: editor as never },
      inputHasContent: false,
      upload: { clearAll: vi.fn(), setImagesFromDraft: vi.fn(), setFilesFromDraft: vi.fn() },
      textContexts: {
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        setTextContextsFromDraft: vi.fn(),
        setDiffTextContextsFromDraft: vi.fn(),
      },
    }),
  );
  return { ...hook, editor };
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

  it('also saves a turn that still has its files, through the async attachment writer', () => {
    const save = vi
      .spyOn(drafts, 'saveSubChatDraftWithAttachments')
      .mockResolvedValue({ success: true });
    useMessageQueueStore.setState({
      queues: {
        [SUB]: [
          {
            ...createQueueItem('f', 'with file'),
            files: [{ id: 'f1', url: 'blob:x', filename: 'a.txt' }],
          },
        ],
      },
    });
    const { result } = renderQueueEdit();

    act(() => result.current.handleEditFromQueue('f'));

    expect(save).toHaveBeenCalledWith(
      CHAT,
      SUB,
      'with file',
      expect.objectContaining({ files: [expect.objectContaining({ id: 'f1', url: 'blob:x' })] }),
    );
    save.mockRestore();
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
    files: [],
    textContexts: [],
    pastedTexts: [],
    task: null,
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

  it('holds a file edit only while its draft write is in flight, even when the write fails', async () => {
    let settle!: (outcome: { success: boolean }) => void;
    const save = vi
      .spyOn(drafts, 'saveSubChatDraftWithAttachments')
      .mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    useMessageQueueStore.setState({
      queues: {
        [SUB]: [
          {
            ...createQueueItem('f', ''),
            files: [{ id: 'f1', url: 'blob:x', filename: 'a.txt' }],
          },
        ],
      },
      editingItemIds: {},
    });
    const { result } = renderQueueEdit();
    act(() => result.current.handleEditFromQueue('f'));

    expect(shouldReleaseEdit(SUB, empty)).toBe(false);

    await act(async () => settle({ success: false }));

    expect(shouldReleaseEdit(SUB, empty)).toBe(true);
    save.mockRestore();
  });

  it('keeps holding while a later overlapping file edit is still in flight', async () => {
    const settles: ((outcome: { success: boolean }) => void)[] = [];
    const save = vi
      .spyOn(drafts, 'saveSubChatDraftWithAttachments')
      .mockImplementation(() => new Promise((resolve) => settles.push(resolve)));
    const withFile = (id: string) => ({
      ...createQueueItem(id, ''),
      files: [{ id: `${id}-f`, url: 'blob:x', filename: 'a.txt' }],
    });
    useMessageQueueStore.setState({
      queues: { [SUB]: [withFile('a'), withFile('b')] },
      editingItemIds: {},
    });
    const { result } = renderQueueEdit();
    act(() => result.current.handleEditFromQueue('a'));
    act(() => result.current.handleEditFromQueue('b'));

    await act(async () => settles[0]?.({ success: true }));
    expect(shouldReleaseEdit(SUB, empty)).toBe(false);

    await act(async () => settles[1]?.({ success: true }));
    expect(shouldReleaseEdit(SUB, empty)).toBe(true);
    save.mockRestore();
  });

  it('never lets an older edit whose file read resolves late overwrite a newer edit', async () => {
    const reads = new Map<string, (blob: Blob) => void>();
    vi.stubGlobal(
      'fetch',
      (url: string) =>
        new Promise((resolve) =>
          reads.set(url, (blob) => resolve({ blob: async () => blob } as Response)),
        ),
    );
    const withFile = (id: string) => ({
      ...createQueueItem(id, `edit ${id}`),
      files: [{ id: `${id}-f`, url: `blob:${id}`, filename: `${id}.txt` }],
    });
    useMessageQueueStore.setState({
      queues: { [SUB]: [withFile('a'), withFile('b')] },
      editingItemIds: {},
    });
    const { result } = renderQueueEdit();
    act(() => result.current.handleEditFromQueue('a'));
    act(() => result.current.handleEditFromQueue('b'));

    // B's read lands first, then A's (the older edit) lands late.
    await act(async () => {
      reads.get('blob:b')?.(new Blob(['b']));
      await new Promise((r) => setTimeout(r, 20));
      reads.get('blob:a')?.(new Blob(['a']));
      await new Promise((r) => setTimeout(r, 20));
    });

    const draft = getSubChatDraftFull(CHAT, SUB);
    expect(draft?.text).toBe('edit b');
    expect(draft?.files.map((f) => f.id)).toEqual(['b-f']);
    vi.unstubAllGlobals();
  });
});
