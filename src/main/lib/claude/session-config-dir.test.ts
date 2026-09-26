import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetConfigDirStagingForTests,
  installVendorPlugin,
  installVendorPluginFromLocalClaudeCache,
  listStagedVendorPluginCodexSkillRoots,
  removeVendorPlugin,
  restageVendorPlugin,
  stageClaudeConfigDir,
  stagedVendorPluginInventory,
  stageVendorPluginsIntoConfigDir,
  unstageVendorPlugin,
} from './session-config-dir';

// The CLI resolves User-tier memory as $CLAUDE_CONFIG_DIR/CLAUDE.md, so an isolated session dir
// loses the user's global instructions unless they are staged into it.
describe('stageClaudeConfigDir', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let configDir: string;
  let keySeq = 0;

  const uniqueKey = () => `stage-key-${keySeq++}`;

  beforeEach(() => {
    _resetConfigDirStagingForTests();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frink-stage-'));
    fakeHome = path.join(tmpRoot, 'home');
    configDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(path.join(fakeHome, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.stubEnv('FRINK_HOME', fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies user CLAUDE.md into the session config dir', () => {
    fs.writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# global rules');

    stageClaudeConfigDir(configDir, uniqueKey());

    expect(fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf-8')).toBe('# global rules');
  });

  it('stages skills and agents alongside memory', () => {
    fs.writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# global rules');

    stageClaudeConfigDir(configDir, uniqueKey());

    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, 'CLAUDE.md'))).toBe(true);
  });

  it('is a no-op for memory when the user has no CLAUDE.md', () => {
    expect(() => stageClaudeConfigDir(configDir, uniqueKey())).not.toThrow();
    expect(fs.existsSync(path.join(configDir, 'CLAUDE.md'))).toBe(false);
  });

  // Every turn spawns a fresh CLI process for the same chat, so memoising the copy would latch
  // the chat to whatever its first turn saw — an edit to ~/.claude/CLAUDE.md would never land.
  it('re-copies memory for an already-staged cacheKey when the source changed', () => {
    const key = uniqueKey();
    fs.writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# first');
    stageClaudeConfigDir(configDir, key);

    fs.writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# second');
    stageClaudeConfigDir(configDir, key);

    expect(fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf-8')).toBe('# second');
  });

  it('retries a cacheKey whose symlink staging failed rather than memoising the failure', () => {
    const key = uniqueKey();
    const symlink = vi.spyOn(fs, 'symlinkSync').mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    stageClaudeConfigDir(configDir, key);
    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(false);

    symlink.mockRestore();
    stageClaudeConfigDir(configDir, key);

    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(true);
  });

  it('stages memory even when the symlink work was already memoised', () => {
    const key = uniqueKey();
    stageClaudeConfigDir(configDir, key);
    expect(fs.existsSync(path.join(configDir, 'CLAUDE.md'))).toBe(false);

    fs.writeFileSync(path.join(fakeHome, '.claude', 'CLAUDE.md'), '# written later');
    stageClaudeConfigDir(configDir, key);

    expect(fs.readFileSync(path.join(configDir, 'CLAUDE.md'), 'utf-8')).toBe('# written later');
  });

  describe('vendor plugin staging', () => {
    const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));

    /** A vendor package carrying every hook surface the staging must strip. */
    function writeFixturePackage() {
      const sourceDir = path.join(tmpRoot, 'vendor-src');
      fs.mkdirSync(path.join(sourceDir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(sourceDir, 'skills', 'demo'), { recursive: true });
      fs.mkdirSync(path.join(sourceDir, 'hooks'), { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'notion',
          version: '0.1.0',
          hooks: { PreToolUse: [{}] },
        }),
      );
      fs.writeFileSync(path.join(sourceDir, 'skills', 'demo', 'SKILL.md'), '# demo');
      fs.writeFileSync(path.join(sourceDir, 'hooks', 'hooks.json'), '{"PreToolUse":[{}]}');
      fs.writeFileSync(path.join(sourceDir, '.mcp.json'), '{"mcpServers":{}}');
      fs.mkdirSync(path.join(sourceDir, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(sourceDir, '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'notion',
          version: '0.1.0',
          skills: './skills/',
          mcpServers: {},
          hooks: './hooks/hooks.json',
        }),
      );

      const marketplaceDir = path.join(tmpRoot, 'marketplace-src');
      fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'claude-plugins-official',
          plugins: [{ name: 'notion' }],
        }),
      );
      return { sourceDir, marketplaceDir };
    }

    function installFixture() {
      const { sourceDir, marketplaceDir } = writeFixturePackage();
      return installVendorPlugin({
        sourceDir,
        marketplaceDir,
        plugin: {
          marketplace: 'claude-plugins-official',
          name: 'notion',
          version: '0.1.0',
          gitCommitSha: 'abc1234',
          sourceRepo: 'anthropics/claude-plugins-official',
        },
      });
    }

    it('keeps the canonical payload verbatim and strips every hook surface from the claude projection', () => {
      installFixture();
      const root = path.join(fakeHome, '.frink', 'plugins');
      const packagePath = ['notion', '0.1.0'];
      const canonical = path.join(root, 'vendor', ...packagePath);
      const projection = path.join(root, 'projections', 'claude-code', ...packagePath);

      // Canonical = runtime-agnostic truth: hooks stay as inert data, so a
      // future codex projection derives from the same unmodified package.
      expect(fs.existsSync(path.join(canonical, 'hooks', 'hooks.json'))).toBe(true);
      expect('hooks' in readJson(path.join(canonical, '.claude-plugin', 'plugin.json'))).toBe(true);

      // The claude-code projection is what sessions load: no hook surface.
      expect(fs.existsSync(path.join(projection, 'skills', 'demo', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(projection, '.mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(projection, 'hooks'))).toBe(false);
      expect('hooks' in readJson(path.join(projection, '.claude-plugin', 'plugin.json'))).toBe(
        false,
      );
    });

    it('builds a hook-stripped codex projection from the same canonical payload [sc-1731]', () => {
      installFixture();
      const root = path.join(fakeHome, '.frink', 'plugins');
      const projection = path.join(root, 'projections', 'codex', 'notion', '0.1.0');

      expect(fs.existsSync(path.join(projection, 'skills', 'demo', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(projection, 'hooks'))).toBe(false);
      expect('hooks' in readJson(path.join(projection, '.codex-plugin', 'plugin.json'))).toBe(
        false,
      );
      expect('hooks' in readJson(path.join(projection, '.claude-plugin', 'plugin.json'))).toBe(
        false,
      );
    });

    it('resolves codex skill roots from the projection manifest, staged-state-aware [sc-1731]', () => {
      installFixture();
      const projection = path.join(
        fakeHome,
        '.frink',
        'plugins',
        'projections',
        'codex',
        'notion',
        '0.1.0',
      );
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([path.join(projection, 'skills')]);

      unstageVendorPlugin('notion@claude-plugins-official');
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([]);
    });

    it('skill roots follow only `./`-prefixed declared paths, like codex itself [sc-1731]', () => {
      installFixture();
      const manifestPath = path.join(
        fakeHome,
        '.frink',
        'plugins',
        'projections',
        'codex',
        'notion',
        '0.1.0',
        '.codex-plugin',
        'plugin.json',
      );
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({ name: 'notion', skills: ['skills', './missing/', './skills/'] }),
      );
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([
        path.join(path.dirname(path.dirname(manifestPath)), 'skills'),
      ]);

      fs.rmSync(manifestPath);
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([
        path.join(path.dirname(path.dirname(manifestPath)), 'skills'),
      ]);
    });

    it('delivers a Claude-only package through Codex extra roots from its hook-stripped projection', () => {
      installFixture();
      const projection = path.join(
        fakeHome,
        '.frink',
        'plugins',
        'projections',
        'codex',
        'notion',
        '0.1.0',
      );
      fs.rmSync(path.join(projection, '.codex-plugin'), { recursive: true });
      const skill = path.join(projection, 'skills', 'demo');
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([path.join(projection, 'skills')]);
      expect(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')).toBe('# demo');
      expect(fs.existsSync(path.join(projection, 'hooks'))).toBe(false);
      const manifest = path.join(projection, '.claude-plugin', 'plugin.json');
      fs.writeFileSync(manifest, JSON.stringify({ skills: ['./skills/demo'] }));
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([skill]);
      fs.writeFileSync(manifest, JSON.stringify({ skills: [] }));
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([]);
      fs.writeFileSync(manifest, JSON.stringify({ skills: ['../../../../'] }));
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([]);
      fs.writeFileSync(manifest, JSON.stringify({ skills: ['', '.'] }));
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([]);
      fs.writeFileSync(manifest, JSON.stringify({ skills: ['./skills'] }));
      const nativeDir = path.join(projection, '.codex-plugin');
      fs.mkdirSync(nativeDir);
      fs.symlinkSync(path.join(projection, 'missing.json'), path.join(nativeDir, 'plugin.json'));
      expect(listStagedVendorPluginCodexSkillRoots()).toEqual([]);
    });

    it('stages vendor plugins through stageClaudeConfigDir now the launch flag is on (sc-2068)', () => {
      installFixture();
      stageClaudeConfigDir(configDir, uniqueKey());
      const settings = readJson(path.join(configDir, 'settings.json'));
      expect(settings).toEqual({ enabledPlugins: { 'notion@claude-plugins-official': true } });
      expect(fs.existsSync(path.join(configDir, 'plugins', 'installed_plugins.json'))).toBe(true);
    });

    it('projects installed/marketplace metadata and an enabledPlugins-only settings.json', () => {
      installFixture();
      stageVendorPluginsIntoConfigDir(configDir);

      const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
      const entry = installed.plugins['notion@claude-plugins-official'][0];
      expect(installed.version).toBe(2);
      expect(entry).toMatchObject({
        scope: 'user',
        version: '0.1.0',
        gitCommitSha: 'abc1234',
      });
      expect(fs.existsSync(entry.installPath)).toBe(true);
      expect(entry.installPath).toContain(path.join('projections', 'claude-code'));

      const marketplaces = readJson(path.join(configDir, 'plugins', 'known_marketplaces.json'));
      expect(
        fs.existsSync(
          path.join(
            marketplaces['claude-plugins-official'].installLocation,
            '.claude-plugin',
            'marketplace.json',
          ),
        ),
      ).toBe(true);

      // ONLY enabledPlugins — a permissions or hooks key here would hand the
      // runner native policy (provider-config-canonical-home).
      expect(readJson(path.join(configDir, 'settings.json'))).toEqual({
        enabledPlugins: { 'notion@claude-plugins-official': true },
      });
    });

    it('writes nothing when no vendor plugins are staged', () => {
      stageVendorPluginsIntoConfigDir(configDir);
      expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'plugins'))).toBe(false);
    });

    it('inventories the staged payload skills and commands for capability disclosure', async () => {
      const { sourceDir, marketplaceDir } = writeFixturePackage();
      fs.mkdirSync(path.join(sourceDir, 'commands'), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'commands', 'standup.md'), '# standup');
      // The inventory vets the entry against the compiled-in pin, so this install carries the real sha.
      installVendorPlugin({
        sourceDir,
        marketplaceDir,
        plugin: {
          marketplace: 'claude-plugins-official',
          name: 'notion',
          version: '0.1.0',
          gitCommitSha: '9847f2aa1a15f25df35ed1fb7b4557dbb60cd651',
          sourceRepo: 'anthropics/claude-plugins-official',
        },
      });

      const inventory = await stagedVendorPluginInventory('notion@claude-plugins-official');
      expect(inventory?.skills.map((skill) => skill.name)).toEqual(['demo']);
      expect(inventory?.commands).toEqual(['standup']);
      expect(await stagedVendorPluginInventory('missing@claude-plugins-official')).toBeNull();
    });

    it('verifies the local claude cache sha against the pin (fail closed to acquisition)', () => {
      const cacheRoot = path.join(fakeHome, '.claude', 'plugins');
      const payload = path.join(cacheRoot, 'cache', 'claude-plugins-official', 'notion', '0.1.0');
      const marketplace = path.join(
        cacheRoot,
        'marketplaces',
        'claude-plugins-official',
        '.claude-plugin',
      );
      fs.mkdirSync(payload, { recursive: true });
      fs.mkdirSync(marketplace, { recursive: true });
      fs.writeFileSync(path.join(marketplace, 'marketplace.json'), '{"plugins":[]}');
      const pin = {
        marketplace: 'claude-plugins-official',
        name: 'notion',
        version: '0.1.0',
        gitCommitSha: 'abc1234',
        sourceRepo: 'anthropics/claude-plugins-official',
        payloadRepo: 'vendor/payload',
      };

      // No CLI install record → treated as a mismatch, never staged blind.
      expect(installVendorPluginFromLocalClaudeCache(pin)).toBe(false);

      // Mismatched sha → refused, so the caller falls through to acquisition.
      const installedRecord = (sha: string) =>
        JSON.stringify({
          version: 2,
          plugins: { 'notion@claude-plugins-official': [{ gitCommitSha: sha }] },
        });
      fs.writeFileSync(path.join(cacheRoot, 'installed_plugins.json'), installedRecord('evil999'));
      expect(installVendorPluginFromLocalClaudeCache(pin)).toBe(false);
      expect(fs.existsSync(path.join(fakeHome, '.frink', 'plugins', 'staged.json'))).toBe(false);

      // Matching sha → staged.
      fs.writeFileSync(path.join(cacheRoot, 'installed_plugins.json'), installedRecord('abc1234'));
      expect(installVendorPluginFromLocalClaudeCache(pin)).toBe(true);
    });

    it('unstage keeps both tiers on disk while staging stops delivering [sc-2068]', () => {
      installFixture();
      stageVendorPluginsIntoConfigDir(configDir);
      unstageVendorPlugin('notion@claude-plugins-official');
      stageVendorPluginsIntoConfigDir(configDir);

      expect(readJson(path.join(configDir, 'settings.json'))).toEqual({ enabledPlugins: {} });
      const root = path.join(fakeHome, '.frink', 'plugins');
      for (const dir of [
        path.join(root, 'vendor', 'notion', '0.1.0'),
        path.join(root, 'projections', 'claude-code', 'notion', '0.1.0'),
        path.join(root, 'projections', 'codex', 'notion', '0.1.0'),
      ]) {
        expect(fs.existsSync(dir)).toBe(true);
      }
    });

    it('restage re-inserts from on-disk tiers without re-copying [sc-2068]', () => {
      installFixture();
      unstageVendorPlugin('notion@claude-plugins-official');

      const pin = {
        marketplace: 'claude-plugins-official',
        name: 'notion',
        version: '0.1.0',
        gitCommitSha: 'abc1234',
        sourceRepo: 'anthropics/claude-plugins-official',
        payloadRepo: 'vendor/payload',
      };
      expect(restageVendorPlugin(pin)).toBe(true);
      stageVendorPluginsIntoConfigDir(configDir);
      expect(readJson(path.join(configDir, 'settings.json'))).toEqual({
        enabledPlugins: { 'notion@claude-plugins-official': true },
      });
    });

    it('restage refuses when the codex projection tier is missing [sc-1731]', () => {
      installFixture();
      unstageVendorPlugin('notion@claude-plugins-official');
      fs.rmSync(path.join(fakeHome, '.frink', 'plugins', 'projections', 'codex'), {
        recursive: true,
        force: true,
      });
      expect(
        restageVendorPlugin({
          marketplace: 'claude-plugins-official',
          name: 'notion',
          version: '0.1.0',
          gitCommitSha: 'abc1234',
          sourceRepo: 'anthropics/claude-plugins-official',
          payloadRepo: 'vendor/payload',
        }),
      ).toBe(false);
    });

    it('restage refuses when the pinned version is not on disk [sc-2068]', () => {
      installFixture();
      unstageVendorPlugin('notion@claude-plugins-official');
      expect(
        restageVendorPlugin({
          marketplace: 'claude-plugins-official',
          name: 'notion',
          version: '9.9.9',
          gitCommitSha: 'bumped99',
          sourceRepo: 'anthropics/claude-plugins-official',
          payloadRepo: 'vendor/payload',
        }),
      ).toBe(false);
    });

    it('removes a disabled package from every tier without staging it again', () => {
      installFixture();
      unstageVendorPlugin('notion@claude-plugins-official');
      removeVendorPlugin('notion@claude-plugins-official');
      const root = path.join(fakeHome, '.frink', 'plugins');
      for (const dir of [
        'vendor/notion',
        'projections/claude-code/notion',
        'projections/codex/notion',
      ]) {
        expect(fs.existsSync(path.join(root, dir))).toBe(false);
      }
    });

    it('retains the package identity when deleting its files fails so Remove can retry', () => {
      installFixture();
      const remove = vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
        throw new Error('Disk locked');
      });
      expect(() => removeVendorPlugin('notion@claude-plugins-official')).toThrow('Disk locked');
      remove.mockRestore();
      const root = path.join(fakeHome, '.frink', 'plugins');
      expect(JSON.stringify(readJson(path.join(root, 'staged.json')))).toContain(
        'notion@claude-plugins-official',
      );
      removeVendorPlugin('notion@claude-plugins-official');
      expect(fs.existsSync(path.join(root, 'vendor', 'notion'))).toBe(false);
      expect(JSON.stringify(readJson(path.join(root, 'staged.json')))).not.toContain(
        'notion@claude-plugins-official',
      );
    });

    it('disables a previously projected plugin after removal', () => {
      installFixture();
      stageVendorPluginsIntoConfigDir(configDir);
      removeVendorPlugin('notion@claude-plugins-official');
      stageVendorPluginsIntoConfigDir(configDir);

      expect(readJson(path.join(configDir, 'settings.json'))).toEqual({
        enabledPlugins: {},
      });
      const root = path.join(fakeHome, '.frink', 'plugins');
      for (const dir of [
        path.join(root, 'vendor', 'notion'),
        path.join(root, 'projections', 'claude-code', 'notion'),
        path.join(root, 'projections', 'codex', 'notion'),
      ]) {
        expect(fs.existsSync(dir)).toBe(false);
      }
    });
  });
});
