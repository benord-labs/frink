/**
 * Windows Platform Provider
 */

import * as path from 'node:path';
import { BasePlatformProvider } from './base';
import type { EnvironmentConfig, PathConfig, ShellConfig } from './types';

export class WindowsPlatformProvider extends BasePlatformProvider {
  readonly platform = 'win32' as const;
  readonly displayName = 'Windows';

  getShellConfig(): ShellConfig {
    const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const _cmdPath = process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';

    return {
      executable: process.env.COMSPEC || powershellPath,
      loginArgs: [], // Windows shells don't have login mode like Unix
      execArgs: (command: string) => ['/c', command],
    };
  }

  getPathConfig(): PathConfig {
    const home = this.getHome();
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';

    return {
      separator: ';',
      commonPaths: [
        // Git for Windows
        'C:\\Program Files\\Git\\cmd',
        'C:\\Program Files\\Git\\bin',
        'C:\\Program Files\\Git\\usr\\bin',
        // Node.js
        'C:\\Program Files\\nodejs',
        // System
        path.join(systemRoot, 'System32'),
        systemRoot,
      ],
      localBin: path.join(home, '.local', 'bin'),
      packageManagerPaths: [
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.cargo', 'bin'),
        path.join(home, 'scoop', 'shims'),
        path.join(home, 'AppData', 'Local', 'pnpm'),
      ],
    };
  }

  getEnvironmentConfig(): EnvironmentConfig {
    const home = this.getHome();

    return {
      homeVar: 'USERPROFILE',
      userVar: 'USERNAME',
      additionalVars: {
        USERPROFILE: home,
        HOME: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
        TEMP: process.env.TEMP || path.join(home, 'AppData', 'Local', 'Temp'),
        TMP: process.env.TMP || path.join(home, 'AppData', 'Local', 'Temp'),
      },
    };
  }

  override getDefaultShell(): string {
    // Prefer PowerShell, fall back to cmd.exe
    return process.env.COMSPEC || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  }

  override async detectShell(): Promise<string> {
    // Windows doesn't have a per-user shell preference like Unix
    // Just return the default
    return this.getDefaultShell();
  }

  override async detectLocale(): Promise<string> {
    // Windows uses different locale mechanism
    // Try environment first
    if (process.env.LANG) {
      return process.env.LANG;
    }

    // Could query Windows locale via PowerShell, but for simplicity use default
    return 'en_US.UTF-8';
  }
}
