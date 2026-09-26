import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalPayloadDir,
  claudeProjectionDir,
  codexProjectionDir,
  marketplaceCatalogDir,
  pluginTierDirs,
  vendorPluginsRoot,
} from './layout';

describe('vendor-plugin layout (sc-2805)', () => {
  const home = path.join(os.tmpdir(), 'frink-layout-home');
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('FRINK_HOME', home);
  });
  afterEach(() => vi.restoreAllMocks());

  const slack = { name: 'slack', version: '1.2.0' };
  const root = path.join(home, '.frink', 'plugins');

  it('keys every tier by name and version — the marketplace is not a path segment', () => {
    expect(vendorPluginsRoot()).toBe(root);
    expect(canonicalPayloadDir(slack)).toBe(path.join(root, 'vendor', 'slack', '1.2.0'));
    expect(claudeProjectionDir(slack)).toBe(
      path.join(root, 'projections', 'claude-code', 'slack', '1.2.0'),
    );
    expect(codexProjectionDir(slack)).toBe(
      path.join(root, 'projections', 'codex', 'slack', '1.2.0'),
    );
    for (const dir of [
      canonicalPayloadDir(slack),
      claudeProjectionDir(slack),
      codexProjectionDir(slack),
    ]) {
      expect(dir).not.toContain('claude-plugins-official');
    }
  });

  it('sweeps all versions of a plugin across the three tiers', () => {
    expect(pluginTierDirs('slack')).toEqual([
      path.join(root, 'vendor', 'slack'),
      path.join(root, 'projections', 'claude-code', 'slack'),
      path.join(root, 'projections', 'codex', 'slack'),
    ]);
  });

  it("keeps the marketplace in claude-code's catalog mirror, which the CLI resolves through", () => {
    expect(marketplaceCatalogDir('claude-plugins-official')).toBe(
      path.join(root, 'marketplaces', 'claude-code', 'claude-plugins-official'),
    );
  });

  it("roots the whole tree under an isolated instance's own home (sc-2903)", () => {
    vi.stubEnv('FRINK_HOME', '/rig/home');
    const rigRoot = path.join('/rig/home', '.frink', 'plugins');
    expect(vendorPluginsRoot()).toBe(rigRoot);
    expect(canonicalPayloadDir(slack).startsWith(rigRoot)).toBe(true);
    for (const dir of pluginTierDirs('slack')) expect(dir.startsWith(rigRoot)).toBe(true);
    vi.unstubAllEnvs();
  });
});
