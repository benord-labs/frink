import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installVendorPlugin, listStagedVendorPlugins } from './index';

/** A minimal package + marketplace pair on disk; contents are irrelevant to the guard under test. */
function writeFixture(tmpRoot: string) {
  const sourceDir = path.join(tmpRoot, 'src');
  fs.mkdirSync(path.join(sourceDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'slack', version: '1.2.0' }),
  );
  const marketplaceDir = path.join(tmpRoot, 'mkt');
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'x', plugins: [] }),
  );
  return { sourceDir, marketplaceDir };
}

describe('installVendorPlugin ownership guard (sc-2805)', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-install-guard-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
    vi.stubEnv('FRINK_HOME', tmpRoot);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const base = { version: '9.9.9', gitCommitSha: 'def5678', sourceRepo: 'other/repo' };

  it('refuses a name the pin table does not vet, before writing anything', () => {
    const { sourceDir, marketplaceDir } = writeFixture(tmpRoot);
    expect(() =>
      installVendorPlugin({
        sourceDir,
        marketplaceDir,
        plugin: { ...base, marketplace: 'claude-plugins-official', name: 'not-a-pin' },
      }),
    ).toThrow(/not the vetted pin for "not-a-pin"/);
    expect(fs.existsSync(path.join(tmpRoot, '.frink', 'plugins', 'vendor'))).toBe(false);
    expect(listStagedVendorPlugins()).toEqual([]);
  });

  it('refuses a vetted name arriving from a different marketplace', () => {
    const { sourceDir, marketplaceDir } = writeFixture(tmpRoot);
    expect(() =>
      installVendorPlugin({
        sourceDir,
        marketplaceDir,
        plugin: { ...base, marketplace: 'other-marketplace', name: 'slack' },
      }),
    ).toThrow(/slack@other-marketplace is not the vetted pin/);
    expect(fs.existsSync(path.join(tmpRoot, '.frink', 'plugins', 'vendor', 'slack'))).toBe(false);
  });
});
