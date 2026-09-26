/**
 * IPC-based Message Transport for Monaco Language Client
 *
 * Implements MessageReader and MessageWriter interfaces from vscode-jsonrpc
 * to bridge monaco-languageclient with Electron's IPC mechanism.
 */

/// <reference types="../../../../preload/index.d.ts" />

import type { Message } from 'vscode-jsonrpc';
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type MessageReader,
  type MessageWriter,
} from 'vscode-jsonrpc';

/**
 * IPC-based MessageReader for receiving LSP messages from main process
 */
export class IPCMessageReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | null = null;
  private removeListener: (() => void) | null = null;

  constructor(
    private workspacePath: string,
    private language: string,
  ) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    if (this.callback) {
      throw new Error('MessageReader is already listening');
    }

    this.callback = callback;

    // Set up listener for messages from main process
    this.removeListener = window.desktopApi.lsp.onServerMessage((data) => {
      if (data.workspacePath === this.workspacePath && data.language === this.language) {
        // Pass the parsed LSP message to the callback (already parsed in main process)
        this.callback?.(data.message as unknown as Message);
      }
    });

    return {
      dispose: () => {
        this.callback = null;
        this.removeListener?.();
        this.removeListener = null;
      },
    };
  }
}

/**
 * IPC-based MessageWriter for sending LSP messages to main process
 */
export class IPCMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private errorCount = 0;
  private writeSemaphore = 1;

  constructor(
    private workspacePath: string,
    private language: string,
  ) {
    super();
  }

  async write(msg: Message): Promise<void> {
    if (this.writeSemaphore === 0) {
      throw new Error('MessageWriter is closed');
    }

    try {
      await window.desktopApi.lsp.sendMessage({
        workspacePath: this.workspacePath,
        language: this.language,
        message: JSON.stringify(msg),
      });
    } catch (error) {
      this.errorCount++;
      this.fireError(error, msg, this.errorCount);
      throw error;
    }
  }

  async end(): Promise<void> {
    this.writeSemaphore = 0;
  }
}
