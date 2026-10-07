/**
 * Base Platform Provider
 * Contains shared logic for all platforms
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { EnvironmentConfig, PathConfig, PlatformProvider, ShellConfig } from './types';

const execFileAsync = promisify(execFile);

export abstract class BasePlatformProvider implements PlatformProvider {
  abstract readonly platform: 'win32' | 'darwin' | 'linux';
  abstract readonly displayName: string;

  abstract getShellConfig(): ShellConfig;
  abstract getPathConfig(): PathConfig;
  abstract getEnvironmentConfig(): EnvironmentConfig;

  /**
   * Get home directory (cross-platform)
   */
  protected getHome(): string {
    return os.homedir();
  }

  /**
   * Get username (cross-platform)
   */
  protected getUsername(): string {
    return os.userInfo().username;
  }

  buildExtendedPath(currentPath?: string): string {
    const config = this.getPathConfig();
    const existingPaths = currentPath ? currentPath.split(config.separator).filter(Boolean) : [];

    const allPaths = [...config.commonPaths, config.localBin, ...config.packageManagerPaths];

    // Add paths that aren't already present (case-insensitive on Windows)
    const isWindows = this.platform === 'win32';
    const normalizedExisting = new Set(
      existingPaths.map((p) => (isWindows ? path.normalize(p).toLowerCase() : path.normalize(p))),
    );

    const newPaths: string[] = [];
    for (const p of allPaths) {
      const normalized = isWindows ? path.normalize(p).toLowerCase() : path.normalize(p);
      if (!normalizedExisting.has(normalized)) {
        newPaths.push(path.normalize(p));
        normalizedExisting.add(normalized);
      }
    }

    return [...newPaths, ...existingPaths].join(config.separator);
  }

  getDefaultShell(): string {
    const config = this.getShellConfig();
    return config.executable;
  }

  async detectShell(): Promise<string> {
    // Default implementation returns configured shell
    // Platforms can override for more sophisticated detection
    return this.getDefaultShell();
  }

  /**
   * Shared shell-detection flow for Unix providers: trust $SHELL, else run a
   * platform-specific lookup command and parse its output, else fall back to the
   * configured default. Only the command and its parse regex vary per platform.
   *
   * @param buildArgs - Builds the `sh -c` args, or returns null to skip the lookup
   * @param regex - Captures the shell path from the command output
   */
  protected async detectShellViaCommand(
    buildArgs: () => string[] | null,
    regex: RegExp,
    options?: { timeoutMs?: number },
  ): Promise<string> {
    if (process.env.SHELL) {
      return process.env.SHELL;
    }

    const args = buildArgs();
    if (args) {
      try {
        const { stdout } = await this.execCommand('sh', args, { timeout: options?.timeoutMs });
        const match = stdout.match(regex);
        if (match?.[1]) {
          return match[1].trim();
        }
      } catch {
        // Ignore errors — fall through to the configured default
      }
    }

    return this.getDefaultShell();
  }

  async detectLocale(options?: { timeoutMs?: number }): Promise<string> {
    // Check environment first
    if (process.env.LANG?.includes('UTF-8')) {
      return process.env.LANG;
    }
    if (process.env.LC_ALL?.includes('UTF-8')) {
      return process.env.LC_ALL;
    }

    // Try to get from the locale command (Unix). Windows overrides this — it has no `locale`.
    try {
      const { stdout } = await this.execCommand(
        'sh',
        ['-c', 'locale 2>/dev/null | grep LANG= | cut -d= -f2'],
        { timeout: options?.timeoutMs },
      );
      const trimmed = stdout.trim();
      if (trimmed?.includes('UTF-8')) {
        return trimmed;
      }
    } catch {
      // Ignore errors — fall through to default
    }

    return 'en_US.UTF-8';
  }

  buildEnvironment(baseEnv?: Record<string, string>): Record<string, string> {
    const envConfig = this.getEnvironmentConfig();
    const home = this.getHome();
    const user = this.getUsername();

    const env: Record<string, string> = { ...baseEnv };

    // Set home directory
    env[envConfig.homeVar] = home;
    if (!env.HOME) env.HOME = home;

    // Set user
    env[envConfig.userVar] = user;
    if (!env.USER) env.USER = user;

    // Set additional platform-specific vars
    for (const [key, value] of Object.entries(envConfig.additionalVars)) {
      if (!env[key]) {
        // Resolve special placeholders
        env[key] = value.replace(/\$\{HOME\}/g, home).replace(/\$\{USER\}/g, user);
      }
    }

    // Build extended PATH
    env.PATH = this.buildExtendedPath(env.PATH || process.env.PATH);

    // Set TERM if not present
    if (!env.TERM) {
      env.TERM = 'xterm-256color';
    }

    // Set SHELL
    if (!env.SHELL) {
      env.SHELL = this.getDefaultShell();
    }

    return env;
  }

  /**
   * Execute a command safely using execFile (no shell interpolation).
   *
   * This is the preferred method for simple command execution as it:
   * - Avoids shell injection vulnerabilities
   * - Has predictable argument handling
   *
   * For complex shell commands (pipes, redirects, osascript with quotes),
   * implementations may use exec/execSync directly as needed.
   */
  async execCommand(
    command: string,
    args: string[],
    options?: { timeout?: number; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: options?.timeout ?? 5000,
      env: options?.env as NodeJS.ProcessEnv | undefined,
      encoding: 'utf8',
    });
    return { stdout, stderr };
  }
}
