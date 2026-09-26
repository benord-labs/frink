// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  updateSubChatName: vi.fn(),
  toastError: vi.fn(),
  subChats: [] as Array<{ id: string; name: string | null }>,
  onError: undefined as ((e: { data?: { code?: string } }) => void) | undefined,
}));

vi.mock('sonner', () => ({ toast: { error: h.toastError } }));
vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({
      subChatsById: Object.fromEntries(h.subChats.map((sc) => [sc.id, sc])),
      updateSubChatName: h.updateSubChatName,
    }),
  },
}));
vi.mock('../../../lib/mock-api', () => ({
  api: {
    agents: {
      renameSubChat: {
        useMutation: (opts?: { onError?: (e: { data?: { code?: string } }) => void }) => {
          h.onError = opts?.onError;
          return { mutateAsync: h.mutateAsync };
        },
      },
    },
  },
}));

import { useSubChatRenameAction } from './use-sub-chat-rename-action';

beforeEach(() => {
  vi.clearAllMocks();
  h.subChats = [{ id: 's1', name: 'Old' }];
});

describe('useSubChatRenameAction', () => {
  it('optimistically renames then persists on success (no revert)', async () => {
    h.mutateAsync.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSubChatRenameAction());

    await act(async () => {
      await result.current('s1', 'New');
    });

    expect(h.updateSubChatName).toHaveBeenCalledTimes(1);
    expect(h.updateSubChatName).toHaveBeenCalledWith('s1', 'New');
    expect(h.mutateAsync).toHaveBeenCalledWith({ subChatId: 's1', name: 'New' });
  });

  it('reverts to the prior name when persistence fails', async () => {
    h.mutateAsync.mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useSubChatRenameAction());

    await act(async () => {
      await result.current('s1', 'New');
    });

    expect(h.updateSubChatName).toHaveBeenNthCalledWith(1, 's1', 'New'); // optimistic
    expect(h.updateSubChatName).toHaveBeenNthCalledWith(2, 's1', 'Old'); // revert
  });

  it('reverts to "New Chat" when there is no prior name', async () => {
    h.subChats = [{ id: 's1', name: null }];
    h.mutateAsync.mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useSubChatRenameAction());

    await act(async () => {
      await result.current('s1', 'New');
    });

    expect(h.updateSubChatName).toHaveBeenNthCalledWith(2, 's1', 'New Chat');
  });

  it('toasts the NOT_FOUND hint vs a generic failure via the mutation onError', () => {
    renderHook(() => useSubChatRenameAction());

    h.onError?.({ data: { code: 'NOT_FOUND' } });
    expect(h.toastError).toHaveBeenCalledWith('Send a message first before renaming this chat');

    h.onError?.({ data: { code: 'INTERNAL' } });
    expect(h.toastError).toHaveBeenCalledWith('Failed to rename chat');
  });
});
