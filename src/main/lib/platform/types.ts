/**
 * Platform abstraction layer types
 * Provides a unified interface for platform-specific operations
 */

export type ShellConfig = {
  /** Path to the default shell executable */
  executable: string;
  /** Arguments to pass for login shell */
  loginArgs: string[];
  /** Arguments to pass for command execution */
  execArgs: (command: string) => string[];
};

export type PathConfig = {
  /** PATH environment variable separator */
  separator: string;
  /** Common paths where tools are installed */
  commonPaths: string[];
  /** User-local bin directory */
  localBin: string;
  /** Package manager paths (npm, cargo, etc.) */
  packageManagerPaths: string[];
};

export type EnvironmentConfig = {
  /** Home directory environment variable name */
  homeVar: string;
  /** User name environment variable name */
  userVar: string;
  /** Additional platform-specific env vars to set */
  additionalVars: Record<string, string>;
};

/**
 * Platform Provider Interface
 * Implement this for each supported platform
 */
export type PlatformProvider = {
  /** Platform identifier */
  readonly platform: 'win32' | 'darwin' | 'linux';

  /** Display name for the platform */
  readonly displayName: string;

  /** Shell configuration */
  getShellConfig(): ShellConfig;

  /** PATH configuration */
  getPathConfig(): PathConfig;

  /** Environment configuration */
  getEnvironmentConfig(): EnvironmentConfig;

  /**
   * Build extended PATH with all common tool locations
   * @param currentPath - Current PATH value
   * @returns Extended PATH string
   */
  buildExtendedPath(currentPath?: string): string;

  /**
   * Get the default shell for this platform
   * @returns Path to default shell executable
   */
  getDefaultShell(): string;

  /**
   * Detect user's preferred shell (async, may spawn processes)
   * @param options.timeoutMs - Bound on any detection subprocess (defaults to the provider default)
   * @returns Promise resolving to shell path
   */
  detectShell(options?: { timeoutMs?: number }): Promise<string>;

  /**
   * Detect system locale
   * @param options.timeoutMs - Bound on any detection subprocess (defaults to the provider default)
   * @returns Promise resolving to locale string (e.g., "en_US.UTF-8")
   */
  detectLocale(options?: { timeoutMs?: number }): Promise<string>;

  /**
   * Build environment variables for shell/process execution
   * @param baseEnv - Base environment to extend
   * @returns Environment object with platform-specific additions
   */
  buildEnvironment(baseEnv?: Record<string, string>): Record<string, string>;

  /**
   * Execute a command and get output
   * Used for shell detection, locale detection, etc.
   * @param command - Command to execute
   * @param args - Command arguments
   * @param options - Execution options
   * @returns Promise with stdout and stderr
   */
  execCommand(
    command: string,
    args: string[],
    options?: { timeout?: number; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }>;
};
