import * as Sentry from '@sentry/electron/renderer';
import { toast } from 'sonner';
import {
  type RemoteVersionSyncDeps,
  type RemoteVersionSyncParams,
  useRemoteVersionSyncWith,
} from '../../../../../lib/flows/editor-sync/use-remote-version-sync';
import { trpc } from '../../../../../lib/trpc';

const REAL_DEPS: RemoteVersionSyncDeps = {
  api: trpc,
  toast,
  reportFailure: ({ error, area, flowId }) => {
    Sentry.captureException(error, { tags: { source: 'FlowEditor', area }, extra: { flowId } });
  },
};

/** `useRemoteVersionSyncWith`, bound to the app's tRPC client, toasts and error reporting. */
export function useRemoteVersionSync(params: RemoteVersionSyncParams) {
  return useRemoteVersionSyncWith(params, REAL_DEPS);
}
