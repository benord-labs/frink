import { describe, expect, it } from 'vitest';
import * as schema from '../../schema';
import { freshDb } from '../../test-utils/fresh-db';
import { getByPluginId, install, listInstallations, setEnabled, uninstall } from '.';

describe('plugin installation persistence', () => {
  it('installs, disables, uninstalls, and explicitly reinstalls one stable row', async () => {
    const db = freshDb();
    const installed = await install(db, {
      pluginId: 'shortcut',
      sourceKind: 'frink_builtin',
      installedVersion: '1.0.0',
    });

    expect(installed).toMatchObject({
      pluginId: 'shortcut',
      isInstalled: true,
      isEnabled: true,
    });
    expect(await setEnabled(db, 'shortcut', false)).toMatchObject({
      isInstalled: true,
      isEnabled: false,
    });

    const tombstone = await uninstall(db, 'shortcut');
    expect(tombstone).toMatchObject({ isInstalled: false, isEnabled: false });
    expect(tombstone?.uninstalledAt).toBeInstanceOf(Date);
    await expect(setEnabled(db, 'shortcut', true)).resolves.toBeNull();

    const reinstalled = await install(db, {
      pluginId: 'shortcut',
      sourceKind: 'frink_builtin',
      installedVersion: '1.1.0',
    });
    expect(reinstalled).toMatchObject({
      id: installed.id,
      installedVersion: '1.1.0',
      isInstalled: true,
      isEnabled: true,
      uninstalledAt: null,
    });
    expect(await listInstallations(db)).toHaveLength(1);
  });

  it('prevents an imported package from taking over a builtin plugin id', async () => {
    const db = freshDb();

    await expect(
      install(db, {
        pluginId: 'shortcut',
        sourceKind: 'agent_plugins_v1',
        sourceLocator: '/plugins/not-shortcut',
      }),
    ).rejects.toThrow('reserved by a Frink builtin');
    expect(await getByPluginId(db, 'shortcut')).toBeNull();

    await install(db, {
      pluginId: 'shortcut',
      sourceKind: 'frink_builtin',
    });
    await expect(
      install(db, {
        pluginId: 'shortcut',
        sourceKind: 'agent_plugins_v1',
        sourceLocator: '/plugins/not-shortcut',
      }),
    ).rejects.toThrow('reserved by a Frink builtin');
    expect(await getByPluginId(db, 'shortcut')).toMatchObject({
      sourceKind: 'frink_builtin',
      sourceLocator: null,
    });
  });

  it('keeps users isolated under the composite unique key', async () => {
    const db = freshDb();
    await install(db, {
      pluginId: 'shortcut',
      sourceKind: 'frink_builtin',
    });
    await install(db, {
      pluginId: 'shortcut',
      sourceKind: 'frink_builtin',
    });

    expect(await listInstallations(db)).toHaveLength(1);
    expect(await listInstallations(db)).toHaveLength(1);
  });

  it('enforces imported source locators and tombstone state at the schema level', () => {
    const db = freshDb();
    const now = new Date();

    expect(() =>
      db
        .insert(schema.pluginInstallations)
        .values({
          id: 'invalid-import',
          pluginId: 'imported',
          sourceKind: 'agent_plugins_v1',
          sourceLocator: '  ',
          installedAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      db
        .insert(schema.pluginInstallations)
        .values({
          id: 'invalid-builtin',
          pluginId: 'shortcut',
          sourceKind: 'frink_builtin',
          sourceLocator: '/plugins/shortcut',
          installedAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      db
        .insert(schema.pluginInstallations)
        .values({
          id: 'invalid-tombstone',
          pluginId: 'shortcut',
          sourceKind: 'frink_builtin',
          isInstalled: false,
          isEnabled: true,
          installedAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});
