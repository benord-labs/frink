import { describe, expect, it } from 'vitest';
import {
  findPluginActionByNodeName,
  INTEGRATION_NODES_SUBDIR,
  isReservedNodeName,
  pluginActionNodeName,
  pluginNodeNamePrefix,
  reservedPluginIdForNodeName,
} from './plugin-nodes';

describe('pluginActionNodeName', () => {
  it('maps action id dots to underscores', () => {
    expect(pluginActionNodeName('shortcut.create_story')).toBe('shortcut_create_story');
    expect(pluginActionNodeName('clickup.get_task')).toBe('clickup_get_task');
  });

  it('rejects action ids that cannot form a legal node name', () => {
    expect(() => pluginActionNodeName('Shortcut.Create')).toThrow(/valid node name/);
    expect(() => pluginActionNodeName('shortcut create')).toThrow(/valid node name/);
    expect(() => pluginActionNodeName('.leading')).toThrow(/valid node name/);
    expect(() => pluginActionNodeName('')).toThrow(/valid node name/);
  });

  it('round-trips a real catalog action through the reverse lookup', () => {
    const nodeName = pluginActionNodeName('shortcut.create_story');
    const found = findPluginActionByNodeName(nodeName);
    expect(found?.pluginId).toBe('shortcut');
    expect(found?.action.id).toBe('shortcut.create_story');
    expect(found?.action.source).toEqual({
      type: 'provider_mcp',
      serverId: 'shortcut',
      toolId: 'stories-create',
    });
  });
});

describe('findPluginActionByNodeName', () => {
  it('returns undefined for a name no catalog action generates', () => {
    expect(findPluginActionByNodeName('shortcut_not_a_real_action')).toBeUndefined();
    expect(findPluginActionByNodeName('my-script-node')).toBeUndefined();
  });
});

describe('reservedPluginIdForNodeName', () => {
  it('reserves the {pluginId}_ namespace for catalog plugins', () => {
    expect(reservedPluginIdForNodeName('shortcut_create_story')).toBe('shortcut');
    expect(reservedPluginIdForNodeName('clickup_anything')).toBe('clickup');
    expect(pluginNodeNamePrefix('clickup')).toBe('clickup_');
  });

  it('leaves non-namespaced and hyphenated names unreserved', () => {
    expect(reservedPluginIdForNodeName('my-script-node')).toBeUndefined();
    expect(reservedPluginIdForNodeName('shortcut-helper')).toBeUndefined();
    expect(reservedPluginIdForNodeName('shortcut')).toBeUndefined();
  });
});

describe('isReservedNodeName', () => {
  it('reserves the integrations subfolder and every plugin namespace for the machine', () => {
    expect(isReservedNodeName(INTEGRATION_NODES_SUBDIR)).toBe(true);
    expect(isReservedNodeName('clickup_anything')).toBe(true);
    expect(isReservedNodeName('integrations-helper')).toBe(false);
    expect(isReservedNodeName('my-script-node')).toBe(false);
  });
});
