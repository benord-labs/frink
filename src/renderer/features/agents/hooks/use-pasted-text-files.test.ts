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
