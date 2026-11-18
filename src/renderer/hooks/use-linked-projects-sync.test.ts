// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invalidateMock, mockUtils } = vi.hoisted(() => {
  const invalidateMock = vi.fn((_input: object) => Promise.resolve());
  const invalidate = (query: string) => (input: object) => invalidateMock({ [query]: input });
  return {
    invalidateMock,
    mockUtils: {
      chats: {
        get: { invalidate: invalidate('get') },
        linkableProjects: { invalidate: invalidate('linkableProjects') },
      },
    },
  };
});

vi.mock('@/lib/trpc', () => ({ trpc: { useUtils: () => mockUtils } }));

import { useLinkedProjectsSync } from './use-linked-projects-sync';

const offMock = vi.fn();
let listener: ((data?: unknown) => void) | null = null;

beforeEach(() => {
  invalidateMock.mockClear();
  offMock.mockClear();
  listener = null;
  Object.defineProperty(window, 'desktopApi', {
    writable: true,
    configurable: true,
    value: {
      on: (channel: string, callback: (data?: unknown) => void) => {
        if (channel === 'chats:linked-projects-changed') listener = callback;
        return offMock;
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'desktopApi', { configurable: true, value: undefined });
});

describe('useLinkedProjectsSync', () => {
  it.each([
    [
      'refetches only the changed chat, and what it can link',
      { chatId: 'c1' },
      [[{ get: { id: 'c1' } }], [{ linkableProjects: { chatId: 'c1' } }]],
    ],
    ['ignores a payload without a chat id', { id: 'c1' }, []],
    ['ignores a missing payload', undefined, []],
    ['ignores a null payload', null, []],
  ])('%s', (_name, payload, calls) => {
    renderHook(() => useLinkedProjectsSync());

    listener?.(payload);

    expect(listener).not.toBeNull();
    expect(invalidateMock.mock.calls).toEqual(calls);
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useLinkedProjectsSync());

    unmount();

    expect(offMock).toHaveBeenCalledTimes(1);
  });

  it('mounts and unmounts quietly where the desktop bridge is missing', () => {
    Object.defineProperty(window, 'desktopApi', { configurable: true, value: undefined });

    const { unmount } = renderHook(() => useLinkedProjectsSync());
    unmount();

    expect(listener).toBeNull();
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
