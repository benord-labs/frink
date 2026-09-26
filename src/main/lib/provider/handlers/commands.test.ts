import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vendorPluginPinByName } from '../../../../shared/integrations/vendor-plugin-pins';
import { CAPABILITY_MAP } from '../capabilities';
import type { ProviderType } from '../types';
import { deliverCommands } from './commands';

// Mutable home so os.homedir() (used by the handler + listCommands/getCommandContent)
// points at a per-test tmp dir. ESM namespaces are read-only → mock the module.
const { mockHome } = vi.hoisted(() => ({ mockHome: { value: '' } }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => mockHome.value;
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

describe('deliverCommands (PCH-2b)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pch2b-'));
    mockHome.value = tmp;
    vi.stubEnv('FRINK_HOME', tmp);
    await fs.mkdir(path.join(tmp, '.frink', 'commands', 'git'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.frink', 'commands', 'deploy.md'),
      '---\ndescription: Deploy it\n---\nRun deploy\n',
    );
    // namespaced command: git:commit → git/commit.md
    await fs.writeFile(path.join(tmp, '.frink', 'commands', 'git', 'commit.md'), 'Make a commit\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('projects frink commands into the claude machine-local dir, namespaced + provenance-stamped', async () => {
    const res = await deliverCommands({
      mode: 'copy',
      ctx: { projectId: 'p', projectPath: tmp, provider: 'claude-code' },
    });
    expect(res.status).toBe('delivered');

    const deploy = matter(
      await fs.readFile(path.join(tmp, '.claude', 'commands', 'deploy.md'), 'utf-8'),
    );
    expect(deploy.data.frinkProjected).toBe(true);
    expect(deploy.data.description).toBe('Deploy it');
    expect(deploy.content.trim()).toBe('Run deploy');

    const commit = matter(
      await fs.readFile(path.join(tmp, '.claude', 'commands', 'git', 'commit.md'), 'utf-8'),
    );
    expect(commit.data.frinkProjected).toBe(true);
    expect(commit.content.trim()).toBe('Make a commit');
  });

  it('routes cursor to the cursor machine-local dir', async () => {
    await deliverCommands({
      mode: 'copy',
      ctx: { projectId: 'p', projectPath: tmp, provider: 'cursor' },
    });
    const f = matter(
      await fs.readFile(path.join(tmp, '.cursor', 'commands', 'deploy.md'), 'utf-8'),
    );
    expect(f.data.frinkProjected).toBe(true);
  });

  it('is a noop for every provider whose descriptor says commands `none` (sc-2800)', async () => {
    // SAFETY: CAPABILITY_MAP is Record<ProviderType, _>, so its keys are exactly ProviderType.
    const none = (Object.keys(CAPABILITY_MAP) as ProviderType[]).filter(
      (provider) => CAPABILITY_MAP[provider].commands === 'none',
    );
    expect(none).toContain('codex');
    for (const provider of none) {
      const res = await deliverCommands({
        mode: 'copy',
        ctx: { projectId: 'p', projectPath: tmp, provider },
      });
      expect(res.status).toBe('noop');
    }
    // codex reads no commands dir; the old copy into ~/.codex/commands was a dead write.
    await expect(fs.access(path.join(tmp, '.codex'))).rejects.toThrow();
  });

  it('never writes into the committed project dir', async () => {
    await deliverCommands({
      mode: 'copy',
      ctx: { projectId: 'p', projectPath: tmp, provider: 'claude-code' },
    });
    // projection goes to ~/.claude (== tmp/.claude here), NOT projectPath/.claude
    // (projectPath is also tmp in this test, so assert the file is under the home commands dir).
    await expect(
      fs.access(path.join(tmp, '.claude', 'commands', 'deploy.md')),
    ).resolves.toBeUndefined();
  });

  it('never projects a staged vendor plugin command into a provider dir (sc-2799)', async () => {
    const pin = vendorPluginPinByName('notion');
    if (!pin) throw new Error('notion pin missing');
    const root = path.join(tmp, '.frink', 'plugins');
    const commandsDir = path.join(root, 'vendor', pin.name, pin.version, 'commands');
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(path.join(commandsDir, 'standup.md'), 'vendor template\n');
    const staged = { ...pin, id: `${pin.name}@${pin.marketplace}`, installedAt: 'now' };
    await fs.writeFile(path.join(root, 'staged.json'), JSON.stringify({ plugins: [staged] }));

    await deliverCommands({
      mode: 'copy',
      ctx: { projectId: 'p', projectPath: tmp, provider: 'claude-code' },
    });
    await expect(
      fs.access(path.join(tmp, '.claude', 'commands', 'notion', 'standup.md')),
    ).rejects.toThrow();
  });

  it('does not clobber a user-authored command of the same name', async () => {
    await fs.mkdir(path.join(tmp, '.claude', 'commands'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.claude', 'commands', 'deploy.md'), 'USER OWN deploy\n');
    await deliverCommands({
      mode: 'copy',
      ctx: { projectId: 'p', projectPath: tmp, provider: 'claude-code' },
    });
    const kept = await fs.readFile(path.join(tmp, '.claude', 'commands', 'deploy.md'), 'utf-8');
    expect(kept).toContain('USER OWN deploy'); // untouched — no provenance marker
  });
});
