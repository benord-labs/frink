// A dirty editor was never told an agent had saved a newer version until Save conflicted.

import { describe, expect, it } from 'vitest';
import { resolveRemoteUpdateNotice } from './resolve-remote-update-notice';

// biome-ignore lint/style/useNamingConvention: flows IPC snake_case contract
const server = (version: number | null) => ({ version_number: version });

/** Editor forked from v5 with unsaved edits, nothing saving, no notice up. */
const DIRTY_ON_V5 = {
  hydrated: true,
  locallyModified: true,
  baselineVersion: 5,
  savePending: false,
  raisedForVersion: null,
};

describe('resolveRemoteUpdateNotice', () => {
  it('raises when a newer version lands while the working copy has unsaved edits', () => {
    expect(resolveRemoteUpdateNotice({ data: server(6), ...DIRTY_ON_V5 })).toEqual({
      kind: 'raise',
      version: 6,
    });
  });

  it('raises once per version: a repeat poll of the same version leaves the notice alone', () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(6), ...DIRTY_ON_V5, raisedForVersion: 6 }),
    ).toBeNull();
  });

  it('raises again for a still newer version, replacing the earlier notice', () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(7), ...DIRTY_ON_V5, raisedForVersion: 6 }),
    ).toEqual({ kind: 'raise', version: 7 });
  });

  it('ignores a late, older response once a newer version is on screen', () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(6), ...DIRTY_ON_V5, raisedForVersion: 7 }),
    ).toBeNull();
  });

  it('stays quiet for a clean editor — adoption applies the version instead', () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(6), ...DIRTY_ON_V5, locallyModified: false }),
    ).toBeNull();
  });

  it('clears once the working copy is clean again', () => {
    expect(
      resolveRemoteUpdateNotice({
        data: server(6),
        ...DIRTY_ON_V5,
        locallyModified: false,
        raisedForVersion: 6,
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('clears once the baseline catches up (reload or overwrite), even with new edits', () => {
    expect(
      resolveRemoteUpdateNotice({
        data: server(6),
        ...DIRTY_ON_V5,
        baselineVersion: 6,
        raisedForVersion: 6,
      }),
    ).toEqual({ kind: 'clear' });
  });

  it("does not report the editor's own save: its version arrives before the baseline advances", () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(6), ...DIRTY_ON_V5, savePending: true }),
    ).toBeNull();
  });

  it('does nothing before hydration or before the first response', () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(6), ...DIRTY_ON_V5, hydrated: false }),
    ).toBeNull();
    expect(resolveRemoteUpdateNotice({ data: undefined, ...DIRTY_ON_V5 })).toBeNull();
  });

  it('treats a never-saved flow (null version) as version 0', () => {
    expect(
      resolveRemoteUpdateNotice({ data: server(null), ...DIRTY_ON_V5, baselineVersion: 0 }),
    ).toBeNull();
  });
});
