/* eslint-disable max-lines, max-lines-per-function */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { exposeElectronTRPC } from 'trpc-electron/main';
import type { ShellOpenExternalResult } from '../shared/shell-external-url';
import type { TranscriptTerminalDurability } from '../shared/types/assistant-message';
import type { ChatMode } from '../shared/types/chat-mode';
import type { FlowConsentPromptData } from '../shared/types/flows/flow-consent';
import type {
  PendingMoveChatProjection,
  PromptData,
  RuleType,
  SocketPermissionProjection,
} from '../shared/types/permissions';
import type { TaskChatReadyData } from '../shared/types/task-chat-ready';
import { type ArtifactPreviewApi, artifactPreviewApi } from './artifact-preview';

// Only initialize Sentry in production to avoid IPC errors in dev mode.
// Preload runs in an isolated context but uses the renderer SDK; events
// flow back to the main process via IPC.
if (process.env.NODE_ENV === 'production' && process.env.MAIN_VITE_SENTRY_DSN) {
  void Promise.all([import('@sentry/electron/renderer'), import('../shared/sentry/scrubber')]).then(
    ([Sentry, { beforeBreadcrumb, beforeSend }]) => {
      Sentry.init({
        dsn: process.env.MAIN_VITE_SENTRY_DSN,
        defaultIntegrations: false,
        beforeSend: (event) => beforeSend(event),
        beforeBreadcrumb: (breadcrumb) => beforeBreadcrumb(breadcrumb),
      });
    },
  );
}

// Isolated QA boots wipe the profile; pre-seeding the welcome flag lands the driver on
// the feature shell. The literal must match STORAGE_KEY in renderer WelcomeSplash (no cross-process import).
if (process.env.FRINK_QA_SKIP_WELCOME) {
  window.localStorage.setItem('frink:has-seen-welcome', 'true');
}
if (process.env.FRINK_CDP_PORT) contextBridge.exposeInMainWorld('__FRINK_QA__', true);

/** Channels the generic `desktopApi.on` bridge accepts — one union, referenced by both the
 * implementation and the exposed type below so they can never drift apart. */
type DesktopBroadcastChannel =
  | 'socket:error'
  | 'git:status-changed'
  | 'chats:name-updated'
  | 'projects:name-updated'
  | 'socket:wake-hold-changed'
  | 'socket:stream-settled'
  | 'socket:subagent-task-changed'
  | 'socket:background-tasks-changed'
  | 'composer:changed';

type MoveChatRequest = Omit<PendingMoveChatProjection, 'operation'>;

exposeElectronTRPC();

// Expose Electron webUtils for drag-and-drop file path resolution (used by file tree and terminal)
contextBridge.exposeInMainWorld('webUtils', {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});

// Expose desktop-specific APIs
/**
 * execute-complete payload. `finalParts` is authoritative for the exact main-minted stream epoch.
 */
type SocketExecuteCompleteData = {
  chatId: string;
  subChatId: string;
  assistantMessageId: string;
  sessionId?: string;
  metadata?: unknown;
  finalParts?: unknown[];
  /** Set only for a between-turn wake burst — the observer lane's ownership signal. */
  wakeBurst?: boolean;
  continuesWakeHold?: boolean;
  streamEpoch?: string;
  observerOwned?: boolean;
};

contextBridge.exposeInMainWorld('desktopApi', {
  // Platform info
  platform: process.platform,
  arch: process.arch,
  getVersion: () => ipcRenderer.invoke('app:version'),
  isPackaged: () => ipcRenderer.invoke('app:isPackaged'),

  // Auto-update methods
  checkForUpdates: (force?: boolean) => ipcRenderer.invoke('update:check', force),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Auto-update event listeners
  onUpdateChecking: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('update:checking', handler);
    return () => ipcRenderer.removeListener('update:checking', handler);
  },
  onUpdateAvailable: (callback: (info: { version: string; releaseDate?: string }) => void) => {
    const handler = (_event: unknown, info: { version: string; releaseDate?: string }) =>
      callback(info);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onUpdateNotAvailable: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('update:not-available', handler);
    return () => ipcRenderer.removeListener('update:not-available', handler);
  },
  /** Spawn-time signal: this project has skills the spawning tool can't read (offer to copy across). */
  onProviderUnbridged: (
    callback: (data: {
      projectId: string;
      providerKind: 'claude-code' | 'cursor';
      skills: { name: string; sourcePath: string }[];
    }) => void,
  ) => {
    const handler = (_event: unknown, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('provider:unbridged', handler);
    return () => ipcRenderer.removeListener('provider:unbridged', handler);
  },
  onUpdateProgress: (
    callback: (progress: {
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      progress: { percent: number; bytesPerSecond: number; transferred: number; total: number },
    ) => callback(progress);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => {
    const handler = (_event: unknown, info: UpdateInfo) => callback(info);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.removeListener('update:downloaded', handler);
  },
  onUpdateError: (callback: (error: string) => void) => {
    const handler = (_event: unknown, error: string) => callback(error);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.removeListener('update:error', handler);
  },
  onUpdateManualCheck: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('update:manual-check', handler);
    return () => ipcRenderer.removeListener('update:manual-check', handler);
  },

  // File operation progress (cross-project copy/move)
  onFileOperationProgress: (
    callback: (progress: {
      operationId: string;
      current: number;
      total: number;
      currentFile: string;
      done: boolean;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      progress: {
        operationId: string;
        current: number;
        total: number;
        currentFile: string;
        done: boolean;
      },
    ) => callback(progress);
    ipcRenderer.on('files:operation-progress', handler);
    return () => ipcRenderer.removeListener('files:operation-progress', handler);
  },

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowToggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  windowIsFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  artifactPreview: artifactPreviewApi,
  setWindowFramePreference: (useNativeFrame: boolean) =>
    ipcRenderer.invoke('window:set-frame-preference', useNativeFrame),
  getWindowFrameState: () => ipcRenderer.invoke('window:get-frame-state'),

  // Window events
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on('window:fullscreen-change', handler);
    return () => ipcRenderer.removeListener('window:fullscreen-change', handler);
  },
  onFocusChange: (callback: (isFocused: boolean) => void) => {
    const handler = (_event: unknown, isFocused: boolean) => callback(isFocused);
    ipcRenderer.on('window:focus-change', handler);
    return () => ipcRenderer.removeListener('window:focus-change', handler);
  },

  // Zoom controls
  zoomIn: () => ipcRenderer.invoke('window:zoom-in'),
  zoomOut: () => ipcRenderer.invoke('window:zoom-out'),
  zoomReset: () => ipcRenderer.invoke('window:zoom-reset'),
  getZoom: () => ipcRenderer.invoke('window:get-zoom'),

  // DevTools
  toggleDevTools: () => ipcRenderer.invoke('window:toggle-devtools'),
  unlockDevTools: () => ipcRenderer.invoke('window:unlock-devtools'),

  // Analytics
  setAnalyticsOptOut: (optedOut: boolean) => ipcRenderer.invoke('analytics:set-opt-out', optedOut),

  // Native features
  setBadge: (count: number | null) => ipcRenderer.invoke('app:set-badge', count),
  setBadgeIcon: (imageData: string | null) => ipcRenderer.invoke('app:set-badge-icon', imageData),
  showNotification: (options: { title: string; body: string }) =>
    ipcRenderer.invoke('app:show-notification', options),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  // Clipboard
  clipboardWrite: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),

  // MCP auto-import completion event (boot-time + post-auth)
  onMcpImported: (callback: (result: { imported: number; conflicts: number }) => void) => {
    const handler = (_event: unknown, result: { imported: number; conflicts: number }) =>
      callback(result);
    ipcRenderer.on('mcp:imported', handler);
    return () => ipcRenderer.removeListener('mcp:imported', handler);
  },

  // MCP OAuth completion event (from main process after authorization code exchange)
  onMcpAuthCompleted: (
    callback: (data: {
      serverName: string;
      projectPath?: string;
      success: boolean;
      error?: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { serverName: string; projectPath?: string; success: boolean; error?: string },
    ) => callback(data);
    ipcRenderer.on('mcp-auth-completed', handler);
    return () => ipcRenderer.removeListener('mcp-auth-completed', handler);
  },

  // Shortcut events (from main process menu accelerators)
  onShortcutNewAgent: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('shortcut:new-agent', handler);
    return () => ipcRenderer.removeListener('shortcut:new-agent', handler);
  },

  // File change events (from Claude Write/Edit tools)
  onFileChanged: (
    callback: (data: { filePath: string; type: string; subChatId: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { filePath: string; type: string; subChatId: string },
    ) => callback(data);
    ipcRenderer.on('file-changed', handler);
    return () => ipcRenderer.removeListener('file-changed', handler);
  },

  // Git status change events (from file watcher)
  onGitStatusChanged: (
    callback: (data: {
      worktreePath: string;
      changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        worktreePath: string;
        changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
      },
    ) => callback(data);
    ipcRenderer.on('git:status-changed', handler);
    return () => ipcRenderer.removeListener('git:status-changed', handler);
  },

  // IDE config change detection (agents, skills, hooks, etc.)
  onIdeConfigChanged: (
    callback: (data: {
      worktreePath: string;
      changes: Array<{ resourceType: string; origin: string; type?: string }>;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        worktreePath: string;
        changes: Array<{ resourceType: string; origin: string; type?: string }>;
      },
    ) => callback(data);
    ipcRenderer.on('ide-config:changed', handler);
    return () => ipcRenderer.removeListener('ide-config:changed', handler);
  },

  // Subscribe to git watcher for a worktree (from renderer)
  subscribeToGitWatcher: (worktreePath: string) =>
    ipcRenderer.invoke('git:subscribe-watcher', worktreePath),
  unsubscribeFromGitWatcher: (worktreePath: string) =>
    ipcRenderer.invoke('git:unsubscribe-watcher', worktreePath),

  // Task execution events (from work queue)
  onTaskChatReady: (callback: (data: TaskChatReadyData) => void) => {
    const handler = (_event: unknown, data: TaskChatReadyData) => callback(data);
    ipcRenderer.on('task:chat-ready', handler);
    return () => ipcRenderer.removeListener('task:chat-ready', handler);
  },

  // Dynamic chat: agent requested to move current chat to another project (blocking until user approves/denies)
  onAgentRequestMoveChat: (callback: (data: MoveChatRequest) => void) => {
    const handler = (_event: unknown, data: MoveChatRequest) => callback(data);
    ipcRenderer.on('agent:request-move-chat', handler);
    return () => ipcRenderer.removeListener('agent:request-move-chat', handler);
  },
  sendAgentMoveChatResponse: (requestId: string, approved: boolean) =>
    ipcRenderer.send('agent:move-chat-response', { requestId, approved }),

  // Fired by main after user approves move-chat; renderer switches to moved chat (same chat, new project)
  onAgentMoveChatApproved: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      projectId: string;
      projectName: string;
      projectPath: string;
      requestedWorktreePath: string | null;
      navigationSessionId: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        chatId: string;
        subChatId: string;
        projectId: string;
        projectName: string;
        projectPath: string;
        requestedWorktreePath: string | null;
        navigationSessionId: string;
      },
    ) => callback(data);
    ipcRenderer.on('agent:move-chat-approved', handler);
    return () => ipcRenderer.removeListener('agent:move-chat-approved', handler);
  },

  // Permission prompt events (from main process) - LOCAL IPC
  // TODO(6.9-local-execution): This handler is for local execution mode (via proxy.ts).
  // Currently NOT used - all execution goes through socket flow (onSocketPermissionRequest below).
  // Will be activated for Phase 6.9 local-only execution mode.
  onPermissionRequest: (
    callback: (data: {
      requestId: string;
      scope:
        | { type: 'git_remote'; gitRemote: string }
        | { type: 'folder'; folderId: string }
        | { type: 'bash' };
      path: string;
      operation: 'read' | 'write' | 'delete' | 'bash';
      reason?: string;
      taskId?: string;
      projectPath?: string;
      /** v2 dispatcher prompt context. */
      prompt?: PromptData;
      /** Set for type 'flow_consent' — the per-flow agent-run card. */
      flowConsent?: FlowConsentPromptData;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        requestId: string;
        scope:
          | { type: 'git_remote'; gitRemote: string }
          | { type: 'folder'; folderId: string }
          | { type: 'bash' };
        path: string;
        operation: 'read' | 'write' | 'delete' | 'bash';
        reason?: string;
        taskId?: string;
        projectPath?: string;
        prompt?: PromptData;
      },
    ) => callback(data);
    ipcRenderer.on('permission:request', handler);
    return () => ipcRenderer.removeListener('permission:request', handler);
  },
  sendPermissionResponse: (response: {
    requestId: string;
    approved: boolean;
    scope?: 'project' | 'user';
    ruleString?: string;
    ruleType?: RuleType;
  }) => ipcRenderer.send('permission:response', response),

  // Pop a timed-out LOCAL-IPC prompt from the renderer queue (proxy.ts, dynamic-chat-server.ts).
  onPermissionDismiss: (callback: (data: { requestId: string }) => void) => {
    const handler = (_event: unknown, data: { requestId: string }) => callback(data);
    ipcRenderer.on('permission:dismiss', handler);
    return () => ipcRenderer.removeListener('permission:dismiss', handler);
  },

  // Socket-based permission events
  onSocketPermissionRequest: (callback: (data: SocketPermissionProjection) => void) => {
    const handler = (_event: unknown, data: SocketPermissionProjection) => callback(data);
    ipcRenderer.on('socket:permission-request', handler);
    return () => ipcRenderer.removeListener('socket:permission-request', handler);
  },
  sendSocketPermissionResponse: (response: {
    chatId: string;
    subChatId: string;
    requestId: string;
    approved: boolean;
    /** Set when the response is a system-driven cancellation (pane close, timeout) — persistence paths must skip. */
    timedOut?: boolean;
    scope?: 'project' | 'user';
    ruleString?: string;
    ruleType?: RuleType;
    /** "Always allow this flow" — writes flows.agent_invocable, not a rule. */
    flowGrant?: boolean;
  }) => ipcRenderer.send('socket:permission-response', response),

  // Pop a timed-out SOCKET prompt from the renderer queue (executor.ts).
  onSocketPermissionDismiss: (callback: (data: { requestId: string }) => void) => {
    const handler = (_event: unknown, data: { requestId: string }) => callback(data);
    ipcRenderer.on('socket:permission-dismiss', handler);
    return () => ipcRenderer.removeListener('socket:permission-dismiss', handler);
  },

  // Socket events
  onSocketError: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      error: string;
      assistantMessageId?: string;
      /** UUID we attempted to resume; present when the failure was a stale Claude session. */
      failedSessionId?: string;
      /** Error classification (e.g. 'RATE_LIMIT_SDK') — drives renderer toast + failure handling. */
      category?: string;
      streamEpoch?: string;
      terminalDurability?: TranscriptTerminalDurability;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        chatId: string;
        subChatId: string;
        error: string;
        assistantMessageId?: string;
        failedSessionId?: string;
        category?: string;
        streamEpoch?: string;
        terminalDurability?: TranscriptTerminalDurability;
      },
    ) => callback(data);
    ipcRenderer.on('socket:error', handler);
    return () => ipcRenderer.removeListener('socket:error', handler);
  },
  onSocketStreamChunk: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      assistantMessageId: string;
      chunk: unknown;
      parts?: unknown[];
      messageIndex: number;
      streamEpoch?: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        chatId: string;
        subChatId: string;
        assistantMessageId: string;
        chunk: unknown;
        parts?: unknown[];
        messageIndex: number;
        streamEpoch?: string;
      },
    ) => callback(data);
    ipcRenderer.on('socket:stream-chunk', handler);
    return () => ipcRenderer.removeListener('socket:stream-chunk', handler);
  },
  onSocketExecuteStart: (
    callback: (data: { chatId: string; subChatId: string; assistantMessageId: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        chatId: string;
        subChatId: string;
        assistantMessageId: string;
      },
    ) => callback(data);
    ipcRenderer.on('socket:execute-start', handler);
    return () => ipcRenderer.removeListener('socket:execute-start', handler);
  },
  onSocketExecuteComplete: (callback: (data: SocketExecuteCompleteData) => void) => {
    const handler = (_event: unknown, data: SocketExecuteCompleteData) => callback(data);
    ipcRenderer.on('socket:execute-complete', handler);
    return () => ipcRenderer.removeListener('socket:execute-complete', handler);
  },
  onSocketTaskSignalPersisted: (
    callback: (data: { taskId: string; status: string; isFlowLinked: boolean }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { taskId: string; status: string; isFlowLinked: boolean },
    ) => callback(data);
    ipcRenderer.on('socket:task-signal-persisted', handler);
    return () => ipcRenderer.removeListener('socket:task-signal-persisted', handler);
  },
  onSocketMessageSaved: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      message: { id: string; role: string; parts: unknown[] };
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        chatId: string;
        subChatId: string;
        message: { id: string; role: string; parts: unknown[] };
      },
    ) => callback(data);
    ipcRenderer.on('socket:message-saved', handler);
    return () => ipcRenderer.removeListener('socket:message-saved', handler);
  },

  onSocketFlowExecutionEvent: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('socket:flow-execution-event', handler);
    return () => ipcRenderer.removeListener('socket:flow-execution-event', handler);
  },
  onSocketFlowChatReply: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      message: string;
      flowRunId: string;
      nodeRunId: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: {
        chatId: string;
        subChatId: string;
        message: string;
        flowRunId: string;
        nodeRunId: string;
      },
    ) => callback(data);
    ipcRenderer.on('socket:flow-chat-reply', handler);
    return () => ipcRenderer.removeListener('socket:flow-chat-reply', handler);
  },
  onSubChatModeChanged: (
    callback: (data: { chatId: string; subChatId: string; mode: ChatMode }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { chatId: string; subChatId: string; mode: ChatMode },
    ) => callback(data);
    ipcRenderer.on('socket:sub-chat-mode-changed', handler);
    return () => ipcRenderer.removeListener('socket:sub-chat-mode-changed', handler);
  },

  // Socket connection status events
  on: (channel: DesktopBroadcastChannel, callback: (data?: unknown) => void) => {
    const handler = (_event: unknown, data?: unknown) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

// Type definitions
export type UpdateInfo = {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  silent?: boolean;
};

export type UpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export type DesktopApi = {
  platform: NodeJS.Platform;
  arch: string;
  getVersion: () => Promise<string>;
  isPackaged: () => Promise<boolean>;
  // Auto-update
  checkForUpdates: () => Promise<UpdateInfo | null>;
  downloadUpdate: () => Promise<boolean>;
  installUpdate: () => void;
  onUpdateChecking: (callback: () => void) => () => void;
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateNotAvailable: (callback: () => void) => () => void;
  onProviderUnbridged: (
    callback: (data: {
      projectId: string;
      providerKind: 'claude-code' | 'cursor';
      skills: { name: string; sourcePath: string }[];
    }) => void,
  ) => () => void;
  onUpdateProgress: (callback: (progress: UpdateProgress) => void) => () => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => () => void;
  onUpdateError: (callback: (error: string) => void) => () => void;
  onUpdateManualCheck: (callback: () => void) => () => void;
  onFileOperationProgress: (
    callback: (progress: {
      operationId: string;
      current: number;
      total: number;
      currentFile: string;
      done: boolean;
    }) => void,
  ) => () => void;
  // Window controls
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  windowToggleFullscreen: () => Promise<void>;
  windowIsFullscreen: () => Promise<boolean>;
  artifactPreview: ArtifactPreviewApi;
  setWindowFramePreference: (useNativeFrame: boolean) => Promise<boolean>;
  getWindowFrameState: () => Promise<boolean>;
  onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void;
  onFocusChange: (callback: (isFocused: boolean) => void) => () => void;
  zoomIn: () => Promise<void>;
  zoomOut: () => Promise<void>;
  zoomReset: () => Promise<void>;
  getZoom: () => Promise<number>;
  toggleDevTools: () => Promise<void>;
  unlockDevTools: () => Promise<void>;
  setAnalyticsOptOut: (optedOut: boolean) => Promise<void>;
  setBadge: (count: number | null) => Promise<void>;
  setBadgeIcon: (imageData: string | null) => Promise<void>;
  showNotification: (options: { title: string; body: string }) => Promise<void>;
  openExternal: (url: string) => Promise<ShellOpenExternalResult>;
  clipboardWrite: (text: string) => Promise<void>;
  clipboardRead: () => Promise<string>;
  // MCP auto-import
  onMcpImported: (
    callback: (result: { imported: number; conflicts: number }) => void,
  ) => () => void;
  // MCP OAuth
  onMcpAuthCompleted: (
    callback: (data: {
      serverName: string;
      projectPath?: string;
      success: boolean;
      error?: string;
    }) => void,
  ) => () => void;
  // Shortcuts
  onShortcutNewAgent: (callback: () => void) => () => void;
  // Socket connection status events
  on: (channel: DesktopBroadcastChannel, callback: (data?: unknown) => void) => () => void;
  // File changes
  onFileChanged: (
    callback: (data: { filePath: string; type: string; subChatId: string }) => void,
  ) => () => void;
  // Git status changes (from file watcher)
  onGitStatusChanged: (
    callback: (data: {
      worktreePath: string;
      changes: Array<{ path: string; type: 'add' | 'change' | 'unlink' }>;
    }) => void,
  ) => () => void;
  // IDE config change detection (agents, skills, hooks, etc.)
  onIdeConfigChanged?: (
    callback: (data: {
      worktreePath: string;
      changes: Array<{ resourceType: string; origin: string; type?: string }>;
    }) => void,
  ) => () => void;
  subscribeToGitWatcher: (worktreePath: string) => Promise<void>;
  unsubscribeFromGitWatcher: (worktreePath: string) => Promise<void>;
  // Task execution events
  onTaskChatReady: (callback: (data: TaskChatReadyData) => void) => () => void;
  onAgentRequestMoveChat: (callback: (data: MoveChatRequest) => void) => () => void;
  sendAgentMoveChatResponse: (requestId: string, approved: boolean) => void;
  onAgentMoveChatApproved: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      projectId: string;
      projectName: string;
      projectPath: string;
      requestedWorktreePath: string | null;
      navigationSessionId: string;
    }) => void,
  ) => () => void;
  // Permission prompt events
  onPermissionRequest: (
    callback: (data: {
      requestId: string;
      scope:
        | { type: 'git_remote'; gitRemote: string }
        | { type: 'folder'; folderId: string }
        | { type: 'bash' };
      path: string;
      operation: 'read' | 'write' | 'delete' | 'bash';
      reason?: string;
      taskId?: string;
      projectPath?: string;
    }) => void,
  ) => () => void;
  sendPermissionResponse: (response: {
    requestId: string;
    approved: boolean;
    scope?: 'project' | 'user';
    ruleString?: string;
    ruleType?: 'allow' | 'deny' | 'ask';
  }) => void;
  onPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
  // Socket-based permission events
  onSocketPermissionRequest: (callback: (data: SocketPermissionProjection) => void) => () => void;
  sendSocketPermissionResponse: (response: {
    chatId: string;
    subChatId: string;
    requestId: string;
    approved: boolean;
    /** Set when the response is a system-driven cancellation (pane close, timeout) — persistence paths must skip. */
    timedOut?: boolean;
    scope?: 'project' | 'user';
    ruleString?: string;
    ruleType?: 'allow' | 'deny' | 'ask';
    /** "Always allow this flow" — writes flows.agent_invocable, not a rule. */
    flowGrant?: boolean;
  }) => void;
  onSocketPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
  // Socket events
  onSocketError: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      error: string;
      assistantMessageId?: string;
      /** UUID we attempted to resume; present when the failure was a stale Claude session. */
      failedSessionId?: string;
      /** Error classification (e.g. 'RATE_LIMIT_SDK') — drives renderer toast + failure handling. */
      category?: string;
      streamEpoch?: string;
      terminalDurability?: TranscriptTerminalDurability;
    }) => void,
  ) => () => void;
  onSocketStreamChunk: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      assistantMessageId: string;
      chunk: unknown;
      parts?: unknown[];
      messageIndex: number;
      streamEpoch?: string;
    }) => void,
  ) => () => void;
  onSocketExecuteStart: (
    callback: (data: { chatId: string; subChatId: string; assistantMessageId: string }) => void,
  ) => () => void;
  onSocketExecuteComplete: (callback: (data: SocketExecuteCompleteData) => void) => () => void;
  onSocketTaskSignalPersisted: (
    callback: (data: { taskId: string; status: string; isFlowLinked: boolean }) => void,
  ) => () => void;
  onSocketMessageSaved: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      message: { id: string; role: string; parts: unknown[] };
    }) => void,
  ) => () => void;
  onSocketFlowExecutionEvent: (
    callback: (data: import('../shared/types/flow').FlowExecutionEvent) => void,
  ) => () => void;
  onSocketFlowChatReply: (
    callback: (data: {
      chatId: string;
      subChatId: string;
      message: string;
      flowRunId: string;
      nodeRunId: string;
    }) => void,
  ) => () => void;
  onSubChatModeChanged: (
    callback: (data: { chatId: string; subChatId: string; mode: ChatMode }) => void,
  ) => () => void;
};
