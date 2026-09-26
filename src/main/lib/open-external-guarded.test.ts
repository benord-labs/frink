import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn(async () => {
    /* noop */
  }),
}));

vi.mock('electron', () => ({
  shell: { openExternal },
}));

import { shellOpenExternalGuarded } from './open-external-guarded';

describe('shellOpenExternalGuarded', () => {
  beforeEach(() => {
    openExternal.mockClear();
  });

  it('returns blocked_url and does not call shell for disallowed schemes', async () => {
    const r = await shellOpenExternalGuarded('javascript:alert(1)');
    expect(r).toEqual({ success: false, error: 'blocked_url' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('calls shell.openExternal for allowed https URLs', async () => {
    const r = await shellOpenExternalGuarded('https://example.com/foo');
    expect(r).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/foo');
  });

  it('calls shell.openExternal for allowed http URLs', async () => {
    const r = await shellOpenExternalGuarded('http://example.com/foo');
    expect(r).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith('http://example.com/foo');
  });

  it('calls shell.openExternal for allowed mailto URLs', async () => {
    const r = await shellOpenExternalGuarded('mailto:someone@example.com');
    expect(r).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith('mailto:someone@example.com');
  });

  it('trims surrounding whitespace before calling shell.openExternal', async () => {
    const r = await shellOpenExternalGuarded('  https://example.com/path  ');
    expect(r).toEqual({ success: true });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/path');
  });

  it('returns open_failed when shell.openExternal rejects', async () => {
    openExternal.mockRejectedValueOnce(new Error('open failed'));
    const r = await shellOpenExternalGuarded('https://example.com/foo');
    expect(r).toEqual({ success: false, error: 'open_failed' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/foo');
  });

  it('returns open_failed when shell.openExternal throws synchronously', async () => {
    openExternal.mockImplementationOnce(() => {
      throw new Error('sync throw');
    });
    const r = await shellOpenExternalGuarded('https://example.com/foo');
    expect(r).toEqual({ success: false, error: 'open_failed' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/foo');
  });
});
