// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePastedTextFiles } from './use-pasted-text-files';

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
vi.mock('../../../lib/trpc', () => ({
  trpc: { files: { writePastedText: { useMutation: () => ({ mutateAsync }) } } },
}));

describe('usePastedTextFiles', () => {
  // Block body: a function returned from beforeEach runs as teardown, and the mock is a function.
  beforeEach(() => {
    mutateAsync.mockReset();
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
});
