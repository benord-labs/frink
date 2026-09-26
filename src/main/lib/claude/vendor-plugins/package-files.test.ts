import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containedPluginPath, pluginComponentPaths, readPluginJson } from './package-files';

let base = '';
let root = '';
const manifest = '.claude-plugin/plugin.json';

async function writeManifest(body: string): Promise<void> {
  await fs.writeFile(path.join(root, manifest), body);
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'package-files-'));
  root = path.join(base, 'package');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'theirs.json'), '{"skills":["theirs"]}');
  await fs.symlink(path.join(outside, 'theirs.json'), path.join(root, 'escape.json'));
  await fs.symlink(path.join(outside, 'gone.json'), path.join(root, 'dangling.json'));
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('containedPluginPath', () => {
  it('resolves a declaration that stays inside its package', async () => {
    await writeManifest('{}');
    expect(await containedPluginPath(root, manifest)).toBe(path.join(root, manifest));
  });

  it.each([
    ['an absolute path', '/etc/hosts'],
    ['a parent-directory escape', '../outside/theirs.json'],
  ])('refuses %s', async (_case, relative) => {
    await expect(containedPluginPath(root, relative)).rejects.toThrow('escapes its package');
  });

  it('refuses a symlink whose target sits outside the package', async () => {
    await expect(containedPluginPath(root, 'escape.json')).rejects.toThrow('symlink escapes');
  });
});

describe('readPluginJson', () => {
  it('reads an absent optional manifest as undefined', async () => {
    expect(await readPluginJson(root, 'no-such-file.json')).toBeUndefined();
  });

  it('treats a dangling symlink as a broken declaration, not an absent one', async () => {
    await expect(readPluginJson(root, 'dangling.json')).rejects.toThrow();
  });
});

describe('pluginComponentPaths', () => {
  it('falls back to the conventional root when the package declares nothing', async () => {
    await writeManifest('{}');
    expect(await pluginComponentPaths(root, 'skills')).toEqual(['skills']);
  });

  it('reads one declared path as a single root', async () => {
    await writeManifest('{"commands":"tools/commands"}');
    expect(await pluginComponentPaths(root, 'commands')).toEqual(['tools/commands']);
  });

  it('honours an explicit empty list over the conventional root', async () => {
    await writeManifest('{"skills":[]}');
    expect(await pluginComponentPaths(root, 'skills')).toEqual([]);
  });
});
