import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcquireExec } from './index';
import { acquireVendorClaudePlugin } from './index';

// electron-log/env chain: env.ts imports electron transitively via app checks —
// getBundledClaudeBinaryPath only resolves a path, so stub the module boundary.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../env', () => ({
  getBundledClaudeBinaryPath: () => '/bin/claude-test',
}));

const pin = {
  marketplace: 'claude-plugins-official',
  name: 'slack',
  version: '1.2.0',
  gitCommitSha: 'abc1234',
  sourceRepo: 'anthropics/claude-plugins-official',
  payloadRepo: 'vendor/payload',
};

describe('acquireVendorClaudePlugin', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-acquire-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    vi.stubEnv('FRINK_HOME', tmpRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Exec fake that materialises what the real CLI would have produced. */
  function execProducing(sha: string | null): AcquireExec {
    return async (_file, args, options) => {
      if (args[1] === 'install') {
        const pluginsDir = options.env.CLAUDE_CODE_PLUGIN_CACHE_DIR!;
        const cache = path.join(pluginsDir, 'cache', pin.marketplace, pin.name, pin.version);
        const marketplace = path.join(
          pluginsDir,
          'marketplaces',
          pin.marketplace,
          '.claude-plugin',
        );
        fs.mkdirSync(cache, { recursive: true });
        fs.mkdirSync(marketplace, { recursive: true });
        fs.writeFileSync(path.join(marketplace, 'marketplace.json'), '{"plugins":[]}');
        if (sha !== null) {
          fs.writeFileSync(
            path.join(pluginsDir, 'installed_plugins.json'),
            JSON.stringify({
              version: 2,
              plugins: {
                [`${pin.name}@${pin.marketplace}`]: [{ gitCommitSha: sha }],
              },
            }),
          );
        }
      }
      return { stdout: '', stderr: '' };
    };
  }

  it('acquires, pin-verifies, and returns the payload paths', async () => {
    const result = await acquireVendorClaudePlugin(pin, execProducing('abc1234'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sourceDir)).toBe(true);
      expect(
        fs.existsSync(path.join(result.marketplaceDir, '.claude-plugin', 'marketplace.json')),
      ).toBe(true);
    }
  });

  it('fails closed and deletes the payload on a gitCommitSha mismatch', async () => {
    const result = await acquireVendorClaudePlugin(pin, execProducing('evil999'));
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('pin mismatch'),
    });
    const cache = path.join(
      tmpRoot,
      '.frink',
      'plugin-acquire',
      'plugins',
      'cache',
      pin.marketplace,
      pin.name,
      pin.version,
    );
    expect(fs.existsSync(cache)).toBe(false);
  });

  it('treats a missing install record as a mismatch, never staging blind', async () => {
    const result = await acquireVendorClaudePlugin(pin, execProducing(null));
    expect(result.ok).toBe(false);
  });

  it('reports a CLI failure without throwing', async () => {
    const failingExec: AcquireExec = async () => {
      throw new Error('network down');
    };
    const result = await acquireVendorClaudePlugin(pin, failingExec);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('network down'),
    });
  });
  it.each(['valid', 'wrong-revision', 'wrong-package'] as const)(
    'verifies a whole repository package independently of marketplace entries: %s',
    async (mode) => {
      const repositoryPin = { ...pin, acquisition: 'repository' as const };
      const commands: string[][] = [];
      const exec: AcquireExec = async (file, args) => {
        commands.push([file, ...args]);
        if (args.includes('rev-parse'))
          return { stdout: mode === 'wrong-revision' ? 'bad' : pin.gitCommitSha, stderr: '' };
        if (file === 'tar') {
          const payload = args[args.indexOf('-C') + 1];
          fs.mkdirSync(path.join(payload, '.claude-plugin'), { recursive: true });
          fs.mkdirSync(path.join(payload, 'skills', 'example'), { recursive: true });
          fs.writeFileSync(
            path.join(payload, 'skills', 'example', 'SKILL.md'),
            'Full package skill',
          );
          fs.writeFileSync(
            path.join(payload, '.claude-plugin', 'plugin.json'),
            JSON.stringify({
              name: mode === 'wrong-package' ? 'other' : pin.name,
              version: pin.version,
            }),
          );
          fs.writeFileSync(
            path.join(payload, '.claude-plugin', 'marketplace.json'),
            JSON.stringify({ plugins: [{ name: 'subset-only' }] }),
          );
        }
        return { stdout: '', stderr: '' };
      };
      const result = await acquireVendorClaudePlugin(repositoryPin, exec, tmpRoot);
      expect(result.ok).toBe(mode === 'valid');
      expect(commands.every(([file]) => file !== '/bin/claude-test')).toBe(true);
      expect(commands).toContainEqual([
        'git',
        expect.any(String),
        expect.any(String),
        'fetch',
        '--depth=1',
        'https://github.com/vendor/payload.git',
        pin.gitCommitSha,
      ]);
      if (result.ok) {
        expect(
          fs.readFileSync(path.join(result.sourceDir, 'skills', 'example', 'SKILL.md'), 'utf8'),
        ).toBe('Full package skill');
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(result.marketplaceDir, '.claude-plugin', 'marketplace.json'),
              'utf8',
            ),
          ).plugins,
        ).toEqual([expect.objectContaining({ name: pin.name })]);
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(result.sourceDir, '.claude-plugin', 'marketplace.json'),
              'utf8',
            ),
          ).plugins[0].name,
        ).toBe('subset-only');
      }
    },
  );
});
