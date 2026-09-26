// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskAttachment } from './use-task-attachment';

type EditorRef = RefObject<{
  getValue: () => string;
  setValue: (value: string) => void;
} | null>;

const invalidateListPaginated = vi.fn();
const invalidateListCounts = vi.fn();
const mutateAsync = vi.fn();

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: invalidateListPaginated },
        listCounts: { invalidate: invalidateListCounts },
      },
    }),
    tasks: {
      updateStatus: {
        useMutation: (opts?: { onSuccess?: () => void }) => ({
          mutateAsync: async (...args: unknown[]) => {
            const out = await mutateAsync(...args);
            opts?.onSuccess?.();
            return out;
          },
        }),
      },
    },
  },
}));

describe('useTaskAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prependTaskMessage clears attachedTask after a successful editor setValue', () => {
    const setValue = vi.fn();
    const editor = { getValue: () => '', setValue };
    const editorRef = { current: editor };

    const { result } = renderHook(() =>
      useTaskAttachment({
        editorRef: editorRef as EditorRef,
      }),
    );

    act(() =>
      result.current.setAttachedTask({
        id: 'task-1',
        title: 'T',
        description: 'Do work',
      }),
    );

    let returned: unknown;
    act(() => {
      returned = result.current.prependTaskMessage();
    });

    expect(setValue).toHaveBeenCalledTimes(1);
    expect(returned).toMatchObject({ id: 'task-1' });
    expect(result.current.attachedTask).toBeNull();
  });

  it('second prependTaskMessage is a no-op after the first cleared the attachment', () => {
    const setValue = vi.fn();
    const editor = { getValue: () => '', setValue };
    const editorRef = { current: editor };

    const { result } = renderHook(() =>
      useTaskAttachment({
        editorRef: editorRef as EditorRef,
      }),
    );

    act(() =>
      result.current.setAttachedTask({
        id: 'task-1',
        title: 'T',
        description: 'Do work',
      }),
    );
    act(() => {
      result.current.prependTaskMessage();
    });
    let second: unknown;
    act(() => {
      second = result.current.prependTaskMessage();
    });

    expect(setValue).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
  });

  it('does not clear attachedTask when editor ref is null', () => {
    const editorRef = { current: null };

    const { result } = renderHook(() =>
      useTaskAttachment({
        editorRef: editorRef as EditorRef,
      }),
    );

    act(() =>
      result.current.setAttachedTask({
        id: 'task-1',
        title: 'T',
        description: 'Do work',
      }),
    );

    let returned: unknown;
    act(() => {
      returned = result.current.prependTaskMessage();
    });

    expect(returned).toMatchObject({ id: 'task-1' });
    expect(result.current.attachedTask).toMatchObject({ id: 'task-1' });
  });
});
