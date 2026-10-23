// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentsFileUpload } from './use-agents-file-upload';

describe('useAgentsFileUpload', () => {
  it('keeps images inline and hands every other file to the pasted-file route', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:img') });
    const onOtherFiles = vi.fn(async () => {});
    const { result } = renderHook(() => useAgentsFileUpload(onOtherFiles));
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
    const ts = new File(['x'], 'a.ts', { type: '' });

    await act(() => result.current.handleAddAttachments([png, pdf, ts]));

    expect(result.current.images.map((img) => img.filename)).toEqual(['shot.png']);
    expect(onOtherFiles).toHaveBeenCalledWith([pdf, ts]);
    expect(result.current.isUploading).toBe(false);
    vi.unstubAllGlobals();
  });

  it('stays busy until every overlapping drop has finished copying', async () => {
    const copies: Array<() => void> = [];
    const onOtherFiles = vi.fn(() => new Promise<void>((resolve) => copies.push(resolve)));
    const { result } = renderHook(() => useAgentsFileUpload(onOtherFiles));
    const pdf = (name: string) => new File(['%PDF'], name, { type: 'application/pdf' });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handleAddAttachments([pdf('a.pdf')]);
    });
    await act(async () => {
      second = result.current.handleAddAttachments([pdf('b.pdf')]);
      await Promise.resolve();
    });
    await act(async () => {
      copies[0]?.();
      await first;
    });

    expect(result.current.isUploading).toBe(true);

    await act(async () => {
      copies[1]?.();
      await second;
    });
    expect(result.current.isUploading).toBe(false);
  });
});
