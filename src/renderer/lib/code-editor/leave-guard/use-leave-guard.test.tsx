// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaveReason } from '../../../../shared/leave-reason';
import { markFileSavedAtom } from '../state/atoms';
import {
  fileKey,
  openFileAtom,
  pendingCloseKeysAtom,
  pendingLeaveAtom,
  requestCloseFilesAtom,
  updateFileContentAtom,
} from '../state';
import { useLeaveGuard } from './use-leave-guard';

let requestLeave: (reason: LeaveReason) => void = () => {};
const api = {
  setHasUnsavedEdits: vi.fn(),
  ackLeave: vi.fn(),
  confirmLeave: vi.fn(),
  onLeaveRequested: vi.fn((callback: (reason: LeaveReason) => void) => {
    requestLeave = callback;
    return () => {};
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window, { desktopApi: api });
});

function setup() {
  const store = createStore();
  for (const name of ['a.ts', 'b.ts']) {
    store.set(openFileAtom, { path: `src/${name}`, name, projectPath: '/repo', intent: 'pinned' });
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useLeaveGuard(), { wrapper });
  return store;
}

const a = fileKey('src/a.ts', '/repo');
const b = fileKey('src/b.ts', '/repo');

describe('useLeaveGuard', () => {
  it('tells main only when the unsaved state changes', () => {
    const store = setup();
    expect(api.setHasUnsavedEdits.mock.calls).toEqual([[false]]);

    act(() => {
      store.set(updateFileContentAtom, { key: a, content: 'edited' });
      store.set(updateFileContentAtom, { key: b, content: 'edited' });
    });
    act(() => store.set(markFileSavedAtom, a));
    act(() => store.set(markFileSavedAtom, b));

    expect(api.setHasUnsavedEdits.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('widens an open tab-close prompt to every unsaved tab when main asks', () => {
    const store = setup();
    act(() => {
      store.set(updateFileContentAtom, { key: a, content: 'edited' });
      store.set(updateFileContentAtom, { key: b, content: 'edited' });
      // Cmd+W on a.ts is waiting on its prompt; a tab-close request would be ignored now.
      store.set(requestCloseFilesAtom, [a]);
    });

    act(() => requestLeave('quit'));

    expect(api.ackLeave).toHaveBeenCalledTimes(1);
    expect(store.get(pendingLeaveAtom)).toBe('quit');
    expect(store.get(pendingCloseKeysAtom)).toEqual([a, b]);
    expect(api.confirmLeave).not.toHaveBeenCalled();
  });

  it('lets main go at once when nothing is unsaved by the time it asks', () => {
    const store = setup();

    act(() => requestLeave('close'));

    expect(api.confirmLeave).toHaveBeenCalledTimes(1);
    expect(store.get(pendingCloseKeysAtom)).toBeNull();
  });
});
