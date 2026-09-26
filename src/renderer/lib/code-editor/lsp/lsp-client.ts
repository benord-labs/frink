/// <reference types="../../../../preload/index.d.ts" />

import type * as Monaco from 'monaco-editor';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction } from 'vscode-languageclient';
import { URI } from 'vscode-uri';
import type { LanguageId } from '../../../../main/lib/language-server/types';
import { IPCMessageReader, IPCMessageWriter } from './ipc-transport';

/**
 * Language mapping from Monaco language IDs to LSP language IDs
 */
const MONACO_TO_LSP_LANGUAGE: Record<string, LanguageId> = {
  typescript: 'typescript',
  javascript: 'javascript',
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  python: 'python',
  go: 'go',
  rust: 'rust',
  cpp: 'cpp',
  c: 'cpp',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'html',
  json: 'json',
  jsonc: 'jsonc',
};

/**
 * Get LSP language ID from Monaco language ID
 */
function getLSPLanguageId(monacoLanguage: string): LanguageId | null {
  return MONACO_TO_LSP_LANGUAGE[monacoLanguage] || null;
}

/**
 * Check if a language is supported by LSP
 */
export function isLanguageSupported(monacoLanguage: string): boolean {
  return monacoLanguage in MONACO_TO_LSP_LANGUAGE;
}

/** Implemented by {@link MonacoLSPClient}; use {@link getLSPClient} or `ReturnType<typeof getLSPClient>` at call sites. */
type ILSPClient = {
  initialize(
    monaco: typeof Monaco,
    workspacePath: string | null,
    language: string,
  ): Promise<boolean>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getActiveLanguage(): LanguageId | null;
};

/**
 * LSP client manager for Monaco Editor
 * Integrates monaco-languageclient with Electron IPC transport
 */
class MonacoLSPClient implements ILSPClient {
  private languageClient: MonacoLanguageClient | null = null;
  private workspacePath: string | null = null;
  private activeLanguage: LanguageId | null = null;

  /**
   * Initialize the LSP client with monaco-languageclient
   */
  async initialize(
    _monaco: typeof Monaco,
    workspacePath: string | null,
    language: string,
  ): Promise<boolean> {
    // Check if language is supported
    const lspLanguage = getLSPLanguageId(language);
    if (!lspLanguage) {
      return false;
    }

    // Don't start server if no workspace
    if (!workspacePath) {
      return false;
    }

    // Stop existing client if any
    if (this.languageClient) {
      await this.stop();
    }

    // Check if server is available
    const isAvailable = await window.desktopApi.lsp.isAvailable({ language: lspLanguage });
    if (!isAvailable) {
      return false;
    }

    // Start the language server in main process
    try {
      const result = await window.desktopApi.lsp.startServer({
        workspacePath,
        language: lspLanguage,
      });

      if (!result.success) {
        return false;
      }

      this.workspacePath = workspacePath;
      this.activeLanguage = lspLanguage;

      // Create IPC-based message transport
      const reader = new IPCMessageReader(workspacePath, lspLanguage);
      const writer = new IPCMessageWriter(workspacePath, lspLanguage);

      // Create and start the Monaco language client
      this.languageClient = new MonacoLanguageClient({
        name: `${lspLanguage} Language Client`,
        clientOptions: {
          documentSelector: [{ language }],
          workspaceFolder: {
            // vscode-uri's URI is compatible with vscode's Uri at runtime
            // biome-ignore lint/suspicious/noExplicitAny: Required for type compatibility between vscode-uri and monaco-languageclient
            uri: URI.file(workspacePath) as any,
            name: workspacePath.split('/').pop() || 'workspace',
            index: 0,
          },
          errorHandler: {
            error: () => ({ action: ErrorAction.Continue }),
            closed: () => ({ action: CloseAction.DoNotRestart }),
          },
        },
        messageTransports: { reader, writer },
      });

      await this.languageClient.start();
      return true;
    } catch (_error) {
      return false;
    }
  }

  /**
   * Stop the language server and client
   */
  async stop(): Promise<void> {
    if (this.languageClient) {
      await this.languageClient.stop();
      this.languageClient = null;
    }

    if (this.workspacePath && this.activeLanguage) {
      try {
        await window.desktopApi.lsp.stopServer({
          workspacePath: this.workspacePath,
          language: this.activeLanguage,
        });
      } catch (_error) {
        // Ignore errors during cleanup
      }
    }

    this.workspacePath = null;
    this.activeLanguage = null;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.languageClient !== null;
  }

  /**
   * Get active language
   */
  getActiveLanguage(): LanguageId | null {
    return this.activeLanguage;
  }
}

/**
 * Singleton LSP client instance
 */
let lspClient: MonacoLSPClient | null = null;

/**
 * Get or create LSP client instance
 */
export function getLSPClient(): ILSPClient {
  if (!lspClient) {
    lspClient = new MonacoLSPClient();
  }
  return lspClient;
}
