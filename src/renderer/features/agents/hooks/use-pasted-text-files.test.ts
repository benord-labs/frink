// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('names the chip by its label and the saved file by its filename when given', async () => {
    mutateAsync.mockResolvedValue({ filePath: '/s/pasted/t.txt', filename: 't.txt', size: 9 });
    const { result } = renderHook(() => usePastedTextFiles('sub-1'));

    await act(() =>
      result.current.addPastedText('FAIL a.ts', { label: 'Terminal 1 output', filename: 't.txt' }),
    );

    expect(mutateAsync).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      text: 'FAIL a.ts',
      filename: 't.txt',
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
