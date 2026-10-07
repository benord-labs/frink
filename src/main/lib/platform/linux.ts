/**
 * Linux Platform Provider
 */

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import log from 'electron-log';
import { BasePlatformProvider } from './base';
import { cachedNvmBinDirs } from './nvm';
import type { CliConfig, EnvironmentConfig, PathConfig, ShellConfig } from './types';

const execFileAsync = promisify(execFile);

// getent passwd format: user:x:uid:gid:name:home:shell — match shell (last field)
const GETENT_SHELL_REGEX = /:([^:]+)$/;

export class LinuxPlatformProvider extends BasePlatformProvider {
  readonly platform = 'linux' as const;
  readonly displayName = 'Linux';

  getShellConfig(): ShellConfig {
    const shell = process.env.SHELL || '/bin/bash';

    return {
      executable: shell,
      loginArgs: ['-l'],
      execArgs: (command: string) => ['-c', command],
    };
  }

  getPathConfig(): PathConfig {
    const home = this.getHome();

    return {
      separator: ':',
      commonPaths: [
        // System paths
        '/usr/local/bin',
        '/usr/local/sbin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        // Snap packages
        '/snap/bin',
        // Flatpak exports
        '/var/lib/flatpak/exports/bin',
        path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin'),
      ],
      localBin: path.join(home, '.local', 'bin'),
      packageManagerPaths: [
        path.join(home, '.bun', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, '.deno', 'bin'),
        // NVM managed Node.js
        ...cachedNvmBinDirs(home),
        // ASDF version manager
        path.join(home, '.asdf', 'shims'),
        // Linuxbrew
        path.join(home, '.linuxbrew', 'bin'),
        '/home/linuxbrew/.linuxbrew/bin',
      ],
    };
  }

  getCliConfig(): CliConfig {
    return {
      installPath: '/usr/local/bin/frink',
      scriptName: 'frink',
      requiresAdmin: true, // Usually needs sudo, but we try without first
    };
  }

  getEnvironmentConfig(): EnvironmentConfig {
    const home = this.getHome();

    return {
      homeVar: 'HOME',
      userVar: 'USER',
      additionalVars: {
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(home, '.cache'),
        XDG_STATE_HOME: process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'),
      },
    };
  }

  override getDefaultShell(): string {
    return process.env.SHELL || '/bin/bash';
  }

  override detectShell(options?: { timeoutMs?: number }): Promise<string> {
    // /etc/passwd lookup via getent, keyed by the current uid.
    return this.detectShellViaCommand(
      () => {
        const uid = process.getuid?.();
        return uid === undefined ? null : ['-c', `getent passwd ${uid} 2>/dev/null`];
      },
      GETENT_SHELL_REGEX,
      options,
    );
  }

  // detectLocale is inherited from BasePlatformProvider (shared Unix `locale` detection).

  async installCli(sourcePath: string): Promise<{ success: boolean; error?: string }> {
    const cliConfig = this.getCliConfig();
    const installPath = cliConfig.installPath;

    if (!existsSync(sourcePath)) {
      return { success: false, error: 'CLI script not found in app bundle' };
    }

    try {
      // Remove existing if present (argv avoids command injection)
      if (existsSync(installPath)) {
        try {
          await execFileAsync('rm', ['-f', installPath]);
        } catch {
          await execFileAsync('sudo', ['rm', '-f', installPath]);
        }
      }

      // Create symlink - try without sudo first (argv avoids command injection)
      try {
        await execFileAsync('ln', ['-s', sourcePath, installPath]);
      } catch {
        await execFileAsync('sudo', ['ln', '-s', sourcePath, installPath]);
      }

      log.info('[CLI] Installed frink command to', installPath);
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Installation failed';
      log.error('[CLI] Failed to install:', error);
      return { success: false, error: errorMessage };
    }
  }

  async uninstallCli(): Promise<{ success: boolean; error?: string }> {
    const cliConfig = this.getCliConfig();
    const installPath = cliConfig.installPath;

    try {
      if (!existsSync(installPath)) {
        log.info('[CLI] CLI command not installed, nothing to uninstall');
        return { success: true };
      }

      // Try without sudo first (argv avoids command injection)
      try {
        await execFileAsync('rm', ['-f', installPath]);
      } catch {
        await execFileAsync('sudo', ['rm', '-f', installPath]);
      }

      log.info('[CLI] Uninstalled frink command');
      return { success: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Uninstallation failed';
      log.error('[CLI] Failed to uninstall:', error);
      return { success: false, error: errorMessage };
    }
  }

  isCliInstalled(sourcePath: string): boolean {
    const cliConfig = this.getCliConfig();
    try {
      if (!existsSync(cliConfig.installPath)) return false;
      const stat = lstatSync(cliConfig.installPath);
      if (!stat.isSymbolicLink()) return false;
      const target = readlinkSync(cliConfig.installPath);
      return target === sourcePath;
    } catch {
      return false;
    }
  }
}
