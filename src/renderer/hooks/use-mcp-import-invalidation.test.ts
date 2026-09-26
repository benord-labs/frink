// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  aggregatedInvalidateMock,
  listGlobalServersInvalidateMock,
  claudeInvalidateMock,
  mockUtils,
  isDesktopAppMock,
  onMcpImportedMock,
  unsubMock,
  importedCallbackRef,
} = vi.hoisted(() => {
  const aggregatedInvalidateMock = vi.fn(() => Promise.resolve());
  const listGlobalServersInvalidateMock = vi.fn(() => Promise.resolve());
  const claudeInvalidateMock = vi.fn(() => Promise.resolve());
  const unsubMock = vi.fn();
  const importedCallbackRef: {
    current: ((result: { imported: number; conflicts: number }) => void) | null;
  } = { current: null };

  const onMcpImportedMock = vi.fn(
    (cb: (result: { imported: number; conflicts: number }) => void) => {
      importedCallbackRef.current = cb;
      return unsubMock;
    },
  );

  return {
    aggregatedInvalidateMock,
    listGlobalServersInvalidateMock,
    claudeInvalidateMock,
    isDesktopAppMock: vi.fn(() => true),
    mockUtils: {
      mcp: {
        getAggregatedMcpInfo: { invalidate: aggregatedInvalidateMock },
        listGlobalServers: { invalidate: listGlobalServersInvalidateMock },
      },
      claude: { getAllMcpConfig: { invalidate: claudeInvalidateMock } },
    },
    onMcpImportedMock,
    unsubMock,
    importedCallbackRef,
  };
});

vi.mock('@/lib/trpc', () => ({
  trpc: { useUtils: () => mockUtils },
}));

vi.mock('../lib/utils/platform', () => ({
  isDesktopApp: isDesktopAppMock,
}));

import { useMcpImportInvalidation } from './use-mcp-import-invalidation';

beforeEach(() => {
  aggregatedInvalidateMock.mockClear();
  listGlobalServersInvalidateMock.mockClear();
  claudeInvalidateMock.mockClear();
  unsubMock.mockClear();
  onMcpImportedMock.mockClear();
  importedCallbackRef.current = null;
  isDesktopAppMock.mockReset();
  isDesktopAppMock.mockReturnValue(true);

  Object.defineProperty(window, 'desktopApi', {
    writable: true,
    configurable: true,
    value: { onMcpImported: onMcpImportedMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'desktopApi', {
    writable: true,
    configurable: true,
    value: undefined,
  });
});

describe('useMcpImportInvalidation', () => {
  it('does not invalidate before the import event fires', () => {
    renderHook(() => useMcpImportInvalidation());
    expect(onMcpImportedMock).toHaveBeenCalledTimes(1);
    expect(aggregatedInvalidateMock).not.toHaveBeenCalled();
    expect(listGlobalServersInvalidateMock).not.toHaveBeenCalled();
    expect(claudeInvalidateMock).not.toHaveBeenCalled();
  });

  // Settings → MCPs reads `listGlobalServers` to render Frink-owned entries.
  // If the importer adds a new entry while the user is on the Settings tab,
  // omitting this invalidation would leave the new entry hidden until the
  // 5s React Query staleTime expires.
  it('invalidates getAggregatedMcpInfo + listGlobalServers + getAllMcpConfig when the import event fires', () => {
    renderHook(() => useMcpImportInvalidation());

    expect(importedCallbackRef.current).toBeTruthy();
    importedCallbackRef.current?.({ imported: 2, conflicts: 1 });

    expect(aggregatedInvalidateMock).toHaveBeenCalledTimes(1);
    expect(listGlobalServersInvalidateMock).toHaveBeenCalledTimes(1);
    expect(claudeInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('calls the unsubscribe function on unmount', () => {
    const { unmount } = renderHook(() => useMcpImportInvalidation());
    expect(onMcpImportedMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubMock).toHaveBeenCalledTimes(1);
  });

  it('does not register the listener when not running inside the desktop app', () => {
    isDesktopAppMock.mockReturnValue(false);
    renderHook(() => useMcpImportInvalidation());
    expect(onMcpImportedMock).not.toHaveBeenCalled();
  });

  it('does not re-register the listener across stable re-renders', () => {
    const { rerender } = renderHook(() => useMcpImportInvalidation());
    expect(onMcpImportedMock).toHaveBeenCalledTimes(1);

    rerender();
    rerender();
    rerender();

    expect(onMcpImportedMock).toHaveBeenCalledTimes(1);
    expect(unsubMock).not.toHaveBeenCalled();
  });
});
