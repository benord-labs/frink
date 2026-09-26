export type TerminalProps = {
  paneId: string;
  /** Used with split view so the correct pane receives keyboard focus. */
  terminalId?: string;
  cwd: string;
  workspaceId?: string;
  tabId?: string;
  initialCommands?: string[];
  initialCwd?: string;
  /** When false, blur xterm so a sibling split pane can receive keys. Defaults to true. */
  isKeyboardTarget?: boolean;
  /**
   * When false (split-chat: inactive column), do not rAF-focus xterm and blur if focused.
   * Defaults to true. Orthogonal to `isKeyboardTarget` (PTY split vs chat split).
   */
  isPaneActive?: boolean;
  /**
   * Split panes: stable parent callback; pane identity comes from `terminalId` (avoid inline
   * wrappers that change every render).
   */
  onTerminalPaneFocused?: (terminalId: string) => void;
};

export type TerminalStreamEvent = {
  type: 'data' | 'exit';
  data?: string;
  exitCode?: number;
  signal?: number;
};

/**
 * Represents a terminal instance in the multi-terminal system.
 * Each chat can have multiple terminal instances.
 */
export type TerminalInstance = {
  /** Unique terminal id (nanoid) */
  id: string;
  /** Full paneId for TerminalManager: `${chatId}:term:${id}` */
  paneId: string;
  /** Display name: "Terminal 1", "Terminal 2", etc. */
  name: string;
  /** Creation timestamp */
  createdAt: number;
};
