import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeHooksPlugin, writeHooksPlugin } from './claude-plugin';

const stopHook = (command: string) => ({
  Stop: [{ hooks: [{ type: 'command' as const, command }] }],
});

describe("Frink's hooks plugin for a Claude launch", () => {
  let home: string;
  const pluginsDir = () => path.join(home, '.frink', 'hooks', 'plugins');
  const read = (folder: string, ...parts: string[]) =>
    JSON.parse(fs.readFileSync(path.join(folder, ...parts), 'utf8'));
  /** A stand-in for `claude plugin validate` that logs each folder it checks, then runs `body`. */
  const fakeClaude = (body: string, name = 'claude') => {
    const bin = path.join(home, name);
    fs.writeFileSync(bin, `#!/bin/sh\necho "$4" >> "${home}/checked"\n${body}\n`, { mode: 0o755 });
    return bin;
  };
  const checked = () => fs.readFileSync(path.join(home, 'checked'), 'utf8').trim().split('\n');
  const judge = `grep -q REFUSE "$4/hooks/hooks.json" && { echo '{"success":false}'; exit 1; }
echo '{"success":true}'`;

  beforeEach(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frink-hooks-plugin-')));
    vi.stubEnv('FRINK_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes the hooks as a plugin folder named by a digest of their content', async () => {
    const folder = await writeHooksPlugin(stopHook('notify'));

    expect(path.dirname(folder)).toBe(pluginsDir());
    expect(path.basename(folder)).toMatch(/^[0-9a-f]{16}$/);
    expect(read(folder, '.claude-plugin', 'plugin.json')).toMatchObject({ name: 'frink-hooks' });
    expect(read(folder, 'hooks', 'hooks.json')).toEqual({ hooks: stopHook('notify') });
  });

  it('reuses the folder for the same hooks and leaves it untouched when the hooks change', async () => {
    const first = await writeHooksPlugin(stopHook('notify'));
    const again = await writeHooksPlugin(stopHook('notify'));
    const changed = await writeHooksPlugin(stopHook('chime'));

    expect(again).toBe(first);
    expect(changed).not.toBe(first);
    expect(read(first, 'hooks', 'hooks.json')).toEqual({ hooks: stopHook('notify') });
    expect(read(changed, 'hooks', 'hooks.json')).toEqual({ hooks: stopHook('chime') });
  });

  it('rewrites a damaged copy whole and leaves no staging folder behind', async () => {
    const folder = await writeHooksPlugin(stopHook('notify'));
    fs.writeFileSync(path.join(folder, 'hooks', 'hooks.json'), '{ "hooks": {} ');

    expect(await writeHooksPlugin(stopHook('notify'))).toBe(folder);
    expect(read(folder, 'hooks', 'hooks.json')).toEqual({ hooks: stopHook('notify') });
    expect(fs.readdirSync(pluginsDir())).toEqual([path.basename(folder)]);
  });

  it('lets two launches write the same hooks at once', async () => {
    const [a, b] = await Promise.all([
      writeHooksPlugin(stopHook('notify')),
      writeHooksPlugin(stopHook('notify')),
    ]);

    expect(a).toBe(b);
    expect(read(a, 'hooks', 'hooks.json')).toEqual({ hooks: stopHook('notify') });
    expect(fs.readdirSync(pluginsDir())).toEqual([path.basename(a)]);
  });

  it('throws when the plugin cannot be written', async () => {
    fs.writeFileSync(path.join(home, '.frink'), 'not a folder');

    await expect(writeHooksPlugin(stopHook('notify'))).rejects.toThrow();
  });

  it("hands over the plugin Claude's own check loads, asking once per plugin", async () => {
    const claude = fakeClaude(judge);

    const [folder, again] = await Promise.all([
      claudeHooksPlugin(stopHook('notify'), claude),
      claudeHooksPlugin(stopHook('notify'), claude),
    ]);

    expect(folder).toBe(await writeHooksPlugin(stopHook('notify')));
    expect(again).toBe(folder);
    expect(checked()).toEqual([folder]);
  });

  it("is null for a plugin Claude's check refuses, and asks again at the next launch", async () => {
    const claude = fakeClaude(judge);

    expect(await claudeHooksPlugin(stopHook('REFUSE'), claude)).toBeNull();
    expect(await claudeHooksPlugin(stopHook('REFUSE'), claude)).toBeNull();
    expect(checked()).toHaveLength(2);
  });

  it('never reuses an acceptance for another CLI build, or for the same path replaced in place', async () => {
    const accepting = fakeClaude(judge);
    const refusing = fakeClaude(`echo '{"success":false}'; exit 1`, 'older-claude');
    const folder = await claudeHooksPlugin(stopHook('notify'), accepting);

    expect(folder).not.toBeNull();
    expect(await claudeHooksPlugin(stopHook('notify'), refusing)).toBeNull();
    expect(await claudeHooksPlugin(stopHook('notify'), accepting)).toBe(folder);
    expect(checked()).toEqual([folder, folder]);

    fs.writeFileSync(
      accepting,
      `#!/bin/sh\necho "$4" >> "${home}/checked"\necho '{"success":false}'; exit 1\n`,
    );
    expect(await claudeHooksPlugin(stopHook('notify'), accepting)).toBeNull();
    expect(checked()).toHaveLength(3);
  });

  it('throws when the check cannot run, and asks again next time', async () => {
    const claude = fakeClaude('exit 2');

    await expect(claudeHooksPlugin(stopHook('notify'), claude)).rejects.toThrow();
    await expect(claudeHooksPlugin(stopHook('notify'), claude)).rejects.toThrow();
    expect(checked()).toHaveLength(2);
    await expect(
      claudeHooksPlugin(stopHook('notify'), path.join(home, 'no-claude')),
    ).rejects.toThrow();
  });
});
