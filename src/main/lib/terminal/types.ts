import type * as pty from 'node-pty';
import type { DataBatcher } from './data-batcher';

export type TerminalSession = {
  pty: pty.IPty;
  batcher: DataBatcher;
  dataDisposable: { dispose(): void };
  exitDisposable?: { dispose(): void };
  initCommandDisposable?: { dispose(): void };
  paneId: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  lastActive: number;
  serializedState?: string;
  isAlive: boolean;
  shell: string;
  startTime: number;
  usedFallback: boolean;
};

type TerminalDataEvent = {
  type: 'data';
  data: string;
};

type TerminalExitEvent = {
  type: 'exit';
  exitCode: number;
  signal?: number;
};

export type TerminalEvent = TerminalDataEvent | TerminalExitEvent;

export type SessionResult = {
  isNew: boolean;
  /** Serialized terminal state from xterm's SerializeAddon */
  serializedState: string;
};

export type CreateSessionParams = {
  paneId: string;
  tabId?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  rootPath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCommands?: string[];
};

export type InternalCreateSessionParams = CreateSessionParams & {
  useFallbackShell?: boolean;
};

export type DetectedPort = {
  port: number;
  pid: number;
  processName: string;
  paneId: string;
  workspaceId: string;
  detectedAt: number;
  address: string;
};
