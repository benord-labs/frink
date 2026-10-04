// An editor with unsaved edits declines a newer server version, and must say so.

import type { VersionedFlowSnapshot } from './resolve-server-adoption';

export type RemoteUpdateNoticeInput = {
  /** The latest `flows.get` response, or undefined before it lands. */
  data: VersionedFlowSnapshot | undefined;
  /** False until the editor's first hydration has run. */
  hydrated: boolean;
  /** Working copy differs from the graph `baselineVersion` describes — derived, never latched. */
  locallyModified: boolean;
  /** The version the editor's working copy was taken from. */
  baselineVersion: number;
  /** This editor's own save is in flight; its version can arrive before the baseline advances. */
  savePending: boolean;
  /** Server version the notice is currently showing for, or null when none is up. */
  raisedForVersion: number | null;
};

export type RemoteUpdateNoticeAction =
  | { kind: 'raise'; version: number }
  | { kind: 'clear' }
  | null;

/** What the "updated elsewhere" notice should do next; null means leave it as it is. */
export function resolveRemoteUpdateNotice({
  data,
  hydrated,
  locallyModified,
  baselineVersion,
  savePending,
  raisedForVersion,
}: RemoteUpdateNoticeInput): RemoteUpdateNoticeAction {
  if (!data || !hydrated) return null;
  const serverVersion = data.version_number ?? 0;
  const blocked = locallyModified && serverVersion > baselineVersion;
  if (!blocked) return raisedForVersion === null ? null : { kind: 'clear' };
  // Raise only forward: a late, older response must not replace a newer notice.
  if (savePending || (raisedForVersion !== null && serverVersion <= raisedForVersion)) return null;
  return { kind: 'raise', version: serverVersion };
}
