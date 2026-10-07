/**
 * Linux Platform Provider
 */

import * as path from 'node:path';
import { BasePlatformProvider } from './base';
import { cachedNvmBinDirs } from './nvm';
import type { EnvironmentConfig, PathConfig, ShellConfig } from './types';

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
}
