import * as fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type VendorPluginPin,
  vendorPluginPinByName,
} from '../../../shared/integrations/vendor-plugin-pins';
import { getCommandContent, isCommandPath, isReadableCommandPath, listCommands } from './scan';

// scan.ts and the vendor-plugin layout both read os.homedir() from the default export, so one spy
// points every root at a per-test tmp dir; the shared mockHome also pins FRINK_HOME.
import { mockHome } from '../provider/handlers/test-mock-home';

function notionPin(): VendorPluginPin {
  const found = vendorPluginPinByName('notion');
  if (!found) throw new Error('the notion pin is the fixture for every plugin-command test');
  return found;
}
const pin = notionPin();

/** Mirror what installVendorPlugin leaves on disk: staged.json plus the canonical payload. */
async function stagePlugin(
  home: string,
  entry: { name: string; marketplace: string; version?: string; gitCommitSha?: string },
) {
  const root = path.join(home, '.frink', 'plugins');
  const commandsDir = path.join(root, 'vendor', entry.name, pin.version, 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(
    path.join(commandsDir, 'standup.md'),
    '---\ndescription: Standup from Slack\n---\nDraft my standup\n',
  );
  await fs.writeFile(path.join(commandsDir, 'summarize-channel.md'), 'Channel $ARGUMENTS\n');
  const staged = {
    id: `${entry.name}@${entry.marketplace}`,
    version: pin.version,
    gitCommitSha: pin.gitCommitSha,
    ...entry,
    sourceRepo: pin.sourceRepo,
    installedAt: '2026-09-05T00:00:00Z',
  };
  await fs.writeFile(path.join(root, 'staged.json'), JSON.stringify({ plugins: [staged] }));
  return commandsDir;
}

describe('listCommands with a staged vendor plugin (sc-2799)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-plugin-'));
    mockHome.value = tmp;
    vi.spyOn(os, 'homedir').mockImplementation(() => mockHome.value);
    await fs.mkdir(path.join(tmp, '.frink', 'commands'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.frink', 'commands', 'deploy.md'), 'Run deploy\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists the payload commands as <plugin>:<stem>, origin plugin, after every user root', async () => {
    const commandsDir = await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace });
    const names = (await listCommands()).map((cmd) => cmd.name);
    expect(names).toEqual(['deploy', 'notion:standup', 'notion:summarize-channel']);
    const standup = (await listCommands()).find((cmd) => cmd.name === 'notion:standup');
    expect(standup).toMatchObject({
      origin: 'plugin',
      source: 'user',
      description: 'Standup from Slack',
      path: path.join(commandsDir, 'standup.md'),
    });
  });

  it('ignores a staged.json entry the pin table does not vet', async () => {
    await stagePlugin(tmp, { name: pin.name, marketplace: 'somewhere-else' });
    expect((await listCommands()).map((cmd) => cmd.name)).toEqual(['deploy']);
  });

  it('ignores a stale entry whose version or commit no longer matches the pin', async () => {
    await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace, version: '0.0.1' });
    expect((await listCommands()).map((cmd) => cmd.name)).toEqual(['deploy']);
    await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace, gitCommitSha: 'bad' });
    expect((await listCommands()).map((cmd) => cmd.name)).toEqual(['deploy']);
  });

  it('lets a user command of the same name shadow the vendor template', async () => {
    await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace });
    await fs.mkdir(path.join(tmp, '.frink', 'commands', 'notion'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.frink', 'commands', 'notion', 'standup.md'), 'mine\n');
    const standup = (await listCommands()).filter((cmd) => cmd.name === 'notion:standup');
    expect(standup).toHaveLength(1);
    expect(standup[0].origin).toBe('frink');
  });

  it('scans only the six classic roots when nothing is staged', async () => {
    expect((await listCommands()).map((cmd) => cmd.name)).toEqual(['deploy']);
  });

  it('reports no arguments for a file whose frontmatter will not parse (sc-2858)', async () => {
    // getCommandContent returns '' for the same file, so a marker here would promise a
    // substitution that cannot happen.
    await fs.writeFile(
      path.join(tmp, '.frink', 'commands', 'broken.md'),
      '---\ndescription: "unterminated\n---\nChannel $ARGUMENTS\n',
    );
    const broken = (await listCommands()).find((cmd) => cmd.name === 'broken');
    expect(broken).toMatchObject({ description: '', takesArguments: false });
  });

  it('flags takesArguments from the body, not the frontmatter (sc-2858)', async () => {
    // argument-hint alone must not set the flag: frink fills $ARGUMENTS by replacement only, so a
    // body without the token discards whatever the user types.
    await fs.writeFile(
      path.join(tmp, '.frink', 'commands', 'hinted.md'),
      '---\nargument-hint: "[env]"\n---\nShip it\n',
    );
    await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace });
    const byName = new Map((await listCommands()).map((cmd) => [cmd.name, cmd]));
    expect(byName.get('notion:summarize-channel')?.takesArguments).toBe(true);
    expect(byName.get('notion:standup')?.takesArguments).toBe(false);
    expect(byName.get('hinted')).toMatchObject({ argumentHint: '[env]', takesArguments: false });
  });
});

describe('the read gate for vendor plugin commands (sc-2799)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-gate-'));
    mockHome.value = tmp;
    vi.spyOn(os, 'homedir').mockImplementation(() => mockHome.value);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reads a vendor command but never admits it to the write gate', async () => {
    const commandsDir = await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace });
    const file = path.join(commandsDir, 'summarize-channel.md');
    expect(await isReadableCommandPath(file)).toBe(true);
    expect(await isCommandPath(file)).toBe(false);
    expect(await getCommandContent(file)).toBe('Channel $ARGUMENTS');
  });

  it('refuses a commands/ root that is a symlink out of the payload, for scan and read alike', async () => {
    const commandsDir = await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace });
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'evil.md'), 'not vendor content\n');
    await fs.rm(commandsDir, { recursive: true });
    await fs.symlink(outside, commandsDir);
    expect((await listCommands()).map((cmd) => cmd.name)).toEqual([]);
    expect(await isReadableCommandPath(path.join(commandsDir, 'evil.md'))).toBe(false);
  });

  it('still reads through a symlinked home directory', async () => {
    const realHome = path.join(tmp, 'real-home');
    await fs.mkdir(realHome);
    const commandsDir = await stagePlugin(realHome, {
      name: pin.name,
      marketplace: pin.marketplace,
    });
    const linkHome = path.join(tmp, 'home-link');
    await fs.symlink(realHome, linkHome);
    mockHome.value = linkHome;
    const viaLink = path.join(linkHome, path.relative(realHome, commandsDir), 'standup.md');
    expect(await isReadableCommandPath(viaLink)).toBe(true);
  });

  it('rejects non-.md or non-file paths, an unvetted plugin, and a missing file', async () => {
    const commandsDir = await stagePlugin(tmp, { name: pin.name, marketplace: pin.marketplace });
    const payload = path.dirname(commandsDir);
    await fs.writeFile(path.join(payload, '.mcp.json'), '{}');
    await fs.writeFile(path.join(commandsDir, 'README.txt'), 'not a command');
    expect(await isReadableCommandPath(path.join(payload, '.mcp.json'))).toBe(false);
    expect(await isReadableCommandPath(path.join(commandsDir, 'README.txt'))).toBe(false);
    expect(await isReadableCommandPath(commandsDir)).toBe(false);
    expect(await isReadableCommandPath(path.join(commandsDir, 'missing.md'))).toBe(false);
    await expect(getCommandContent(path.join(payload, '.mcp.json'))).rejects.toThrow(
      'Invalid path',
    );

    await stagePlugin(tmp, { name: pin.name, marketplace: 'somewhere-else' });
    expect(await isReadableCommandPath(path.join(commandsDir, 'standup.md'))).toBe(false);
  });
});
