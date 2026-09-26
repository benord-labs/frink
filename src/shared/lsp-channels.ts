/**
 * LSP IPC channel constants shared between main and preload/renderer.
 * Single source of truth to prevent drift between main and renderer processes.
 */

export const LSP_CHANNELS = {
  // From renderer to main
  START_SERVER: 'lsp:start-server',
  STOP_SERVER: 'lsp:stop-server',
  SEND_MESSAGE: 'lsp:send-message',
  IS_RUNNING: 'lsp:is-running',
  IS_AVAILABLE: 'lsp:is-available',

  // From main to renderer
  SERVER_MESSAGE: 'lsp:server-message',
  SERVER_ERROR: 'lsp:server-error',
  SERVER_EXIT: 'lsp:server-exit',
} as const;
