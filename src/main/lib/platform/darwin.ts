/**
 * macOS Platform Provider
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

const USER_SHELL_REGEX = /UserShell:\s*(.+)/;

/** Escape path for safe use inside a bash command (single-quote style). */
function escapePathForBash(pathStr: string): string {
  return `'${pathStr.replace(/'/g, "'\"'\"'")}'`;
}

/** Escape a bash command for use inside AppleScript "do shell script \"...\"". */
function escapeForAppleScript(bashCommand: string): string {
  return bashCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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

  getCliConfig(): CliConfig {
    return {
      installPath: '/usr/local/bin/frink',
      scriptName: 'frink',
      requiresAdmin: true, // /usr/local/bin requires admin on macOS
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

  async installCli(sourcePath: string): Promise<{ success: boolean; error?: string }> {
    const cliConfig = this.getCliConfig();
    const installPath = cliConfig.installPath;

    if (!existsSync(sourcePath)) {
      return { success: false, error: 'CLI script not found in app bundle' };
    }

    try {
      const safeInstall = escapePathForBash(installPath);
      const safeSource = escapePathForBash(sourcePath);
      // Remove existing if present (escaped for bash then AppleScript)
      if (existsSync(installPath)) {
        const rmCmd = `rm -f ${safeInstall}`;
        const rmScript = `do shell script "${escapeForAppleScript(rmCmd)}" with administrator privileges`;
        await execFileAsync('osascript', ['-e', rmScript]);
      }

      // Create symlink with admin privileges (escaped for bash then AppleScript)
      const lnCmd = `ln -s ${safeSource} ${safeInstall}`;
      const lnScript = `do shell script "${escapeForAppleScript(lnCmd)}" with administrator privileges`;
      await execFileAsync('osascript', ['-e', lnScript]);

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

      const safeInstall = escapePathForBash(installPath);
      const rmCmd = `rm -f ${safeInstall}`;
      const rmScript = `do shell script "${escapeForAppleScript(rmCmd)}" with administrator privileges`;
      await execFileAsync('osascript', ['-e', rmScript]);

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
