// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateStateAtom } from '../atoms';
import { useUpdateChecker } from './use-update-checker';

type DownloadedInfo = { version: string; silent?: boolean; releaseNotes?: string | null };

let capturedOnUpdateDownloaded: ((info: DownloadedInfo) => void) | undefined;

function stubDesktopApi() {
  capturedOnUpdateDownloaded = undefined;
  window.desktopApi = {
    onUpdateChecking: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    onUpdateNotAvailable: () => () => undefined,
    onUpdateProgress: () => () => undefined,
    onUpdateDownloaded: (cb: (info: DownloadedInfo) => void) => {
      capturedOnUpdateDownloaded = cb;
      return () => undefined;
    },
    onUpdateError: () => () => undefined,
    onUpdateManualCheck: () => () => undefined,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
  } as unknown as NonNullable<typeof window.desktopApi>;
}

describe('useUpdateChecker', () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    stubDesktopApi();
    store = createStore();
    store.set(updateStateAtom, { status: 'idle' });
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  }

  it('sets pending-restart when onUpdateDownloaded receives silent: true', () => {
    const { result } = renderHook(() => useUpdateChecker(), { wrapper });

    act(() => {
      capturedOnUpdateDownloaded?.({ version: '1.2.3', silent: true });
    });

    expect(result.current.state).toEqual({
      status: 'pending-restart',
      version: '1.2.3',
    });
  });

  it('sets ready when onUpdateDownloaded has no silent flag', () => {
    const { result } = renderHook(() => useUpdateChecker(), { wrapper });

    act(() => {
      capturedOnUpdateDownloaded?.({ version: '2.0.0' });
    });

    expect(result.current.state).toEqual({
      status: 'ready',
      version: '2.0.0',
    });
  });
});
