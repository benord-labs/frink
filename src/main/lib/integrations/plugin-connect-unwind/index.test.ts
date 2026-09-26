import { beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertConnectionLifecycle } from '../../db/repos/plugin-connection-lifecycle';
import { getByPluginId, install } from '../../db/repos/plugin-installations';
import { freshDb } from '../../db/test-utils/fresh-db';
import * as sentryInit from '../../sentry/init';
import { unwindUnconnectedInstall, unwindUnconnectedInstalls, withGrantUnwind } from './index';

const { chatConnectedMock, mcpLockedMock, mcpPublicMock } = vi.hoisted(() => ({
  chatConnectedMock: vi.fn(async () => false),
  mcpLockedMock: vi.fn(async () => null),
  mcpPublicMock: vi.fn(),
}));

// Boundary mocks: the locked core revokes credentials and touches ~/.frink; its own suite covers it.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../plugin-mcp-lifecycle', () => ({
  uninstallMcpPluginLocked: mcpLockedMock,
  uninstallMcpPlugin: mcpPublicMock,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../mcp/runtime/vendor-plugin-mcp-status', () => ({
  hasStoredVendorPluginMcpCredential: chatConnectedMock,
}));

async function installed(db: ReturnType<typeof freshDb>, pluginId: string, isEnabled = true) {
  return install(db, { pluginId, sourceKind: 'frink_builtin', isEnabled });
}

describe('unwindUnconnectedInstall', () => {
  let db: ReturnType<typeof freshDb>;
  beforeEach(() => {
    db = freshDb();
    vi.clearAllMocks();
  });

  it('tombstones a plugin whose connect attempt ended with no account and no chat grant', async () => {
    await installed(db, 'notion');
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).toHaveBeenCalledExactlyOnceWith(db, 'notion');
  });

  it('keeps a plugin installed while one Flow account is live', async () => {
    await installed(db, 'notion');
    await upsertConnectionLifecycle(db, { pluginId: 'notion', connectionId: 'c1' });
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).not.toHaveBeenCalled();
  });

  it('keeps a plugin installed while an account is still activating', async () => {
    await installed(db, 'notion');
    await upsertConnectionLifecycle(db, {
      pluginId: 'notion',
      connectionId: 'c1',
      lifecycleState: 'disabled',
    });
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).not.toHaveBeenCalled();
  });

  it('a disconnected account no longer claims the install', async () => {
    await installed(db, 'notion');
    await upsertConnectionLifecycle(db, {
      pluginId: 'notion',
      connectionId: 'c1',
      lifecycleState: 'disconnected',
    });
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).toHaveBeenCalledOnce();
  });

  it('keeps a plugin installed when only the chat grant landed', async () => {
    await installed(db, 'notion');
    chatConnectedMock.mockResolvedValueOnce(true);
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).not.toHaveBeenCalled();
  });

  it('leaves a turned-off plugin alone', async () => {
    await installed(db, 'notion', false);
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a plugin that was never installed', async () => {
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpLockedMock).not.toHaveBeenCalled();
  });

  it('never runs the public uninstall, which would re-take the plugin mutex', async () => {
    await installed(db, 'notion');
    await unwindUnconnectedInstall(db, 'notion');
    expect(mcpPublicMock).not.toHaveBeenCalled();
  });

  it('reports an unwind failure instead of throwing it into the connect flow', async () => {
    await installed(db, 'notion');
    mcpLockedMock.mockRejectedValueOnce(new Error('disk full'));
    // vitest.setup.ts noops the whole sentry/init module; spy on it to read what was reported.
    const capture = vi.spyOn(sentryInit, 'captureMainMessage');
    await expect(unwindUnconnectedInstall(db, 'notion')).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
      'warning',
      expect.objectContaining({ surface: 'plugin-connect-unwind', pluginId: 'notion' }),
    );
  });

  it('withGrantUnwind judges by state after the work, whatever the work returned or threw', async () => {
    await installed(db, 'notion');
    await expect(
      withGrantUnwind(db, 'notion', async () => {
        throw new Error('consent declined');
      }),
    ).rejects.toThrow('consent declined');
    expect(mcpLockedMock).toHaveBeenCalledOnce();

    mcpLockedMock.mockClear();
    chatConnectedMock.mockResolvedValueOnce(true);
    await expect(withGrantUnwind(db, 'notion', async () => 'ok')).resolves.toBe('ok');
    expect(mcpLockedMock).not.toHaveBeenCalled();
  });

  it('unwinds every unconnected install at startup and leaves connected and turned-off ones alone', async () => {
    await installed(db, 'notion');
    await installed(db, 'neon');
    await installed(db, 'linear', false);
    await upsertConnectionLifecycle(db, { pluginId: 'neon', connectionId: 'c2' });
    await unwindUnconnectedInstalls(db);
    expect(mcpLockedMock).toHaveBeenCalledExactlyOnceWith(db, 'notion');
    expect((await getByPluginId(db, 'linear'))?.isInstalled).toBe(true);
  });
});
