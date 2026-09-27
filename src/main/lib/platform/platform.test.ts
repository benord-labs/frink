import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const MOCK_HOME = '/mock/home';
const MOCK_USER = 'testuser';

const { homedirMock, userInfoMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  userInfoMock: vi.fn<() => import('node:os').UserInfo<string>>(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: homedirMock,
    userInfo: userInfoMock,
  };
});

// These imports must come after vi.mock calls
import { DarwinPlatformProvider } from './darwin';
import { getPlatformProvider } from './index';
import { LinuxPlatformProvider } from './linux';
import { WindowsPlatformProvider } from './windows';

describe('platform providers', () => {
  beforeEach(() => {
    homedirMock.mockReturnValue(MOCK_HOME);
    userInfoMock.mockReturnValue({
      username: MOCK_USER,
      uid: 1000,
      gid: 1000,
      shell: '/bin/zsh',
      homedir: MOCK_HOME,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Automatically restores any env vars stubbed via vi.stubEnv() in this suite
    vi.unstubAllEnvs();
  });

  describe('getPlatformProvider', () => {
    // Note: getPlatformProvider caches instances at module level. Tests here use the
    // cached singletons; all other tests instantiate providers directly via `new` to
    // avoid stale-singleton issues.
    it('returns DarwinPlatformProvider for darwin', () => {
      const provider = getPlatformProvider('darwin');
      expect(provider).toBeInstanceOf(DarwinPlatformProvider);
      expect(provider.platform).toBe('darwin');
    });

    it('returns LinuxPlatformProvider for linux', () => {
      const provider = getPlatformProvider('linux');
      expect(provider).toBeInstanceOf(LinuxPlatformProvider);
      expect(provider.platform).toBe('linux');
    });

    it('returns WindowsPlatformProvider for win32', () => {
      const provider = getPlatformProvider('win32');
      expect(provider).toBeInstanceOf(WindowsPlatformProvider);
      expect(provider.platform).toBe('win32');
    });

    it('returns cached instance on subsequent calls', () => {
      const a = getPlatformProvider('darwin');
      const b = getPlatformProvider('darwin');
      expect(a).toBe(b);
    });

    it('throws for unsupported platform', () => {
      expect(() => getPlatformProvider('freebsd' as never)).toThrow(
        'Unsupported platform: freebsd',
      );
    });
  });

  describe('DarwinPlatformProvider', () => {
    let provider: DarwinPlatformProvider;

    beforeEach(() => {
      provider = new DarwinPlatformProvider();
    });

    it('has correct platform identifier and display name', () => {
      expect(provider.platform).toBe('darwin');
      expect(provider.displayName).toBe('macOS');
    });

    describe('getCliConfig', () => {
      it('returns correct install path', () => {
        expect(provider.getCliConfig().installPath).toBe('/usr/local/bin/frink');
      });

      it('uses "frink" as script name', () => {
        expect(provider.getCliConfig().scriptName).toBe('frink');
      });

      it('requires admin privileges', () => {
        expect(provider.getCliConfig().requiresAdmin).toBe(true);
      });
    });

    describe('getShellConfig', () => {
      it('uses SHELL env var when set', () => {
        vi.stubEnv('SHELL', '/bin/bash');
        expect(provider.getShellConfig().executable).toBe('/bin/bash');
      });

      it('falls back to /bin/zsh when SHELL is not set', () => {
        vi.stubEnv('SHELL', undefined);
        expect(provider.getShellConfig().executable).toBe('/bin/zsh');
      });

      it('returns login args [-l]', () => {
        expect(provider.getShellConfig().loginArgs).toEqual(['-l']);
      });

      it('builds exec args with -c prefix', () => {
        expect(provider.getShellConfig().execArgs('echo hi')).toEqual(['-c', 'echo hi']);
      });
    });

    describe('getPathConfig', () => {
      it('uses colon separator', () => {
        expect(provider.getPathConfig().separator).toBe(':');
      });

      it('includes Homebrew Apple Silicon path', () => {
        expect(provider.getPathConfig().commonPaths).toContain('/opt/homebrew/bin');
      });

      it('includes Homebrew Intel path', () => {
        expect(provider.getPathConfig().commonPaths).toContain('/usr/local/bin');
      });

      it('sets localBin under home directory', () => {
        expect(provider.getPathConfig().localBin).toBe(path.join(MOCK_HOME, '.local', 'bin'));
      });

      it('includes bun and cargo in package manager paths', () => {
        const pm = provider.getPathConfig().packageManagerPaths;
        expect(pm).toContain(path.join(MOCK_HOME, '.bun', 'bin'));
        expect(pm).toContain(path.join(MOCK_HOME, '.cargo', 'bin'));
      });
    });

    describe('getEnvironmentConfig', () => {
      it('uses HOME as home variable', () => {
        expect(provider.getEnvironmentConfig().homeVar).toBe('HOME');
      });

      it('uses USER as user variable', () => {
        expect(provider.getEnvironmentConfig().userVar).toBe('USER');
      });

      it('includes TMPDIR var', () => {
        vi.stubEnv('TMPDIR', '/var/folders/tmp');
        const vars = provider.getEnvironmentConfig().additionalVars;
        expect(vars.TMPDIR).toBe('/var/folders/tmp');
      });

      it('falls back to /tmp for TMPDIR when env var is unset', () => {
        vi.stubEnv('TMPDIR', undefined);
        const vars = provider.getEnvironmentConfig().additionalVars;
        expect(vars.TMPDIR).toBe('/tmp');
      });
    });

    describe('getDefaultShell', () => {
      it('returns SHELL env var when set', () => {
        vi.stubEnv('SHELL', '/usr/bin/fish');
        expect(provider.getDefaultShell()).toBe('/usr/bin/fish');
      });

      it('falls back to /bin/zsh', () => {
        vi.stubEnv('SHELL', undefined);
        expect(provider.getDefaultShell()).toBe('/bin/zsh');
      });
    });

    describe('detectShell', () => {
      it('returns SHELL env var immediately when set', async () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        expect(await provider.detectShell()).toBe('/bin/zsh');
      });

      it('returns dscl result when SHELL is unset and dscl succeeds', async () => {
        vi.stubEnv('SHELL', undefined);
        vi.spyOn(provider, 'execCommand').mockResolvedValue({
          stdout: 'UserShell: /usr/bin/fish\n',
          stderr: '',
        });
        expect(await provider.detectShell()).toBe('/usr/bin/fish');
      });

      it('falls back to /bin/zsh when SHELL is unset and command fails', async () => {
        vi.stubEnv('SHELL', undefined);
        vi.spyOn(provider, 'execCommand').mockRejectedValue(new Error('not found'));
        expect(await provider.detectShell()).toBe('/bin/zsh');
      });

      it('forwards the caller timeout to the detection subprocess', async () => {
        vi.stubEnv('SHELL', undefined);
        const exec = vi
          .spyOn(provider, 'execCommand')
          .mockResolvedValue({ stdout: '', stderr: '' });
        await provider.detectShell({ timeoutMs: 1000 });
        expect(exec).toHaveBeenCalledWith(expect.anything(), expect.anything(), { timeout: 1000 });
      });

      it('leaves the provider default timeout intact when no caller timeout is given', async () => {
        vi.stubEnv('SHELL', undefined);
        const exec = vi
          .spyOn(provider, 'execCommand')
          .mockResolvedValue({ stdout: '', stderr: '' });
        await provider.detectShell();
        // No forced timeout — execCommand applies its own default (5000ms). Guards non-terminal
        // callers against a silent 1000->5000 (or reverse) drift.
        expect(exec).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
          timeout: undefined,
        });
      });
    });

    describe('detectLocale', () => {
      it('returns LANG env var when it contains UTF-8', async () => {
        vi.stubEnv('LANG', 'fr_FR.UTF-8');
        expect(await provider.detectLocale()).toBe('fr_FR.UTF-8');
      });

      it('returns LC_ALL when it contains UTF-8 and LANG does not', async () => {
        vi.stubEnv('LANG', undefined);
        vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
        expect(await provider.detectLocale()).toBe('de_DE.UTF-8');
      });

      it('returns locale command result when env vars unset and command succeeds', async () => {
        vi.stubEnv('LANG', undefined);
        vi.stubEnv('LC_ALL', undefined);
        vi.spyOn(provider, 'execCommand').mockResolvedValue({
          stdout: 'en_GB.UTF-8\n',
          stderr: '',
        });
        expect(await provider.detectLocale()).toBe('en_GB.UTF-8');
      });

      it('falls back to en_US.UTF-8 when env vars unset and command fails', async () => {
        vi.stubEnv('LANG', undefined);
        vi.stubEnv('LC_ALL', undefined);
        vi.spyOn(provider, 'execCommand').mockRejectedValue(new Error('not found'));
        expect(await provider.detectLocale()).toBe('en_US.UTF-8');
      });
    });
  });

  describe('LinuxPlatformProvider', () => {
    let provider: LinuxPlatformProvider;

    beforeEach(() => {
      provider = new LinuxPlatformProvider();
    });

    it('has correct platform identifier and display name', () => {
      expect(provider.platform).toBe('linux');
      expect(provider.displayName).toBe('Linux');
    });

    describe('getCliConfig', () => {
      it('installs to /usr/local/bin/frink', () => {
        expect(provider.getCliConfig().installPath).toBe('/usr/local/bin/frink');
      });

      it('requires admin privileges', () => {
        expect(provider.getCliConfig().requiresAdmin).toBe(true);
      });
    });

    describe('getShellConfig', () => {
      it('uses SHELL env var when set', () => {
        vi.stubEnv('SHELL', '/bin/zsh');
        expect(provider.getShellConfig().executable).toBe('/bin/zsh');
      });

      it('falls back to /bin/bash', () => {
        vi.stubEnv('SHELL', undefined);
        expect(provider.getShellConfig().executable).toBe('/bin/bash');
      });
    });

    describe('getPathConfig', () => {
      it('uses colon separator', () => {
        expect(provider.getPathConfig().separator).toBe(':');
      });

      it('includes snap bin path', () => {
        expect(provider.getPathConfig().commonPaths).toContain('/snap/bin');
      });

      it('includes ASDF shims in package manager paths', () => {
        expect(provider.getPathConfig().packageManagerPaths).toContain(
          path.join(MOCK_HOME, '.asdf', 'shims'),
        );
      });

      it('includes Linuxbrew path', () => {
        expect(provider.getPathConfig().packageManagerPaths).toContain(
          '/home/linuxbrew/.linuxbrew/bin',
        );
      });
    });

    describe('getEnvironmentConfig', () => {
      it('sets XDG vars under home', () => {
        // CI runners (e.g. GitHub's ubuntu images) export XDG_CONFIG_HOME
        vi.stubEnv('XDG_CONFIG_HOME', undefined);
        vi.stubEnv('XDG_DATA_HOME', undefined);
        vi.stubEnv('XDG_CACHE_HOME', undefined);
        const config = provider.getEnvironmentConfig();
        expect(config.additionalVars.XDG_CONFIG_HOME).toContain(MOCK_HOME);
        expect(config.additionalVars.XDG_DATA_HOME).toContain(MOCK_HOME);
        expect(config.additionalVars.XDG_CACHE_HOME).toContain(MOCK_HOME);
      });

      it('respects existing XDG env vars', () => {
        vi.stubEnv('XDG_CONFIG_HOME', '/custom/config');
        const config = provider.getEnvironmentConfig();
        expect(config.additionalVars.XDG_CONFIG_HOME).toBe('/custom/config');
      });
    });

    describe('detectShell', () => {
      it('returns SHELL env var immediately when set', async () => {
        vi.stubEnv('SHELL', '/usr/bin/zsh');
        expect(await provider.detectShell()).toBe('/usr/bin/zsh');
      });

      it('returns getent result when SHELL is unset and getent succeeds', async () => {
        vi.stubEnv('SHELL', undefined);
        vi.spyOn(provider, 'execCommand').mockResolvedValue({
          stdout: 'testuser:x:1000:1000::/home/testuser:/usr/bin/zsh\n',
          stderr: '',
        });
        expect(await provider.detectShell()).toBe('/usr/bin/zsh');
      });

      it('falls back to /bin/bash when SHELL is unset and command fails', async () => {
        vi.stubEnv('SHELL', undefined);
        vi.spyOn(provider, 'execCommand').mockRejectedValue(new Error('not found'));
        expect(await provider.detectShell()).toBe('/bin/bash');
      });
    });

    describe('detectLocale', () => {
      it('returns LANG env var when it contains UTF-8', async () => {
        vi.stubEnv('LANG', 'ja_JP.UTF-8');
        expect(await provider.detectLocale()).toBe('ja_JP.UTF-8');
      });

      it('returns LC_ALL when it contains UTF-8 and LANG does not', async () => {
        vi.stubEnv('LANG', undefined);
        vi.stubEnv('LC_ALL', 'es_ES.UTF-8');
        expect(await provider.detectLocale()).toBe('es_ES.UTF-8');
      });

      it('returns locale command result when env vars unset and command succeeds', async () => {
        vi.stubEnv('LANG', undefined);
        vi.stubEnv('LC_ALL', undefined);
        vi.spyOn(provider, 'execCommand').mockResolvedValue({
          stdout: 'en_AU.UTF-8\n',
          stderr: '',
        });
        expect(await provider.detectLocale()).toBe('en_AU.UTF-8');
      });

      it('falls back to en_US.UTF-8 when env vars unset and command fails', async () => {
        vi.stubEnv('LANG', undefined);
        vi.stubEnv('LC_ALL', undefined);
        vi.spyOn(provider, 'execCommand').mockRejectedValue(new Error('not found'));
        expect(await provider.detectLocale()).toBe('en_US.UTF-8');
      });
    });
  });

  describe('WindowsPlatformProvider', () => {
    let provider: WindowsPlatformProvider;

    beforeEach(() => {
      provider = new WindowsPlatformProvider();
    });

    it('has correct platform identifier and display name', () => {
      expect(provider.platform).toBe('win32');
      expect(provider.displayName).toBe('Windows');
    });

    describe('getCliConfig', () => {
      it('installs to user local bin (no admin required)', () => {
        const config = provider.getCliConfig();
        expect(config.requiresAdmin).toBe(false);
        expect(config.installPath).toContain(MOCK_HOME);
        expect(config.installPath).toContain('frink.cmd');
      });

      it('uses frink.cmd as script name', () => {
        expect(provider.getCliConfig().scriptName).toBe('frink.cmd');
      });
    });

    describe('getShellConfig', () => {
      it('uses COMSPEC env var when set', () => {
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        expect(provider.getShellConfig().executable).toBe('C:\\Windows\\System32\\cmd.exe');
      });

      it('uses /c as exec arg prefix', () => {
        expect(provider.getShellConfig().execArgs('dir')).toEqual(['/c', 'dir']);
      });

      it('has empty login args (no login shell concept on Windows)', () => {
        expect(provider.getShellConfig().loginArgs).toEqual([]);
      });
    });

    describe('getPathConfig', () => {
      it('uses semicolon separator', () => {
        expect(provider.getPathConfig().separator).toBe(';');
      });

      it('includes Git for Windows paths', () => {
        const paths = provider.getPathConfig().commonPaths;
        expect(paths).toContain('C:\\Program Files\\Git\\cmd');
      });

      it('includes npm AppData path in package managers', () => {
        const pm = provider.getPathConfig().packageManagerPaths;
        expect(pm).toContain(path.join(MOCK_HOME, 'AppData', 'Roaming', 'npm'));
      });

      it('includes scoop shims in package managers', () => {
        const pm = provider.getPathConfig().packageManagerPaths;
        expect(pm).toContain(path.join(MOCK_HOME, 'scoop', 'shims'));
      });
    });

    describe('getEnvironmentConfig', () => {
      it('uses USERPROFILE as home variable', () => {
        expect(provider.getEnvironmentConfig().homeVar).toBe('USERPROFILE');
      });

      it('uses USERNAME as user variable', () => {
        expect(provider.getEnvironmentConfig().userVar).toBe('USERNAME');
      });

      it('includes APPDATA and LOCALAPPDATA vars', () => {
        const vars = provider.getEnvironmentConfig().additionalVars;
        expect(vars.APPDATA).toContain(MOCK_HOME);
        expect(vars.LOCALAPPDATA).toContain(MOCK_HOME);
      });
    });

    describe('getDefaultShell', () => {
      it('returns COMSPEC env var when set', () => {
        vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
        expect(provider.getDefaultShell()).toBe('C:\\Windows\\System32\\cmd.exe');
      });

      it('falls back to PowerShell path when COMSPEC is unset', () => {
        vi.stubEnv('COMSPEC', undefined);
        expect(provider.getDefaultShell()).toContain('powershell.exe');
      });
    });

    describe('detectLocale', () => {
      it('returns LANG env var when set', async () => {
        vi.stubEnv('LANG', 'en_GB.UTF-8');
        expect(await provider.detectLocale()).toBe('en_GB.UTF-8');
      });

      it('falls back to en_US.UTF-8 when LANG is unset', async () => {
        vi.stubEnv('LANG', undefined);
        expect(await provider.detectLocale()).toBe('en_US.UTF-8');
      });
    });
  });

  describe('buildExtendedPath (BasePlatformProvider)', () => {
    it('prepends new paths before existing ones on darwin', () => {
      const provider = new DarwinPlatformProvider();
      const result = provider.buildExtendedPath('/existing/path');
      expect(result).toMatch(/^\/opt\/homebrew\/bin/);
      expect(result).toContain('/existing/path');
    });

    it('deduplicates paths on darwin', () => {
      const provider = new DarwinPlatformProvider();
      const existingPath = '/opt/homebrew/bin:/usr/local/bin';
      const result = provider.buildExtendedPath(existingPath);
      const parts = result.split(':');
      const count = parts.filter((p) => p === '/opt/homebrew/bin').length;
      expect(count).toBe(1);
    });

    it('uses semicolon separator on windows', () => {
      const provider = new WindowsPlatformProvider();
      const result = provider.buildExtendedPath();
      expect(result).toContain(';');
      expect(result).not.toMatch(/^[^;]+:[^;]+$/); // no colon-separated paths
    });

    it('performs case-insensitive dedup on windows', () => {
      const provider = new WindowsPlatformProvider();
      const config = provider.getPathConfig();
      const existingUpper = config.commonPaths[0].toUpperCase();
      const result = provider.buildExtendedPath(existingUpper);
      const parts = result.split(';');
      const normalized = parts.map((p) => p.toLowerCase());
      const target = config.commonPaths[0].toLowerCase();
      const count = normalized.filter((p) => p === target).length;
      expect(count).toBe(1);
    });

    it('returns all platform paths when no existing path is provided', () => {
      const provider = new LinuxPlatformProvider();
      const result = provider.buildExtendedPath(undefined);
      expect(result).toContain('/snap/bin');
      expect(result).toContain(path.join(MOCK_HOME, '.cargo', 'bin'));
    });

    // NVM wildcard paths (e.g. ~/.nvm/versions/node/*/bin) are literal strings —
    // shells do not expand globs in PATH. These entries are unreachable and should
    // not be included in the extended PATH. `it.fails` = expected red until fixed.
    it.fails('does not add unresolvable wildcard paths to the extended PATH on darwin', () => {
      const provider = new DarwinPlatformProvider();
      const result = provider.buildExtendedPath(undefined);
      expect(result).not.toContain('*');
    });

    it.fails('does not add unresolvable wildcard paths to the extended PATH on linux', () => {
      const provider = new LinuxPlatformProvider();
      const result = provider.buildExtendedPath(undefined);
      expect(result).not.toContain('*');
    });

    it('does not deduplicate wildcard NVM path against a resolved NVM version path', () => {
      // Documents the knock-on effect of the bug: a user whose $PATH already contains
      // a real NVM path like ~/.nvm/versions/node/v20.0.0/bin ends up with both the
      // wildcard and the resolved path in their extended PATH.
      const provider = new DarwinPlatformProvider();
      const resolvedNvmBin = path.join(MOCK_HOME, '.nvm', 'versions', 'node', 'v20.0.0', 'bin');
      const result = provider.buildExtendedPath(resolvedNvmBin);
      const parts = result.split(':');
      const wildcardPath = path.join(MOCK_HOME, '.nvm', 'versions', 'node', '*', 'bin');
      expect(parts).toContain(wildcardPath);
      expect(parts).toContain(resolvedNvmBin);
    });
  });

  describe('buildEnvironment (BasePlatformProvider)', () => {
    it('sets HOME on darwin', () => {
      const provider = new DarwinPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.HOME).toBe(MOCK_HOME);
    });

    it('sets USER on darwin', () => {
      const provider = new DarwinPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.USER).toBe(MOCK_USER);
    });

    it('sets TERM when not already present', () => {
      const provider = new DarwinPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.TERM).toBe('xterm-256color');
    });

    it('does not overwrite existing TERM value', () => {
      const provider = new DarwinPlatformProvider();
      const env = provider.buildEnvironment({ TERM: 'vt100' });
      expect(env.TERM).toBe('vt100');
    });

    it('sets SHELL when not already present', () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const provider = new DarwinPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.SHELL).toBe('/bin/zsh');
    });

    it('does not overwrite existing SHELL value', () => {
      vi.stubEnv('SHELL', '/bin/zsh');
      const provider = new DarwinPlatformProvider();
      const env = provider.buildEnvironment({ SHELL: '/usr/bin/fish' });
      expect(env.SHELL).toBe('/usr/bin/fish');
    });

    it('builds PATH from buildExtendedPath', () => {
      const provider = new DarwinPlatformProvider();
      const spy = vi.spyOn(provider, 'buildExtendedPath').mockReturnValue('/mocked/path');
      const env = provider.buildEnvironment({});
      expect(env.PATH).toBe('/mocked/path');
      spy.mockRestore();
    });

    it('uses USERPROFILE on windows', () => {
      const provider = new WindowsPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.USERPROFILE).toBe(MOCK_HOME);
    });

    it('also sets HOME on windows (required by Git and Node)', () => {
      const provider = new WindowsPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.HOME).toBe(MOCK_HOME);
    });

    it('uses USERNAME on windows', () => {
      const provider = new WindowsPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.USERNAME).toBe(MOCK_USER);
    });

    it('sets XDG vars on linux', () => {
      vi.stubEnv('XDG_CONFIG_HOME', undefined);
      const provider = new LinuxPlatformProvider();
      const env = provider.buildEnvironment({});
      expect(env.XDG_CONFIG_HOME).toContain(MOCK_HOME);
    });

    it('does not overwrite additionalVars already in baseEnv', () => {
      vi.stubEnv('XDG_CONFIG_HOME', undefined);
      const provider = new LinuxPlatformProvider();
      const env = provider.buildEnvironment({ XDG_CONFIG_HOME: '/custom/xdg' });
      expect(env.XDG_CONFIG_HOME).toBe('/custom/xdg');
    });

    it('resolves HOME path placeholder in additional vars on Windows', () => {
      const provider = new WindowsPlatformProvider();
      const env = provider.buildEnvironment({});
      // Windows APPDATA uses home path without placeholder
      expect(env.APPDATA).toBe(path.join(MOCK_HOME, 'AppData', 'Roaming'));
    });
  });
});
