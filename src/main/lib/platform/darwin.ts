/**
 * macOS Platform Provider
 */

import * as path from 'node:path';
import { BasePlatformProvider } from './base';
import { cachedNvmBinDirs } from './nvm';
import type { EnvironmentConfig, PathConfig, ShellConfig } from './types';

const USER_SHELL_REGEX = /UserShell:\s*(.+)/;

export class DarwinPlatformProvider extends BasePlatformProvider {
  readonly platform = 'darwin' as const;
  readonly displayName = 'macOS';

  getShellConfig(): ShellConfig {
    const shell = process.env.SHELL || '/bin/zsh';

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
        // Homebrew (Apple Silicon)
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        // Homebrew (Intel)
        '/usr/local/bin',
        '/usr/local/sbin',
        // System
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        // MacPorts
        '/opt/local/bin',
        '/opt/local/sbin',
      ],
      localBin: path.join(home, '.local', 'bin'),
      packageManagerPaths: [
        path.join(home, '.bun', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, '.deno', 'bin'),
        // NVM managed Node.js
        ...cachedNvmBinDirs(home),
      ],
    };
  }

  getEnvironmentConfig(): EnvironmentConfig {
    return {
      homeVar: 'HOME',
      userVar: 'USER',
      additionalVars: {
        TMPDIR: process.env.TMPDIR || '/tmp',
        __CF_USER_TEXT_ENCODING: process.env.__CF_USER_TEXT_ENCODING || '',
      },
    };
  }

  override getDefaultShell(): string {
    return process.env.SHELL || '/bin/zsh';
  }

  override detectShell(options?: { timeoutMs?: number }): Promise<string> {
    // Directory Services lookup for the login shell (macOS has no getent).
    return this.detectShellViaCommand(
      () => ['-c', `dscl . -read /Users/$(whoami) UserShell 2>/dev/null`],
      USER_SHELL_REGEX,
      options,
    );
  }

  // detectLocale is inherited from BasePlatformProvider (shared Unix `locale` detection).
}
