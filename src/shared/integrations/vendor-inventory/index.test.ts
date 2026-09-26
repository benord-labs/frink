import { describe, expect, it } from 'vitest';
import { PLUGIN_DEFINITIONS, resolvePlugins } from '../plugins';
import { VENDOR_PLUGIN_PINS } from '../vendor-plugin-pins';
import { catalogRuntimeSupport, VENDOR_INVENTORIES } from './index';

describe('bundled vendor catalogue', () => {
  it('covers every exact package pin, including its repository and package directory', () => {
    expect(Object.keys(VENDOR_INVENTORIES).sort()).toEqual(Object.keys(VENDOR_PLUGIN_PINS).sort());
    for (const [id, pin] of Object.entries(VENDOR_PLUGIN_PINS)) {
      expect(VENDOR_INVENTORIES[id].pin, `Regenerate ${id} after changing its pin`).toEqual(pin);
      expect(VENDOR_INVENTORIES[id].pluginId).toBe(`${pin.name}@${pin.marketplace}`);
    }
  });

  it('discloses pinned contents without an installation or a connected account', () => {
    const plugins = resolvePlugins({ installations: [] });
    for (const [id, inventory] of Object.entries(VENDOR_INVENTORIES)) {
      const plugin = plugins.find((entry) => entry.definition.id === id)!;
      expect(plugin.installationState).toBe('not_installed');
      expect(plugin.definition.contents.skills).toEqual(inventory.skills);
      for (const runtime of Object.values(plugin.runtimeSupport)) {
        expect(runtime.delivers.skills).toBe(inventory.skills.length > 0);
        expect(runtime.delivers.commands).toBe(inventory.commands.length > 0);
      }
      for (const skill of inventory.skills) {
        expect(skill.path).not.toMatch(/^(\/|[A-Z]:)|\\|(^|\/)\.\.(\/|$)/);
        expect(skill.id.startsWith(`${inventory.pluginId}:`)).toBe(true);
      }
    }
  });

  it('keeps both runtimes disabled when vendor delivery is off, including skills-only packages', () => {
    for (const id of Object.keys(VENDOR_INVENTORIES)) {
      const contents = PLUGIN_DEFINITIONS.find((entry) => entry.id === id)!.contents;
      for (const candidate of [contents, { ...contents, mcpServers: [] }]) {
        for (const runtime of Object.values(catalogRuntimeSupport(id, candidate, false))) {
          expect(runtime.status).toBe('unsupported');
          expect(runtime.delivers).toMatchObject({ skills: false, commands: false, mcp: false });
        }
      }
    }
  });
});
