import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_PLUGIN_PINS } from '../../src/shared/integrations/vendor-plugin-pins';
import { generateInventory } from './generate';

let payload: string;
beforeEach(async () => {
  payload = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-inventory-test-'));
  await fs.mkdir(path.join(payload, '.claude-plugin'));
  await fs.writeFile(path.join(payload, '.claude-plugin/plugin.json'), '{}');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(payload, { recursive: true, force: true });
});

describe('catalogue generation', () => {
  it('uses the runtime scanner with declared roots and emits portable, deterministic paths', async () => {
    await fs.writeFile(
      path.join(payload, '.claude-plugin/plugin.json'),
      JSON.stringify({ skills: ['./guides'], commands: ['./commands/triage.md'] }),
    );
    await fs.mkdir(path.join(payload, 'guides/nested/plan'), { recursive: true });
    await fs.writeFile(path.join(payload, 'guides/nested/plan/SKILL.md'), '# Plan');
    // Reference copies within a skill are payload, not separately invokable skills.
    await fs.mkdir(path.join(payload, 'guides/nested/plan/upstream'), { recursive: true });
    await fs.writeFile(path.join(payload, 'guides/nested/plan/upstream/SKILL.md'), '# Reference');
    await fs.mkdir(path.join(payload, 'commands'));
    await fs.writeFile(path.join(payload, 'commands/triage.md'), '# Triage');
    await fs.writeFile(path.join(payload, 'commands/_conventions.md'), '# Authoring guidance');
    const result = await generateInventory(VENDOR_PLUGIN_PINS.clickup, payload);
    expect(result.pin).toEqual(VENDOR_PLUGIN_PINS.clickup);
    expect(result.skills).toEqual([
      { id: `${result.pluginId}:guides/nested/plan`, name: 'plan', path: 'guides/nested/plan' },
    ]);
    expect(result.commands).toEqual(['triage']);
    expect(await generateInventory(VENDOR_PLUGIN_PINS.clickup, payload)).toEqual(result);
  });

  it('allows an intentionally empty package', async () => {
    expect(await generateInventory(VENDOR_PLUGIN_PINS.clickup, payload)).toMatchObject({
      skills: [],
      commands: [],
    });
  });

  it('rejects broken declarations instead of publishing an empty inventory', async () => {
    await fs.writeFile(
      path.join(payload, '.claude-plugin/plugin.json'),
      JSON.stringify({ skills: ['./missing'] }),
    );
    await expect(generateInventory(VENDOR_PLUGIN_PINS.clickup, payload)).rejects.toThrow();
  });

  it('rejects unreadable payload files instead of publishing an empty inventory', async () => {
    vi.spyOn(fs, 'access').mockRejectedValue(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    await expect(generateInventory(VENDOR_PLUGIN_PINS.clickup, payload)).rejects.toThrow(
      'Permission denied',
    );
  });
});
