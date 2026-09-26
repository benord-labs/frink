import { describe, expect, it } from 'vitest';
import { freshDb } from '../../test-utils/fresh-db';
import {
  install as installPlugin,
  setEnabled as setPluginEnabled,
  uninstall as uninstallPlugin,
} from '../plugin-installations';
import {
  getConnectionLifecycle,
  isConnectionExecutionAllowed,
  isPluginExecutionAllowed,
  listConnectionLifecycles,
  toConnectionLifecycleSnapshot,
  upsertConnectionLifecycle,
} from '.';

async function installBuiltin(
  db: Parameters<typeof installPlugin>[0],
  pluginId: string,
): Promise<void> {
  await installPlugin(db, { pluginId, sourceKind: 'frink_builtin' });
}

describe('plugin connection lifecycle persistence', () => {
  it('creates defaults and idempotently merges operational state', async () => {
    const db = freshDb();
    await installBuiltin(db, 'shortcut');
    const created = await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
    });

    expect(created).toMatchObject({
      lifecycleState: 'active',
      provisioningState: 'pending',
      cleanupState: 'idle',
    });

    const updated = await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
      provisioningState: 'ready',
      errorCode: null,
    });
    expect(updated).toMatchObject({
      lifecycleState: 'active',
      provisioningState: 'ready',
      cleanupState: 'idle',
    });
    expect(await listConnectionLifecycles(db)).toHaveLength(1);
  });

  it('supports every lifecycle, provisioning, and cleanup state', async () => {
    const db = freshDb();
    await installBuiltin(db, 'shortcut');
    await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
      lifecycleState: 'disabled',
      provisioningState: 'user_managed',
      cleanupState: 'pending',
    });
    await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
      lifecycleState: 'disconnecting',
      provisioningState: 'failed',
      cleanupState: 'failed',
      errorCode: 'upstream_revoke_failed',
    });
    const row = await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
      lifecycleState: 'disconnected',
      cleanupState: 'complete',
      errorCode: null,
    });

    expect(row).toMatchObject({
      lifecycleState: 'disconnected',
      provisioningState: 'failed',
      cleanupState: 'complete',
      errorCode: null,
    });
  });

  it('projects only a fixed sanitized error message', async () => {
    const db = freshDb();
    await installBuiltin(db, 'shortcut');
    const row = await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
      cleanupState: 'failed',
      errorCode: 'managed_mcp_cleanup_failed',
    });

    expect(toConnectionLifecycleSnapshot(row)).toEqual({
      pluginId: 'shortcut',
      connectionId: 'connection-1',
      lifecycleState: 'active',
      provisioningState: 'pending',
      cleanupState: 'failed',
      errorCode: 'managed_mcp_cleanup_failed',
      sanitizedError: 'The managed MCP could not be removed yet.',
    });
    expect(JSON.stringify(toConnectionLifecycleSnapshot(row))).not.toContain('user-1');
  });

  it('denies a missing writer and every durable non-active state', async () => {
    const db = freshDb();
    await installBuiltin(db, 'shortcut');
    await expect(isConnectionExecutionAllowed(db, 'missing', 'shortcut')).resolves.toBe(false);

    for (const lifecycleState of ['disabled', 'disconnecting', 'disconnected'] as const) {
      await upsertConnectionLifecycle(db, {
        pluginId: 'shortcut',
        connectionId: lifecycleState,
        lifecycleState,
      });
      await expect(isConnectionExecutionAllowed(db, lifecycleState, 'shortcut')).resolves.toBe(
        false,
      );
    }

    await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'active',
      lifecycleState: 'active',
    });
    await expect(isConnectionExecutionAllowed(db, 'active', 'shortcut')).resolves.toBe(true);
    await expect(isConnectionExecutionAllowed(db, 'active', 'slack')).resolves.toBe(false);
  });

  it('requires an installed and enabled package', async () => {
    const db = freshDb();
    await expect(isPluginExecutionAllowed(db, 'shortcut')).resolves.toBe(false);

    await installPlugin(db, {
      pluginId: 'shortcut',
      sourceKind: 'frink_builtin',
    });
    await expect(isPluginExecutionAllowed(db, 'shortcut')).resolves.toBe(true);

    await setPluginEnabled(db, 'shortcut', false);
    await expect(isPluginExecutionAllowed(db, 'shortcut')).resolves.toBe(false);

    await uninstallPlugin(db, 'shortcut');
    await expect(isPluginExecutionAllowed(db, 'shortcut')).resolves.toBe(false);
  });

  it('prevents a connection id from changing plugin owner', async () => {
    const db = freshDb();
    await installBuiltin(db, 'shortcut');
    await installBuiltin(db, 'slack');
    await upsertConnectionLifecycle(db, {
      pluginId: 'shortcut',
      connectionId: 'connection-1',
    });

    await expect(
      upsertConnectionLifecycle(db, {
        pluginId: 'slack',
        connectionId: 'connection-1',
      }),
    ).rejects.toThrow('already owned by plugin shortcut');
    expect(await getConnectionLifecycle(db, 'connection-1')).toMatchObject({
      pluginId: 'shortcut',
    });
  });

  it('rejects a lifecycle without an explicit installation', async () => {
    const db = freshDb();

    await expect(
      upsertConnectionLifecycle(db, {
        pluginId: 'shortcut',
        connectionId: 'connection-1',
      }),
    ).rejects.toThrow();
  });
});
