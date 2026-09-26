import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ITheme } from 'xterm';
import { Terminal as XTerm } from 'xterm';
import { getTerminalTheme } from '@/lib/themes/terminal-theme';
import { RESIZE_DEBOUNCE_MS, TERMINAL_OPTIONS } from './config';
import { FilePathLinkProvider } from './link-providers';
import {
  isMac,
  isModifierPressed,
  removeLinkPopup,
  showLinkPopup,
} from './link-providers/link-popup';
import { suppressQueryResponses } from './suppressQueryResponses';
import type { TerminalInstance as XtermInstanceState } from './types';
import { debounce } from './utils';

// ============================================================================
// Terminal instance naming / ID helpers
// ============================================================================

/** Generate a unique terminal ID (short UUID) */
export function generateTerminalId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Generate a paneId for TerminalManager */
export function generatePaneId(chatId: string, terminalId: string): string {
  return `${chatId}:term:${terminalId}`;
}

const TERMINAL_NAME_PATTERN = /^Terminal (\d+)$/;

/** Return the next sequential terminal name (e.g. "Terminal 3") */
export function getNextTerminalName(terminals: XtermInstanceState[]): string {
  const existingNumbers = terminals
    .map((t) => {
      const match = t.name.match(TERMINAL_NAME_PATTERN);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  const maxNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;
  return `Terminal ${maxNumber + 1}`;
}

// ============================================================================
// Terminal background / theming
// ============================================================================

/**
 * Load GPU-accelerated renderer with automatic fallback.
 * Tries WebGL first, falls back to Canvas renderer if WebGL fails.
 */
function loadRenderer(xterm: XTerm): { dispose: () => void } {
  let renderer: WebglAddon | CanvasAddon | null = null;

  try {
    const webglAddon = new WebglAddon();

    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      try {
        renderer = new CanvasAddon();
        xterm.loadAddon(renderer);
      } catch {}
    });

    xterm.loadAddon(webglAddon);
    renderer = webglAddon;
  } catch (_err) {
    try {
      renderer = new CanvasAddon();
      xterm.loadAddon(renderer);
    } catch (_canvasErr) {
      // Both failed, use xterm's default renderer
    }
  }

  return {
    dispose: () => renderer?.dispose(),
  };
}

export type CreateTerminalOptions = {
  cwd?: string;
  initialTheme?: ITheme | null;
  isDark?: boolean;
  onFileLinkClick?: (path: string, line?: number, column?: number) => void;
  onUrlClick?: (url: string) => void;
};

export type XtermInstance = {
  xterm: XTerm;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  cleanup: () => void;
};

/**
 * Creates and initializes an xterm instance with all addons.
 * Does: create → open → addons → fit
 * This ensures dimensions are ready before PTY creation.
 */
export function createTerminalInstance(
  container: HTMLDivElement,
  options: CreateTerminalOptions = {},
): XtermInstance {
  const { initialTheme, isDark = true, onFileLinkClick, onUrlClick } = options;

  // Debug: Check container dimensions
  const _rect = container.getBoundingClientRect();

  // Use provided theme, or get theme based on isDark
  const theme = initialTheme ?? getTerminalTheme(isDark);
  const terminalOptions = { ...TERMINAL_OPTIONS, theme };
  const xterm = new XTerm(terminalOptions);
  xterm.open(container);

  // Debug: Check _renderService after open
  const _core = (xterm as unknown as { _core?: { _renderService?: unknown } })._core;
  const fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  const serializeAddon = new SerializeAddon();
  xterm.loadAddon(serializeAddon);
  const renderer = loadRenderer(xterm);

  // Debug: Check dimensions after renderer
  const _coreAfter = (xterm as unknown as { _core?: { _renderService?: { dimensions?: unknown } } })
    ._core;
  const cleanupQuerySuppression = suppressQueryResponses(xterm);

  // 7. Set up URL link provider using official WebLinksAddon
  if (onUrlClick) {
    const webLinksAddon = new WebLinksAddon(
      (event: MouseEvent, uri: string) => {
        // Require Cmd+Click (Mac) or Ctrl+Click (Windows/Linux)
        if (isModifierPressed(event)) {
          onUrlClick(uri);
        }
      },
      {
        hover: (event: MouseEvent, uri: string) => {
          showLinkPopup(event, uri, onUrlClick);
        },
        leave: () => {
          removeLinkPopup();
        },
      },
    );
    xterm.loadAddon(webLinksAddon);
  }

  // 8. Set up file path link provider
  if (onFileLinkClick) {
    const filePathLinkProvider = new FilePathLinkProvider(xterm, (_event, path, line, column) => {
      onFileLinkClick(path, line, column);
    });
    xterm.registerLinkProvider(filePathLinkProvider);
  }
  try {
    fitAddon.fit();
  } catch (_err) {}

  return {
    xterm,
    fitAddon,
    serializeAddon,
    cleanup: () => {
      cleanupQuerySuppression();
      renderer.dispose();
    },
  };
}

export type KeyboardHandlerOptions = {
  /** Callback for Shift+Enter (sends ESC+CR for line continuation) */
  onShiftEnter?: () => void;
  /** Callback for the clear terminal shortcut (Cmd+K) */
  onClear?: () => void;
};

/**
 * Setup keyboard handling for xterm including:
 * - Shift+Enter: Sends ESC+CR sequence
 * - Cmd+K: Clear terminal
 * - Ctrl+V / Cmd+V: Intercept to allow browser paste event
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupKeyboardHandler(
  xterm: XTerm,
  options: KeyboardHandlerOptions = {},
): () => void {
  const handler = (event: KeyboardEvent): boolean => {
    // Shift+Enter - line continuation
    const isShiftEnter =
      event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;

    if (isShiftEnter) {
      if (event.type === 'keydown' && options.onShiftEnter) {
        options.onShiftEnter();
      }
      return false; // Prevent xterm from processing
    }

    // Cmd+K - clear terminal (macOS)
    const isClearShortcut = event.key === 'k' && event.metaKey && !event.shiftKey && !event.altKey;

    if (isClearShortcut) {
      if (event.type === 'keydown' && options.onClear) {
        options.onClear();
      }
      return false; // Prevent xterm from processing
    }

    // Cmd+V (macOS) or Ctrl+V (Windows/Linux) - let paste event handle input.
    // On macOS, Ctrl+V is shell quoted-insert; only Cmd+V should paste.
    const isPasteShortcut =
      event.key === 'v' &&
      !event.shiftKey &&
      !event.altKey &&
      (isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

    if (isPasteShortcut) {
      return false;
    }

    return true; // Let xterm process the key
  };

  xterm.attachCustomKeyEventHandler(handler);

  return () => {
    xterm.attachCustomKeyEventHandler(() => true);
  };
}

export type PasteHandlerOptions = {
  /** Callback when text is pasted */
  onPaste?: (text: string) => void;
};

/**
 * Setup paste handler for xterm to ensure bracketed paste mode works correctly.
 *
 * This is required for TUI applications like vim that expect bracketed paste mode
 * to distinguish between typed and pasted content.
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupPasteHandler(xterm: XTerm, options: PasteHandlerOptions = {}): () => void {
  const textarea = xterm.textarea;
  if (!textarea) return () => {};

  const handlePaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    options.onPaste?.(text);
    xterm.paste(text);
  };

  textarea.addEventListener('paste', handlePaste, { capture: true });

  return () => {
    textarea.removeEventListener('paste', handlePaste, { capture: true });
  };
}

/**
 * Setup focus listener for the terminal.
 *
 * Returns a cleanup function to remove the listener.
 */
export function setupFocusListener(xterm: XTerm, onFocus: () => void): (() => void) | null {
  const textarea = xterm.textarea;
  if (!textarea) return null;

  textarea.addEventListener('focus', onFocus);

  return () => {
    textarea.removeEventListener('focus', onFocus);
  };
}

/**
 * Setup resize handlers for the terminal container.
 *
 * Returns a cleanup function to remove the handlers.
 */
export function setupResizeHandlers(
  container: HTMLDivElement,
  xterm: XTerm,
  fitAddon: FitAddon,
  onResize: (cols: number, rows: number) => void,
): () => void {
  const debouncedHandleResize = debounce(() => {
    try {
      fitAddon.fit();
      onResize(xterm.cols, xterm.rows);
    } catch {
      // Ignore resize errors
    }
  }, RESIZE_DEBOUNCE_MS);

  const resizeObserver = new ResizeObserver(debouncedHandleResize);
  resizeObserver.observe(container);
  window.addEventListener('resize', debouncedHandleResize);

  return () => {
    window.removeEventListener('resize', debouncedHandleResize);
    resizeObserver.disconnect();
    debouncedHandleResize.cancel();
  };
}

export type ClickToMoveOptions = {
  /** Callback to write data to the terminal PTY */
  onWrite: (data: string) => void;
};

/**
 * Convert mouse event coordinates to terminal cell coordinates.
 */
function getTerminalCoordsFromEvent(
  xterm: XTerm,
  event: MouseEvent,
): { col: number; row: number } | null {
  const element = xterm.element;
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  // Access internal render service for cell dimensions
  const dimensions = (
    xterm as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: { css: { cell: { width: number; height: number } } };
        };
      };
    }
  )._core?._renderService?.dimensions;

  if (!dimensions?.css?.cell) return null;

  const cellWidth = dimensions.css.cell.width;
  const cellHeight = dimensions.css.cell.height;

  if (cellWidth <= 0 || cellHeight <= 0) return null;

  const col = Math.max(0, Math.min(xterm.cols - 1, Math.floor(x / cellWidth)));
  const row = Math.max(0, Math.min(xterm.rows - 1, Math.floor(y / cellHeight)));

  return { col, row };
}

/**
 * Setup click-to-move cursor functionality.
 * Allows clicking on the current prompt line to move the cursor.
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupClickToMoveCursor(xterm: XTerm, options: ClickToMoveOptions): () => void {
  const handleClick = (event: MouseEvent) => {
    // Don't interfere with full-screen apps (vim, less, etc.)
    if (xterm.buffer.active !== xterm.buffer.normal) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (xterm.hasSelection()) return;

    const coords = getTerminalCoordsFromEvent(xterm, event);
    if (!coords) return;

    const buffer = xterm.buffer.active;
    const clickBufferRow = coords.row + buffer.viewportY;

    // Only move cursor on the same line (editable prompt area)
    if (clickBufferRow !== buffer.cursorY + buffer.viewportY) return;

    const delta = coords.col - buffer.cursorX;
    if (delta === 0) return;

    // Right arrow: \x1b[C, Left arrow: \x1b[D
    const arrowKey = delta > 0 ? '\x1b[C' : '\x1b[D';
    options.onWrite(arrowKey.repeat(Math.abs(delta)));
  };

  xterm.element?.addEventListener('click', handleClick);

  return () => {
    xterm.element?.removeEventListener('click', handleClick);
  };
}

export type ContextMenuHandlerOptions = {
  /** Callback when text is copied via context menu */
  onCopy?: (text: string) => void;
  /** Callback when text is pasted via context menu */
  onPaste?: (text: string) => void;
  /** Callback when clipboard access fails (e.g. permission denied) */
  onError?: () => void;
};

/**
 * Setup right-click context menu for terminal with copy/paste support.
 * - If text is selected: copies to clipboard
 * - If no selection: pastes from clipboard
 *
 * Returns a cleanup function to remove the handler.
 */
export function setupContextMenuHandler(
  xterm: XTerm,
  options: ContextMenuHandlerOptions = {},
): () => void {
  const handleContextMenu = async (event: MouseEvent) => {
    event.preventDefault();

    const selection = xterm.getSelection();

    if (selection) {
      // Has selection - copy to clipboard
      try {
        await navigator.clipboard.writeText(selection);
        options.onCopy?.(selection);
        // Clear selection after copy (optional, mimics typical terminal behavior)
        xterm.clearSelection();
      } catch {
        options.onError?.();
      }
    } else {
      // No selection - paste from clipboard
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          options.onPaste?.(text);
          xterm.paste(text);
        }
      } catch {
        options.onError?.();
      }
    }
  };

  xterm.element?.addEventListener('contextmenu', handleContextMenu);

  return () => {
    xterm.element?.removeEventListener('contextmenu', handleContextMenu);
  };
}
