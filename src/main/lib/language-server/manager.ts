import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

// Get the path to node_modules/.bin for running language servers
const getNodeModulesBin = () => join(process.cwd(), 'node_modules', '.bin');

import type {
  LanguageId,
  LanguageServerInfo,
  LanguageServerInstance,
  ServerMessageParams,
  StartServerParams,
  StopServerParams,
} from './types';

/**
 * Manages language server processes across multiple workspaces.
 * Each workspace can have multiple language servers (one per language).
 */
class LanguageServerManager extends EventEmitter {
  private servers = new Map<string, LanguageServerInstance>();

  /**
   * Generate unique key for workspace + language combination
   */
  private getKey(workspacePath: string, language: LanguageId): string {
    return `${workspacePath}:${language}`;
  }

  /**
   * Get language server configuration
   */
  private getServerInfo(language: LanguageId, _workspacePath: string): LanguageServerInfo | null {
    const binPath = getNodeModulesBin();

    switch (language) {
      case 'typescript':
      case 'javascript':
        return {
          // Use the binary from node_modules/.bin
          command: join(binPath, 'typescript-language-server'),
          args: ['--stdio'],
          initializationOptions: {
            preferences: {
              // Will read tsconfig.json from workspace
            },
          },
        };

      case 'python':
        return {
          // Use the binary from node_modules/.bin
          command: join(binPath, 'pyright-langserver'),
          args: ['--stdio'],
          initializationOptions: {},
        };

      case 'go':
        // System binary (not npm package)
        return {
          command: 'gopls',
          args: ['serve', '-rpc.trace'],
          initializationOptions: {},
        };

      case 'rust':
        // System binary (not npm package)
        return {
          command: 'rust-analyzer',
          args: [],
          initializationOptions: {},
        };

      case 'cpp':
        // System binary (not npm package)
        return {
          command: 'clangd',
          args: ['--background-index'],
          initializationOptions: {},
        };

      case 'css':
      case 'scss':
      case 'sass':
      case 'less':
        return {
          command: join(binPath, 'vscode-css-language-server'),
          args: ['--stdio'],
          initializationOptions: {},
        };

      case 'html':
        return {
          command: join(binPath, 'vscode-html-language-server'),
          args: ['--stdio'],
          initializationOptions: {},
        };

      case 'json':
      case 'jsonc':
        return {
          command: join(binPath, 'vscode-json-language-server'),
          args: ['--stdio'],
          initializationOptions: {},
        };

      default:
        return null;
    }
  }

  /**
   * Check if a language server is available on the system
   */
  async isServerAvailable(language: LanguageId): Promise<boolean> {
    const serverInfo = this.getServerInfo(language, '');
    if (!serverInfo) return false;

    const npmLanguages = new Set([
      'typescript',
      'javascript',
      'python',
      'css',
      'scss',
      'sass',
      'less',
      'html',
      'json',
      'jsonc',
    ]);
    if (npmLanguages.has(language)) {
      return existsSync(serverInfo.command);
    }

    // For system binaries (Go, Rust, C++), check PATH via which/where (async — no spawnSync).
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        resolve(ok);
      };
      const child = spawn(lookupCommand, [serverInfo.command], {
        stdio: 'ignore',
        env: process.env,
      });
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* best-effort */
        }
        done(false);
      }, 5000);
      child.once('error', () => done(false));
      child.once('close', (code) => done(code === 0));
    });
  }

  /**
   * Start a language server for a workspace
   */
  async start(params: StartServerParams): Promise<LanguageServerInstance | null> {
    const { workspacePath, language } = params;
    const key = this.getKey(workspacePath, language);

    // Return existing if already running
    const existing = this.servers.get(key);
    if (existing?.isRunning) {
      return existing;
    }

    // Get server configuration
    const serverInfo = this.getServerInfo(language, workspacePath);
    if (!serverInfo) {
      return null;
    }

    // Check if workspace exists
    if (!existsSync(workspacePath)) {
      return null;
    }

    try {
      // Spawn the language server process
      const serverProcess = spawn(serverInfo.command, serverInfo.args, {
        cwd: workspacePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure language servers can find their dependencies
          NODE_PATH: join(process.cwd(), 'node_modules'),
        },
      });

      const instance: LanguageServerInstance = {
        process: serverProcess,
        workspacePath,
        language,
        pid: serverProcess.pid,
        startTime: Date.now(),
        isRunning: true,
      };

      // Set up event handlers
      this.setupServerHandlers(instance, key);

      // Store the instance
      this.servers.set(key, instance);

      return instance;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Set up event handlers for a language server process
   */
  private setupServerHandlers(instance: LanguageServerInstance, key: string): void {
    const { process: serverProcess } = instance;

    // Use LSP message reader/writer for proper framing
    if (!serverProcess.stdout || !serverProcess.stdin) {
      throw new Error('Server process stdio not available');
    }
    const reader = new StreamMessageReader(serverProcess.stdout);
    const writer = new StreamMessageWriter(serverProcess.stdin);

    // Store writer for sending messages
    instance.writer = writer;

    // Handle LSP messages from server (properly framed)
    reader.listen((msg) => {
      // Emit parsed LSP message object
      this.emit(`message:${key}`, msg);
    });

    reader.onError((error) => {
      this.emit(`error:${key}`, error.message);
    });

    reader.onClose(() => {
      instance.isRunning = false;
      this.emit(`exit:${key}`, null, null);
    });

    // Handle stderr (server logs/errors - not LSP messages)
    serverProcess.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      this.emit(`error:${key}`, message);
    });

    // Handle process exit
    serverProcess.on('exit', (code, signal) => {
      instance.isRunning = false;
      this.emit(`exit:${key}`, code, signal);

      // Clean up after a delay, but only if this instance is still the tracked one —
      // a restart inside the window installs a replacement that must survive this timer.
      setTimeout(() => {
        if (this.servers.get(key) === instance) {
          this.servers.delete(key);
        }
      }, 5000);
    });

    // Handle process errors
    serverProcess.on('error', (error) => {
      instance.isRunning = false;
      this.emit(`error:${key}`, error.message);
    });
  }

  /**
   * Stop a language server
   */
  stop(params: StopServerParams): boolean {
    const { workspacePath, language } = params;
    const key = this.getKey(workspacePath, language);
    const instance = this.servers.get(key);

    if (!instance?.isRunning) {
      return false;
    }

    try {
      instance.process.kill('SIGTERM');
      instance.isRunning = false;
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Send a message to a language server
   */
  send(params: ServerMessageParams): boolean {
    const { workspacePath, language, message } = params;
    const key = this.getKey(workspacePath, language);
    const instance = this.servers.get(key);

    if (!instance?.isRunning || !instance.writer) {
      return false;
    }

    try {
      // Parse and send as LSP message (properly framed)
      const lspMessage = JSON.parse(message);
      instance.writer.write(lspMessage);
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Get server instance
   */
  get(workspacePath: string, language: LanguageId): LanguageServerInstance | undefined {
    const key = this.getKey(workspacePath, language);
    return this.servers.get(key);
  }

  /**
   * Check if server is running
   */
  isRunning(workspacePath: string, language: LanguageId): boolean {
    const instance = this.get(workspacePath, language);
    return instance?.isRunning ?? false;
  }

  /**
   * Stop all language servers
   */
  stopAll(): void {
    for (const [_key, instance] of this.servers.entries()) {
      if (instance.isRunning) {
        try {
          instance.process.kill('SIGTERM');
          instance.isRunning = false;
        } catch {
          // Ignore errors during shutdown (process may have already exited)
        }
      }
    }
    this.servers.clear();
  }
}

// Singleton instance
export const languageServerManager = new LanguageServerManager();
