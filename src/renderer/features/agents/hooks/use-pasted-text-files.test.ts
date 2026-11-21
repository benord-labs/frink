// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSubChatDraftKey, readDraft } from '../lib/drafts';
import { usePastedTextFiles } from './use-pasted-text-files';

const { mutateAsync, attachAsync } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  attachAsync: vi.fn(),
}));
vi.mock('../../../lib/trpc', () => ({
  trpc: {
    files: {
      writePastedText: { useMutation: () => ({ mutateAsync }) },
      attachPastedFile: { useMutation: () => ({ mutateAsync: attachAsync }) },
    },
  },
}));
const toastError = vi.spyOn(toast, 'error');

const fileOf = (name: string, size: number) => {
  const file = new File(['x'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('usePastedTextFiles', () => {
  // Block body: a function returned from beforeEach runs as teardown, and the mock is a function.
  beforeEach(() => {
    mutateAsync.mockReset();
    attachAsync.mockReset();
    toastError.mockReset();
    localStorage.clear();
    window.webUtils = { getPathForFile: (file) => `/Users/me/${file.name}` };
  });

  it('adds a chip for a saved paste, previewing the first 50 chars on one line', async () => {
    mutateAsync.mockResolvedValue({ filePath: '/s/pasted/p.txt', filename: 'p.txt', size: 60 });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await act(() => result.current.addPastedText(`line one\n${'x'.repeat(59)}`));

    expect(mutateAsync).toHaveBeenCalledWith({ subChatId: 'sub-1', text: expect.any(String) });
    expect(result.current.pastedTexts).toHaveLength(1);
    expect(result.current.pastedTexts[0].preview).toBe(`line one ${'x'.repeat(41)}...`);
    expect(result.current.pastedTextsRef.current).toHaveLength(1);
  });

  it('names the chip by its label and passes the kind of the saved file when given', async () => {
    mutateAsync.mockResolvedValue({ filePath: '/s/pasted/t.txt', filename: 't.txt', size: 9 });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await act(() =>
      result.current.addPastedText('FAIL a.ts', { label: 'Terminal 1 output', kind: 'terminal' }),
    );

    expect(mutateAsync).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      text: 'FAIL a.ts',
      kind: 'terminal',
    });
    expect(result.current.pastedTexts[0].preview).toBe('Terminal 1 output');
  });

  // sc-3666: a swallowed failure left no chip and no text — the paste disappeared silently.
  it('rejects when the write fails, so the caller can fall back, and adds no chip', async () => {
    mutateAsync.mockImplementation(async () => {
      throw new Error('write failed');
    });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await expect(result.current.addPastedText('y'.repeat(6000))).rejects.toThrow('write failed');
    expect(result.current.pastedTexts).toHaveLength(0);
  });

  it('copies an attached file into the pasted folder and names the chip after it', async () => {
    attachAsync.mockResolvedValue({
      filePath: '/s/pasted/1a2b3c4d-report.pdf',
      filename: '1a2b3c4d-report.pdf',
      size: 2048,
    });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await act(() => result.current.addPastedFiles([fileOf('report.pdf', 2048)]));

    expect(attachAsync).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      sourcePath: '/Users/me/report.pdf',
    });
    expect(result.current.pastedTexts[0]).toMatchObject({
      filePath: '/s/pasted/1a2b3c4d-report.pdf',
      preview: 'report.pdf',
      size: 2048,
    });
  });

  it('explains instead of attaching a file over 20 MB or one with no place on disk', async () => {
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));
    window.webUtils = { getPathForFile: (file) => (file.name === 'web.png' ? '' : '/a/big.csv') };

    await act(() =>
      result.current.addPastedFiles([fileOf('big.csv', 21 * 1024 * 1024), fileOf('web.png', 10)]),
    );

    expect(attachAsync).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Couldn't attach big.csv", {
      description: 'Attachments must be 20 MB or smaller.',
    });
    expect(toastError).toHaveBeenCalledWith("Couldn't attach web.png", {
      description: 'Save it to your computer, then drag it in or use the attach button.',
    });
    expect(result.current.pastedTexts).toHaveLength(0);
  });

  it('attaches a file of exactly 20 MB', async () => {
    attachAsync.mockResolvedValue({ filePath: '/s/pasted/a.csv', filename: 'a.csv', size: 1 });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await act(() => result.current.addPastedFiles([fileOf('a.csv', 20 * 1024 * 1024)]));

    expect(toastError).not.toHaveBeenCalled();
    expect(attachAsync).toHaveBeenCalledOnce();
  });

  // The composer stays mounted across sub-chat switches; A's file must not be sent from B.
  it('keeps a chip in the sub-chat it was dropped in when the user switches away mid-copy', async () => {
    let finishCopy: (value: { filePath: string; filename: string; size: number }) => void;
    attachAsync.mockReturnValue(new Promise((resolve) => (finishCopy = resolve)));
    const targetFor = (sub: string) => ({ key: getSubChatDraftKey('chat-1', sub), newChat: false });
    const { result, rerender } = renderHook(({ sub }) => usePastedTextFiles(sub, targetFor(sub)), {
      initialProps: { sub: 'sub-a' },
    });
    let drop: Promise<void> = Promise.resolve();
    act(() => {
      drop = result.current.addPastedFiles([fileOf('notes.md', 5)]);
    });
    rerender({ sub: 'sub-b' });

    await act(async () => {
      finishCopy({ filePath: '/s/sub-a/pasted/n.md', filename: 'n.md', size: 5 });
      await drop;
    });

    expect(result.current.pastedTexts).toHaveLength(0);
    expect(readDraft(getSubChatDraftKey('chat-1', 'sub-a'))?.pastedTexts).toMatchObject([
      { filePath: '/s/sub-a/pasted/n.md', preview: 'notes.md' },
    ]);
  });

  it('copies every file of one drop into the sub-chat it was dropped in, even after a switch', async () => {
    let finishFirst: (value: { filePath: string; filename: string; size: number }) => void;
    attachAsync.mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)));
    attachAsync.mockResolvedValueOnce({
      filePath: '/s/sub-a/pasted/b.md',
      filename: 'b.md',
      size: 5,
    });
    const targetFor = (sub: string) => ({ key: getSubChatDraftKey('chat-1', sub), newChat: false });
    const { rerender, result } = renderHook(({ sub }) => usePastedTextFiles(sub, targetFor(sub)), {
      initialProps: { sub: 'sub-a' },
    });
    let drop: Promise<void> = Promise.resolve();
    act(() => {
      drop = result.current.addPastedFiles([fileOf('a.md', 5), fileOf('b.md', 5)]);
    });
    rerender({ sub: 'sub-b' });

    await act(async () => {
      finishFirst({ filePath: '/s/sub-a/pasted/a.md', filename: 'a.md', size: 5 });
      await drop;
    });

    expect(attachAsync).toHaveBeenNthCalledWith(2, expect.objectContaining({ subChatId: 'sub-a' }));
    expect(readDraft(getSubChatDraftKey('chat-1', 'sub-a'))?.pastedTexts).toHaveLength(2);
    expect(result.current.pastedTexts).toHaveLength(0);
  });

  describe('a large paste still saving', () => {
    const targetFor = (sub: string) => ({ key: getSubChatDraftKey('chat-1', sub), newChat: false });
    const saved = { filePath: '/s/sub-a/pasted/p.txt', filename: 'p.txt', size: 6000 };
    let finishSave: (value: typeof saved) => void;
    let failSave: (error: Error) => void;

    beforeEach(() => {
      mutateAsync.mockReturnValue(
        new Promise((resolve, reject) => {
          finishSave = resolve;
          failSave = reject;
        }),
      );
    });

    const startPaste = (sub = 'sub-a') => {
      const hook = renderHook(({ sub: s }) => usePastedTextFiles(s, targetFor(s)), {
        initialProps: { sub },
      });
      let paste: Promise<void> = Promise.resolve();
      act(() => {
        paste = hook.result.current.addPastedText('z'.repeat(6000));
      });
      return { ...hook, paste: () => paste };
    };

    it('keeps the chip in the stored draft when the composer closes mid-save', async () => {
      const { unmount, paste } = startPaste();
      unmount();

      await act(async () => {
        finishSave(saved);
        await paste();
      });

      expect(readDraft(getSubChatDraftKey('chat-1', 'sub-a'))?.pastedTexts).toMatchObject([
        { filePath: saved.filePath },
      ]);
    });

    it('keeps the chip in the sub-chat it was pasted in when the user switches away mid-save', async () => {
      const { result, rerender, paste } = startPaste();
      rerender({ sub: 'sub-b' });

      await act(async () => {
        finishSave(saved);
        await paste();
      });

      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ subChatId: 'sub-a' }));
      expect(result.current.pastedTexts).toHaveLength(0);
      expect(readDraft(getSubChatDraftKey('chat-1', 'sub-b'))).toBeNull();
      expect(readDraft(getSubChatDraftKey('chat-1', 'sub-a'))?.pastedTexts).toMatchObject([
        { filePath: saved.filePath },
      ]);
    });

    // A count left raised would keep Send disabled for that chat until the app restarts.
    it('holds Send while saving and releases it when the save fails, still rejecting', async () => {
      const { result, paste } = startPaste();
      expect(result.current.isCopying).toBe(true);

      await act(async () => {
        failSave(new Error('disk full'));
        await expect(paste()).rejects.toThrow('disk full');
      });

      expect(result.current.isCopying).toBe(false);
      expect(readDraft(getSubChatDraftKey('chat-1', 'sub-a'))).toBeNull();
    });
  });

  describe('two panes showing the same sub-chat', () => {
    const target = { key: getSubChatDraftKey('chat-1', 'sub-a'), newChat: false };
    const copied = { filePath: '/s/sub-a/pasted/n.md', filename: 'n.md', size: 5 };
    let finishCopy: (value: typeof copied) => void;
    const mountPane = () => renderHook(() => usePastedTextFiles('sub-a', target));

    beforeEach(() => {
      attachAsync.mockReturnValue(new Promise((resolve) => (finishCopy = resolve)));
    });

    it('puts the chip in the pane it was dropped in, not the one opened later', async () => {
      const dropped = mountPane();
      const other = mountPane();
      let drop: Promise<void> = Promise.resolve();
      act(() => {
        drop = dropped.result.current.addPastedFiles([fileOf('notes.md', 5)]);
      });

      await act(async () => {
        finishCopy(copied);
        await drop;
      });

      expect(dropped.result.current.pastedTexts).toHaveLength(1);
      expect(other.result.current.pastedTexts).toHaveLength(0);
    });

    // Storage would be the wrong home: the open pane never re-reads it and its next save drops it.
    it('gives the chip to a pane still open once the dropping pane and a later one have closed', async () => {
      const remaining = mountPane();
      const later = mountPane();
      const dropped = mountPane();
      let drop: Promise<void> = Promise.resolve();
      act(() => {
        drop = dropped.result.current.addPastedFiles([fileOf('notes.md', 5)]);
      });
      dropped.unmount();
      later.unmount();

      await act(async () => {
        finishCopy(copied);
        await drop;
      });

      expect(remaining.result.current.pastedTexts).toHaveLength(1);
      expect(readDraft(target.key)).toBeNull();
    });
  });

  // A count left raised would keep Send disabled for that chat until the app restarts.
  it('stops counting a copy as in flight when the main process refuses it', async () => {
    let refuse: (error: Error) => void = () => {};
    attachAsync.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
    const target = { key: getSubChatDraftKey('chat-1', 'sub-a'), newChat: false };
    const { result } = renderHook(() => usePastedTextFiles('sub-a', target));
    let drop: Promise<void> = Promise.resolve();
    act(() => {
      drop = result.current.addPastedFiles([fileOf('src', 0)]);
    });
    expect(result.current.isCopying).toBe(true);

    await act(async () => {
      refuse(new Error("Folders can't be attached."));
      await drop;
    });

    expect(result.current.isCopying).toBe(false);
    expect(readDraft(target.key)).toBeNull();
  });

  it('reports a copy the main process refused, and keeps going', async () => {
    attachAsync.mockRejectedValueOnce(new Error("Folders can't be attached."));
    attachAsync.mockResolvedValueOnce({ filePath: '/s/pasted/b.ts', filename: 'b.ts', size: 1 });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await act(() => result.current.addPastedFiles([fileOf('src', 0), fileOf('b.ts', 1)]));

    expect(toastError).toHaveBeenCalledWith("Couldn't attach src", {
      description: "Folders can't be attached.",
    });
    expect(result.current.pastedTexts).toHaveLength(1);
  });
});
