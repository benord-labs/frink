// Tells an open editor about versions saved outside it, and offers reload or overwrite.

import { useCallback, useEffect, useRef } from 'react';
import type { trpc } from '../../trpc';
import { resolveRemoteUpdateNotice } from './resolve-remote-update-notice';

type FlowSnapshot = Awaited<ReturnType<ReturnType<typeof trpc.useUtils>['flows']['get']['fetch']>>;

export type RemoteVersionSyncParams = {
  flowId: string;
  data: FlowSnapshot | undefined;
  hydrated: boolean;
  locallyModified: boolean;
  baselineVersion: number;
  savePending: boolean;
  /** The working copy passes validation, so it may be saved. */
  canSave: boolean;
  /** The editor's working copy; any edit replaces it, which is how a reload notices late edits. */
  workingCopy: object;
  /** Replace the working copy with this freshly fetched snapshot, dropping local edits. */
  onReloaded: (fresh: FlowSnapshot) => void;
  /** Save the working copy as the newest version, whatever is latest now; settles when the save does. */
  saveOver: () => Promise<void>;
};

type VersionSource = 'agent' | 'ui';

const NOTICE_TITLE = {
  agent: 'An agent updated this flow',
  ui: 'This flow was updated in another window',
  unknown: 'This flow was updated elsewhere',
} satisfies Record<VersionSource | 'unknown', string>;

type PushedVersion = {
  // biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
  version_number: number;
  source: VersionSource;
};

type FlowSyncApi = {
  useUtils: () => {
    flows: {
      get: {
        invalidate: (input: { id: string }) => Promise<void>;
        fetch: (input: { id: string }) => Promise<FlowSnapshot>;
      };
      list: { invalidate: () => Promise<void> };
    };
  };
  flows: {
    onVersionCommitted: {
      useSubscription: (
        input: { flowId: string },
        options: { onData: (event: PushedVersion) => void },
      ) => void;
    };
  };
};

type NoticeButton = { label: string; onClick: () => void };

type NoticeOptions = {
  id: string;
  duration: number;
  description: string;
  action: NoticeButton;
  cancel: NoticeButton;
};

type NoticeToast = {
  (title: string, options: NoticeOptions): string | number;
  dismiss: (id: string) => string | number;
  error: (message: string) => string | number;
};

type FetchFailure = { error: Error; area: string; flowId: string };

/** What the hook reaches outside React for; the editor binds the real ones, tests pass fakes. */
export type RemoteVersionSyncDeps = {
  api: FlowSyncApi;
  toast: NoticeToast;
  reportFailure: (failure: FetchFailure) => void;
};

export function useRemoteVersionSyncWith(
  {
    flowId,
    data,
    hydrated,
    locallyModified,
    baselineVersion,
    savePending,
    canSave,
    workingCopy,
    onReloaded,
    saveOver,
  }: RemoteVersionSyncParams,
  deps: RemoteVersionSyncDeps,
) {
  const { api, toast, reportFailure } = deps;
  const utils = api.useUtils();
  const noticeId = `flow-remote-update-${flowId}`;
  const raisedForRef = useRef<number | null>(null);
  const lastPushRef = useRef<{ version: number; source: VersionSource } | null>(null);
  // Bumped by every Reload and by a flow switch; only the newest reload may apply or report.
  const actionSeqRef = useRef(0);
  // Bumped by a flow switch; an action started for an earlier flow may not touch this one.
  const flowEpochRef = useRef(0);
  // Set synchronously on click, so a second click before React re-renders starts nothing.
  const overwritingRef = useRef(false);
  const liveRef = useRef({ flowId, canSave, savePending, workingCopy, onReloaded, saveOver });
  liveRef.current = { flowId, canSave, savePending, workingCopy, onReloaded, saveOver };

  const reload = useCallback(() => {
    const seq = ++actionSeqRef.current;
    const copyAtClick = liveRef.current.workingCopy;
    // Stale once a newer reload starts, the editor switches flow, or the user edits meanwhile.
    const isCurrent = () => seq === actionSeqRef.current && liveRef.current.flowId === flowId;
    void (async () => {
      try {
        const fresh = await utils.flows.get.fetch({ id: flowId });
        if (!isCurrent()) return;
        if (liveRef.current.workingCopy !== copyAtClick) {
          toast.error('You edited the flow while it was reloading, so your edits were kept.');
          return;
        }
        liveRef.current.onReloaded(fresh);
      } catch (fetchErr) {
        if (!isCurrent()) return;
        const error = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
        reportFailure({ error, area: 'flow-editor-conflict-reload', flowId });
        toast.error('Could not reload the latest version. Try again or reopen the flow.');
      }
    })();
  }, [flowId, utils.flows.get, toast, reportFailure]);

  // Explicit only: the user chose their copy over every version saved since it was loaded.
  const overwrite = useCallback(() => {
    const live = liveRef.current;
    if (!live.canSave) {
      toast.error('Fix the errors in this flow before overwriting.');
      return;
    }
    if (live.savePending || overwritingRef.current) return;
    overwritingRef.current = true;
    const epoch = flowEpochRef.current;
    const settle = () => {
      // A flow switch already released the guard; a late settle must not release the new flow's.
      if (epoch === flowEpochRef.current) overwritingRef.current = false;
    };
    // The editor's save handler reports a failure; this only releases the guard.
    live.saveOver().then(settle, settle);
  }, [toast]);

  api.flows.onVersionCommitted.useSubscription(
    { flowId },
    {
      onData: (event) => {
        lastPushRef.current = { version: event.version_number, source: event.source };
        void utils.flows.get.invalidate({ id: flowId });
        void utils.flows.list.invalidate();
      },
    },
  );

  useEffect(() => {
    const next = resolveRemoteUpdateNotice({
      data,
      hydrated,
      locallyModified,
      baselineVersion,
      savePending,
      raisedForVersion: raisedForRef.current,
    });
    if (!next) return;
    if (next.kind === 'clear') {
      raisedForRef.current = null;
      toast.dismiss(noticeId);
      return;
    }
    raisedForRef.current = next.version;
    const push = lastPushRef.current;
    const source = push?.version === next.version ? push.source : 'unknown';
    toast(NOTICE_TITLE[source], {
      id: noticeId,
      duration: Number.POSITIVE_INFINITY,
      description:
        'Your unsaved changes are kept, so the latest version is not shown here. Reload to get it, or overwrite it with yours.',
      action: { label: 'Reload latest', onClick: reload },
      cancel: { label: 'Overwrite with mine', onClick: overwrite },
    });
  }, [
    data,
    hydrated,
    locallyModified,
    baselineVersion,
    savePending,
    noticeId,
    reload,
    overwrite,
    toast,
  ]);

  // Leaving the editor (or switching flow) takes its notice with it.
  useEffect(
    () => () => {
      actionSeqRef.current += 1;
      flowEpochRef.current += 1;
      overwritingRef.current = false;
      raisedForRef.current = null;
      lastPushRef.current = null;
      toast.dismiss(noticeId);
    },
    [noticeId, toast],
  );

  return { reload, overwrite };
}
