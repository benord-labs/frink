import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type VendorPluginPin,
  vendorPluginPinByName,
} from '../../../../shared/integrations/vendor-plugin-pins';
import { stagedVendorPluginInventory } from './inventory';
import { canonicalPayloadDir, vendorPluginsRoot } from './layout';

function notionPin(): VendorPluginPin {
  const found = vendorPluginPinByName('notion');
  if (!found) throw new Error('the notion pin is the fixture for every inventory test');
  return found;
}
const pin = notionPin();
const STAGED_ID = `${pin.name}@${pin.marketplace}`;

function writeManifest(overrides: Partial<VendorPluginPin> = {}) {
  fs.mkdirSync(vendorPluginsRoot(), { recursive: true });
  fs.writeFileSync(
    path.join(vendorPluginsRoot(), 'staged.json'),
    JSON.stringify({ plugins: [{ ...pin, ...overrides, id: STAGED_ID, installedAt: 'now' }] }),
  );
}

describe('stagedVendorPluginInventory commands (sc-2799)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-inventory-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    vi.stubEnv('FRINK_HOME', tmpRoot);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('counts nested command FILES the way the composer scan namespaces them', async () => {
    const commandsDir = path.join(canonicalPayloadDir(pin), 'commands');
    fs.mkdirSync(path.join(commandsDir, 'git'), { recursive: true });
    fs.mkdirSync(path.join(commandsDir, 'group.md'));
    fs.writeFileSync(path.join(commandsDir, 'standup.md'), 'x');
    fs.writeFileSync(path.join(commandsDir, 'git', 'commit.md'), 'x');
    fs.writeFileSync(path.join(commandsDir, 'README.txt'), 'x');
    fs.symlinkSync(path.join(commandsDir, 'standup.md'), path.join(commandsDir, 'daily.md'));
    writeManifest();

    const inventory = await stagedVendorPluginInventory(STAGED_ID);
    expect(inventory?.commands.sort()).toEqual(['daily', 'git:commit', 'standup']);
  });

  it('reports an empty inventory, not a failure, for a payload without a commands dir', async () => {
    fs.mkdirSync(canonicalPayloadDir(pin), { recursive: true });
    writeManifest();
    expect(await stagedVendorPluginInventory(STAGED_ID)).toEqual({
      pluginId: STAGED_ID,
      skills: [],
      commands: [],
    });
  });

  it('inventories actual nested skills, preserving relative IDs and ignoring empty folders', async () => {
    const payload = canonicalPayloadDir(pin);
    for (const relative of [
      'skills/notion/search',
      'skills/notion/create',
      'skills/empty',
      'inactive-skills/old',
    ]) {
      fs.mkdirSync(path.join(payload, relative), { recursive: true });
      if (!relative.endsWith('empty'))
        fs.writeFileSync(path.join(payload, relative, 'SKILL.md'), '# Skill');
    }
    writeManifest();
    const inventory = await stagedVendorPluginInventory(STAGED_ID);
    expect(inventory?.skills).toEqual(
      ['create', 'search'].map((name) => ({
        id: `${STAGED_ID}:notion/${name}`,
        name,
        path: path.join(payload, 'skills/notion', name),
      })),
    );
  });

  it.each([{ skills: './active' }, { skills: ['./active', './active/nested'] }])(
    'honors a declared skill root %j',
    async ({ skills }) => {
      const payload = canonicalPayloadDir(pin);
      for (const relative of ['active/nested/skill', 'skills/undeclared']) {
        fs.mkdirSync(path.join(payload, relative), { recursive: true });
        fs.writeFileSync(path.join(payload, relative, 'SKILL.md'), '# Skill');
      }
      fs.mkdirSync(path.join(payload, '.claude-plugin'));
      fs.writeFileSync(
        path.join(payload, '.claude-plugin/plugin.json'),
        JSON.stringify({ skills }),
      );
      writeManifest();
      expect((await stagedVendorPluginInventory(STAGED_ID))?.skills).toEqual([
        {
          id: `${STAGED_ID}:active/nested/skill`,
          name: 'skill',
          path: path.join(payload, 'active/nested/skill'),
        },
      ]);
    },
  );

  it('does not inventory declared or nested directory symlinks outside the payload', async () => {
    const payload = canonicalPayloadDir(pin);
    const outside = path.join(tmpRoot, 'outside-skill');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'SKILL.md'), '# Outside');
    fs.mkdirSync(path.join(payload, 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(payload, 'skills/escape'));
    writeManifest();
    expect((await stagedVendorPluginInventory(STAGED_ID))?.skills).toEqual([]);
    fs.mkdirSync(path.join(payload, '.claude-plugin'));
    fs.writeFileSync(
      path.join(payload, '.claude-plugin/plugin.json'),
      JSON.stringify({ skills: outside }),
    );
    expect((await stagedVendorPluginInventory(STAGED_ID))?.skills).toEqual([]);
  });

  it('reads a malformed manifest as nothing staged instead of throwing', async () => {
    fs.mkdirSync(vendorPluginsRoot(), { recursive: true });
    const manifest = path.join(vendorPluginsRoot(), 'staged.json');
    fs.writeFileSync(manifest, JSON.stringify({ plugins: [null, 'notion', { id: STAGED_ID }] }));
    expect(await stagedVendorPluginInventory(STAGED_ID)).toBeNull();
    fs.writeFileSync(manifest, '{not json');
    expect(await stagedVendorPluginInventory(STAGED_ID)).toBeNull();
  });

  it('returns null for an entry whose version or commit no longer matches the pin', async () => {
    const commandsDir = path.join(canonicalPayloadDir(pin), 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'standup.md'), 'x');
    writeManifest({ version: '0.0.1' });
    expect(await stagedVendorPluginInventory(STAGED_ID)).toBeNull();
    writeManifest({ gitCommitSha: 'tampered' });
    expect(await stagedVendorPluginInventory(STAGED_ID)).toBeNull();
  });
});
