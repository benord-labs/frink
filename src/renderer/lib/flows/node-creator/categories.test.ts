import { describe, expect, it } from 'vitest';
import { buildCustomNodeCategories } from './categories';

describe('buildCustomNodeCategories', () => {
  const node = (name: string, pluginId: string | null) => ({
    name,
    displayName: name.replace(/_/g, ' '),
    description: `${name} desc`,
    icon: null,
    pluginId,
  });

  it('splits plugin-spawned nodes into Integrations and the rest into Custom', () => {
    const built = buildCustomNodeCategories([
      node('my_script', null),
      node('clickup_create_task', 'clickup'),
    ]);

    expect(built.customCategory?.types).toEqual(['my_script']);
    expect(built.integrationsCategory?.types).toEqual(['clickup_create_task']);
    expect(built.pluginMeta.get('clickup_create_task')).toEqual({
      pluginId: 'clickup',
      pluginLabel: 'ClickUp',
    });
  });

  it('groups interleaved integration nodes into consecutive per-plugin runs, first appearance first', () => {
    const built = buildCustomNodeCategories([
      node('clickup_create_task', 'clickup'),
      node('shortcut_create_story', 'shortcut'),
      node('clickup_search', 'clickup'),
    ]);

    // Keyboard order == render order: the list chunks CONSECUTIVE runs.
    expect(built.integrationsCategory?.types).toEqual([
      'clickup_create_task',
      'clickup_search',
      'shortcut_create_story',
    ]);
  });

  it('falls back to the plugin id for an unknown plugin and to null categories when empty', () => {
    const built = buildCustomNodeCategories([node('mystery_tool', 'not-a-plugin')]);
    expect(built.pluginMeta.get('mystery_tool')?.pluginLabel).toBe('not-a-plugin');

    const empty = buildCustomNodeCategories(undefined);
    expect(empty.customCategory).toBeNull();
    expect(empty.integrationsCategory).toBeNull();
    expect(empty.pluginMeta.size).toBe(0);
  });
});
