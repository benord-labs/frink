import fs from 'node:fs';
import path from 'node:path';
import type { VendorPluginPin } from '../../../../shared/integrations/vendor-plugin-pins';
import { scanPluginPayloadCommands } from '../../commands';
import { readVettedStagedPlugins } from './index';
import { canonicalPayloadDir } from './layout';
import { containedPluginPath, pluginComponentPaths } from './package-files';

export type StagedVendorInventory = {
  pluginId: string;
  skills: Array<{ id: string; name: string; path: string }>;
  commands: string[];
};
/** scripts/plugin-catalog reads payloads through this without staging them. */
export { vendorPayloadInventory };

/** Discover actual skill folders recursively, without following directory symlinks. */
async function skillDirs(payload: string, relative: string): Promise<string[]> {
  try {
    const dir = await containedPluginPath(payload, relative);
    if (!(await fs.promises.lstat(dir)).isDirectory()) return [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const skill = entries.some((entry) => entry.name === 'SKILL.md' && entry.isFile());
    if (skill) return [dir];
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => skillDirs(payload, path.join(relative, entry.name))),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

async function pluginSkills(payload: string): Promise<string[]> {
  try {
    const roots = await pluginComponentPaths(payload, 'skills');
    return [
      ...new Set((await Promise.all(roots.map((root) => skillDirs(payload, root)))).flat()),
    ].sort();
  } catch {
    return [];
  }
}

/**
 * A staged plugin's skills + slash commands, read from the canonical payload.
 * Commands come from the composer's scanner; catalogue generation uses the same payload reader.
 */
export async function stagedVendorPluginInventory(
  stagedId: string,
): Promise<StagedVendorInventory | null> {
  // Two passes: a same-id payload swap or a remove landing mid-scan makes the first pass stale.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const vetted = (await readVettedStagedPlugins()).find((v) => v.entry.id === stagedId);
    if (!vetted) return null;
    const staged = vetted.entry;
    const payload = canonicalPayloadDir(vetted.pin);
    const inventory = await vendorPayloadInventory(vetted.pin, payload);
    const after = (await readVettedStagedPlugins()).find((v) => v.entry.id === stagedId);
    if (!after) return null;
    if (JSON.stringify(after.entry) !== JSON.stringify(staged)) continue;
    return inventory;
  }
  return null;
}

/** Read the same package metadata from a verified acquisition without enabling its runtime projection. */
async function vendorPayloadInventory(
  pin: VendorPluginPin,
  payload: string,
): Promise<StagedVendorInventory> {
  const pluginId = `${pin.name}@${pin.marketplace}`;
  const [skillNames, commands] = await Promise.all([
    pluginSkills(payload),
    scanPluginPayloadCommands(pin, '', payload),
  ]);
  return {
    pluginId,
    skills: skillNames.map((dir) => {
      const relative = path.relative(payload, dir).replace(/^skills\//, '');
      return { id: `${pluginId}:${relative}`, name: path.basename(dir), path: dir };
    }),
    commands: commands.map((command) => command.name),
  };
}
