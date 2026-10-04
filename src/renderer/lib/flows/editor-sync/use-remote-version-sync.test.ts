// @vitest-environment happy-dom
// Push refresh for a clean editor; one sticky notice, with two ways out, for unsaved edits.

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type RemoteVersionSyncDeps,
  type RemoteVersionSyncParams,
  useRemoteVersionSyncWith,
} from './use-remote-version-sync';

type PushEvent = {
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  flow_id: string;
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  version_number: number;
  source: 'agent' | 'ui';
};

const mocks = {
  toast: Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn() }),
  invalidateGet: vi.fn(),
  invalidateList: vi.fn(),
  fetchLatest: vi.fn(),
  reportFailure: vi.fn(),
};

let push: ((event: PushEvent) => void) | undefined;
let subscribedTo: { flowId: string } | undefined;

const fakeApi = {
  useUtils: () => ({
    flows: {
      get: { invalidate: mocks.invalidateGet, fetch: mocks.fetchLatest },
      list: { invalidate: mocks.invalidateList },
    },
  }),
  flows: {
    onVersionCommitted: {
      useSubscription: (
        input: { flowId: string },
        options: { onData: (event: PushEvent) => void },
      ) => {
        subscribedTo = input;
        push = options.onData;
      },
    },
  },
};

const deps: RemoteVersionSyncDeps = {
  api: fakeApi,
  toast: mocks.toast,
  reportFailure: mocks.reportFailure,
};

const NOTICE_ID = 'flow-remote-update-flow-1';

type Params = RemoteVersionSyncParams;
type Props = Omit<Params, 'flowId' | 'onReloaded' | 'saveOver'>;

const server = (version: number) =>
  // SAFETY: the hook reads only `version_number` from a snapshot.
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  ({ version_number: version }) as NonNullable<Params['data']>;

/** Editor forked from v5 with unsaved edits; the server still reports v5. */
const DIRTY_ON_V5: Props = {
  data: server(5),
  hydrated: true,
  locallyModified: true,
  baselineVersion: 5,
  savePending: false,
  canSave: true,
  workingCopy: { nodes: ['trigger'] },
};

function setup(initialProps: Props) {
  const onReloaded = vi.fn();
  const saveOver = vi.fn(() => Promise.resolve());
  const view = renderHook(
    (props: Props) =>
      useRemoteVersionSyncWith({ flowId: 'flow-1', ...props, onReloaded, saveOver }, deps),
    { initialProps },
  );
  return { ...view, onReloaded, saveOver };
}

describe('useRemoteVersionSyncWith', () => {
  beforeEach(() => {
    mocks.toast.mockClear();
    mocks.toast.dismiss.mockClear();
    mocks.toast.error.mockClear();
    mocks.invalidateGet.mockClear();
    mocks.invalidateList.mockClear();
    mocks.fetchLatest.mockReset();
    mocks.reportFailure.mockClear();
  });

  it('refreshes the flow as soon as a commit is pushed, without waiting for the poll', () => {
    setup({ ...DIRTY_ON_V5, locallyModified: false });

    push?.({ flow_id: 'flow-1', version_number: 6, source: 'agent' });

    expect(subscribedTo).toEqual({ flowId: 'flow-1' });
    expect(mocks.invalidateGet).toHaveBeenCalledWith({ id: 'flow-1' });
    expect(mocks.invalidateList).toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('raises one sticky notice naming both ways out when edits block a newer version', async () => {
    const { rerender, onReloaded, saveOver } = setup(DIRTY_ON_V5);
    push?.({ flow_id: 'flow-1', version_number: 6, source: 'agent' });

    rerender({ ...DIRTY_ON_V5, data: server(6) });
    // The 30s poll returning the same version must not raise it again.
    rerender({ ...DIRTY_ON_V5, data: server(6) });

    expect(mocks.toast).toHaveBeenCalledOnce();
    const [title, options] = mocks.toast.mock.calls[0];
    expect(title).toBe('An agent updated this flow');
    expect(options).toMatchObject({
      id: NOTICE_ID,
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Reload latest' },
      cancel: { label: 'Overwrite with mine' },
    });

    mocks.fetchLatest.mockResolvedValue(server(6));
    options.action.onClick();
    await vi.waitFor(() => expect(onReloaded).toHaveBeenCalledWith(server(6)));
    options.cancel.onClick();
    expect(saveOver).toHaveBeenCalledOnce();
  });

  it('does not blame an agent for a version it only learned of from the poll', () => {
    const { rerender } = setup(DIRTY_ON_V5);

    rerender({ ...DIRTY_ON_V5, data: server(6) });

    expect(mocks.toast.mock.calls[0][0]).toBe('This flow was updated elsewhere');
  });

  it('replaces the notice in place when a still newer version lands', () => {
    const { rerender } = setup(DIRTY_ON_V5);
    rerender({ ...DIRTY_ON_V5, data: server(6) });
    push?.({ flow_id: 'flow-1', version_number: 7, source: 'ui' });

    rerender({ ...DIRTY_ON_V5, data: server(7) });

    expect(mocks.toast).toHaveBeenCalledTimes(2);
    const [title, options] = mocks.toast.mock.calls[1];
    expect(title).toBe('This flow was updated in another window');
    expect(options.id).toBe(NOTICE_ID);
  });

  it('raises again for a later version after an earlier notice was cleared', () => {
    const { rerender } = setup(DIRTY_ON_V5);
    rerender({ ...DIRTY_ON_V5, data: server(6) });
    // Reload: the working copy becomes v6 and is clean.
    rerender({ ...DIRTY_ON_V5, data: server(6), locallyModified: false, baselineVersion: 6 });
    mocks.toast.mockClear();

    // The user edits again, then an agent saves v7.
    rerender({ ...DIRTY_ON_V5, data: server(7), baselineVersion: 6 });

    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it('raises once the save that was hiding a real remote version fails', () => {
    const { rerender } = setup({ ...DIRTY_ON_V5, savePending: true });
    rerender({ ...DIRTY_ON_V5, data: server(6), savePending: true });
    expect(mocks.toast).not.toHaveBeenCalled();

    // The save came back CONFLICT: baseline did not move, v6 was someone else's.
    rerender({ ...DIRTY_ON_V5, data: server(6) });

    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it('clears the notice when the working copy becomes clean again', () => {
    const { rerender } = setup(DIRTY_ON_V5);
    rerender({ ...DIRTY_ON_V5, data: server(6) });
    mocks.toast.dismiss.mockClear();

    rerender({ ...DIRTY_ON_V5, data: server(6), locallyModified: false });

    expect(mocks.toast.dismiss).toHaveBeenCalledWith(NOTICE_ID);
  });

  it("stays quiet about the editor's own save landing before its baseline advances", () => {
    const { rerender } = setup({ ...DIRTY_ON_V5, savePending: true });

    rerender({ ...DIRTY_ON_V5, data: server(6), savePending: true });
    rerender({ ...DIRTY_ON_V5, data: server(6), baselineVersion: 6 });

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('overwrites as the newest version straight away, without fetching first', () => {
    const { result, saveOver } = setup(DIRTY_ON_V5);

    result.current.overwrite();

    expect(saveOver).toHaveBeenCalledOnce();
    expect(mocks.fetchLatest).not.toHaveBeenCalled();
  });

  it('a second click before the first overwrite settles starts no second save', async () => {
    const { result, saveOver } = setup(DIRTY_ON_V5);
    let finishSave: () => void = () => {};
    saveOver.mockReturnValueOnce(new Promise<void>((resolve) => (finishSave = resolve)));

    result.current.overwrite();
    result.current.overwrite();
    expect(saveOver).toHaveBeenCalledOnce();

    finishSave();
    await vi.waitFor(() => {
      result.current.overwrite();
      expect(saveOver).toHaveBeenCalledTimes(2);
    });
  });

  it('a failed overwrite releases the guard so the user can try again', async () => {
    const { result, saveOver } = setup(DIRTY_ON_V5);
    saveOver.mockReturnValueOnce(Promise.reject(new Error('CONFLICT')));

    result.current.overwrite();
    await vi.waitFor(() => {
      result.current.overwrite();
      expect(saveOver).toHaveBeenCalledTimes(2);
    });
  });

  it('refuses to overwrite with an invalid flow, and says why', () => {
    const { result, saveOver } = setup({ ...DIRTY_ON_V5, canSave: false });

    result.current.overwrite();

    expect(mocks.fetchLatest).not.toHaveBeenCalled();
    expect(saveOver).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Fix the errors in this flow before overwriting.',
    );
  });

  it('does not start a second save while one is in flight', () => {
    const { result, saveOver } = setup({ ...DIRTY_ON_V5, savePending: true });

    result.current.overwrite();

    expect(mocks.fetchLatest).not.toHaveBeenCalled();
    expect(saveOver).not.toHaveBeenCalled();
  });

  it('applies only the newest reload when an older response lands last', async () => {
    const { result, onReloaded } = setup(DIRTY_ON_V5);
    let resolveOlder: (snapshot: NonNullable<Params['data']>) => void = () => {};
    mocks.fetchLatest
      .mockReturnValueOnce(new Promise((resolve) => (resolveOlder = resolve)))
      .mockResolvedValueOnce(server(7));

    result.current.reload();
    result.current.reload();
    await vi.waitFor(() => expect(onReloaded).toHaveBeenCalledWith(server(7)));
    resolveOlder(server(6));
    await Promise.resolve();
    await Promise.resolve();

    expect(onReloaded).toHaveBeenCalledOnce();
  });

  it('never applies a reload fetched for one flow to the flow the editor switched to', async () => {
    const onReloaded = vi.fn();
    const saveOver = vi.fn(() => Promise.resolve());
    let resolveFetch: (snapshot: NonNullable<Params['data']>) => void = () => {};
    mocks.fetchLatest.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));
    const { result, rerender } = renderHook(
      ({ flowId }: { flowId: string }) =>
        useRemoteVersionSyncWith({ flowId, ...DIRTY_ON_V5, onReloaded, saveOver }, deps),
      { initialProps: { flowId: 'flow-a' } },
    );

    result.current.reload();
    rerender({ flowId: 'flow-b' });
    resolveFetch(server(6));
    await vi.waitFor(() => expect(mocks.fetchLatest).toHaveBeenCalledWith({ id: 'flow-a' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(onReloaded).not.toHaveBeenCalled();
  });

  it('keeps edits typed while a reload was fetching, and says so', async () => {
    const { result, rerender, onReloaded } = setup(DIRTY_ON_V5);
    let resolveFetch: (snapshot: NonNullable<Params['data']>) => void = () => {};
    mocks.fetchLatest.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    result.current.reload();
    rerender({ ...DIRTY_ON_V5, workingCopy: { nodes: ['trigger', 'typed during reload'] } });
    resolveFetch(server(6));

    await vi.waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'You edited the flow while it was reloading, so your edits were kept.',
      ),
    );
    expect(onReloaded).not.toHaveBeenCalled();
  });

  it('stays silent about a reload that failed after a newer one already succeeded', async () => {
    const { result, onReloaded } = setup(DIRTY_ON_V5);
    let rejectOlder: (error: Error) => void = () => {};
    mocks.fetchLatest
      .mockReturnValueOnce(new Promise((_resolve, reject) => (rejectOlder = reject)))
      .mockResolvedValueOnce(server(7));

    result.current.reload();
    result.current.reload();
    await vi.waitFor(() => expect(onReloaded).toHaveBeenCalledWith(server(7)));
    rejectOlder(new Error('offline'));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.reportFailure).not.toHaveBeenCalled();
  });

  it("an overwrite still in flight for one flow does not block the next flow's overwrite", () => {
    const onReloaded = vi.fn();
    const saveOver = vi.fn(() => new Promise<void>(() => {}));
    const { result, rerender } = renderHook(
      ({ flowId }: { flowId: string }) =>
        useRemoteVersionSyncWith({ flowId, ...DIRTY_ON_V5, onReloaded, saveOver }, deps),
      { initialProps: { flowId: 'flow-a' } },
    );

    result.current.overwrite();
    rerender({ flowId: 'flow-b' });
    result.current.overwrite();

    expect(saveOver).toHaveBeenCalledTimes(2);
  });

  it('reports a failed reload instead of dropping the working copy', async () => {
    const { result, onReloaded } = setup(DIRTY_ON_V5);
    mocks.fetchLatest.mockRejectedValue(new Error('offline'));

    result.current.reload();

    await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(onReloaded).not.toHaveBeenCalled();
    expect(mocks.reportFailure).toHaveBeenCalled();
  });

  it('takes the notice down when the editor closes', () => {
    const { rerender, unmount } = setup(DIRTY_ON_V5);
    rerender({ ...DIRTY_ON_V5, data: server(6) });
    mocks.toast.dismiss.mockClear();

    unmount();

    expect(mocks.toast.dismiss).toHaveBeenCalledWith(NOTICE_ID);
  });
});
