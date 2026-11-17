import type {
  GetAuthStatusResponse,
  GetStatusResponse,
  JsonValue,
  ManagedSettingsResolvedData,
  MessageOptions,
  ModelInfo,
  PermissionMode,
  SessionConfigBase,
  SessionEvent,
  SessionHooks,
  SessionMode,
} from '@github/copilot-sdk';
import type { CopilotTurnClient, CopilotTurnSession } from './copilot-runner';

/** What a session reports when only Frink's own policy applies. */
export const CLIENT_ONLY_POLICY: ManagedSettingsResolvedData = {
  bypassPermissionsDisabled: true,
  clientManaged: true,
  deviceManaged: false,
  failClosed: false,
  managedKeys: ['permissions'],
  policyHelperManaged: false,
  serverManaged: false,
  source: 'client',
};

const EVENT_BASE = {
  id: 'event',
  parentId: null,
  timestamp: new Date(0).toISOString(),
  ephemeral: true,
} satisfies Pick<SessionEvent, 'id' | 'parentId' | 'timestamp'> & { ephemeral: true };

export const managedReport = (data: ManagedSettingsResolvedData): SessionEvent => ({
  ...EVENT_BASE,
  type: 'session.managed_settings_resolved',
  data,
});

/** One piece of the agent's reply text. */
export const says = (deltaContent: string, messageId = 'message-1'): SessionEvent => ({
  ...EVENT_BASE,
  type: 'assistant.message_delta',
  data: { deltaContent, messageId },
});

export const thinks = (deltaContent: string): SessionEvent => ({
  ...EVENT_BASE,
  type: 'assistant.reasoning_delta',
  data: { deltaContent, reasoningId: 'reasoning-1' },
});

export const toolStarts = (
  toolCallId: string,
  toolName: string,
  args: JsonValue,
): SessionEvent => ({
  ...EVENT_BASE,
  type: 'tool.execution_start',
  data: { toolCallId, toolName, arguments: args },
});

export const toolEnds = (toolCallId: string, success: boolean, text = 'done'): SessionEvent => ({
  ...EVENT_BASE,
  type: 'tool.execution_complete',
  data: success
    ? { toolCallId, success, result: { content: text } }
    : { toolCallId, success, error: { message: text } },
});

export const IDLE: SessionEvent = { ...EVENT_BASE, type: 'session.idle', data: {} };
/** The main agent is done while a command it started still runs. */
export const AGENT_IDLE: SessionEvent = { ...EVENT_BASE, type: 'assistant.idle', data: {} };
export const TASKS_CHANGED: SessionEvent = {
  ...EVENT_BASE,
  type: 'session.background_tasks_changed',
  data: {},
};

type HookAnswer = Awaited<ReturnType<NonNullable<SessionHooks['onPreToolUse']>>>;

/** One turn as the fake plays it: the prompt it got, and the events and hook calls it sends. */
type FakeTurn = {
  message: MessageOptions;
  emit(event: SessionEvent): void;
  preToolUse(toolName: string, toolArgs: JsonValue): Promise<HookAnswer>;
  /** The CLI process dies: its connection stops answering. */
  crash(): void;
};

type FakeCopilotSetup = {
  status?: GetStatusResponse;
  auth?: GetAuthStatusResponse;
  /** The managed-settings report sent while the session opens; null sends none. */
  managed?: ManagedSettingsResolvedData | null;
  /** A report sent while Frink checks the permission mode. */
  managedLater?: ManagedSettingsResolvedData;
  permissionMode?: PermissionMode;
  /** The mode a session opens in; Copilot keeps a resumed session's mode. */
  mode?: SessionMode;
  /** The resume reports Frink's policy, then fails. */
  resumeFails?: boolean;
  planFails?: boolean;
  /** Plays the turn after the prompt; by default the session goes idle at once. */
  turn?: (play: FakeTurn) => void | Promise<void>;
  /** The prompt is taken but Copilot never answers. */
  sendHangs?: boolean;
  /** Copilot finishes starting once this settles. */
  started?: Promise<void>;
  /** The client's graceful stop never finishes. */
  stopHangs?: boolean;
  /** Background commands the session lists until the client stops or crashes. */
  commandPids?: number[];
  /** The command listing answers only once this settles, even after the client stopped. */
  listedLate?: Promise<void>;
  models?: ModelInfo[];
};

type TaskInfo = Awaited<ReturnType<CopilotTurnSession['rpc']['tasks']['list']>>['tasks'][number];

const shellTask = (pid: number): TaskInfo => ({
  type: 'shell',
  id: `shell-${pid}`,
  description: 'Background command',
  status: 'running',
  startedAt: new Date(0).toISOString(),
  command: 'sleep',
  attachmentMode: 'attached',
  pid,
});

type OpenedSession = { how: 'create' | 'resume'; sessionId?: string; config: SessionConfigBase };

/** A Copilot client double that records how each session was opened and how it was stopped. */
export function fakeCopilotClient(setup: FakeCopilotSetup = {}) {
  const opened: OpenedSession[] = [];
  let disconnects = 0;
  const sent: MessageOptions[] = [];
  const calls: string[] = [];
  let mode: SessionMode = setup.mode ?? 'interactive';
  let crashed = false;
  let lastConfig: SessionConfigBase | undefined;
  const report = (config: SessionConfigBase | undefined, data: ManagedSettingsResolvedData) =>
    config?.onEvent?.(managedReport(data));
  const play: Omit<FakeTurn, 'message'> = {
    emit: (event) => lastConfig?.onEvent?.(event),
    preToolUse: async (toolName, toolArgs) =>
      lastConfig?.hooks?.onPreToolUse?.(
        {
          sessionId: session.sessionId,
          timestamp: new Date(0),
          workingDirectory: '',
          toolName,
          toolArgs,
        },
        { sessionId: session.sessionId },
      ),
    crash: () => {
      crashed = true;
    },
  };
  const session: CopilotTurnSession = {
    sessionId: 'copilot-session',
    rpc: {
      permissions: {
        getMode: async () => {
          if (setup.managedLater) report(lastConfig, setup.managedLater);
          return { mode: setup.permissionMode ?? 'manual' };
        },
      },
      mode: {
        get: async () => mode,
        set: async (params) => {
          if (setup.planFails) throw new Error('mode change failed');
          mode = params.mode;
          return { status: 'applied', modelChanged: false };
        },
      },
      tasks: {
        list: async () => {
          if (setup.listedLate) await setup.listedLate;
          else if (crashed || calls.includes('stop')) throw new Error('Connection is closed.');
          return { tasks: (setup.commandPids ?? []).map(shellTask) };
        },
      },
    },
    disconnect: async () => {
      disconnects += 1;
    },
    send: async (message) => {
      sent.push(message);
      if (setup.sendHangs) return new Promise<string>(() => {});
      const turn = setup.turn ?? (({ emit }) => emit(IDLE));
      void Promise.resolve().then(() => turn({ ...play, message }));
      return 'sent-message';
    },
    abort: async () => {
      calls.push('abort');
    },
  };
  const open = (config: SessionConfigBase, sessionId: string) => {
    lastConfig = config;
    session.sessionId = sessionId;
    const data = setup.managed === undefined ? CLIENT_ONLY_POLICY : setup.managed;
    if (data) report(config, data);
    return session;
  };
  const client: CopilotTurnClient = {
    start: async () => {
      calls.push('start');
      await setup.started;
    },
    stop: async () => {
      calls.push('stop');
      if (setup.stopHangs) await new Promise(() => {});
      return [];
    },
    forceStop: async () => {
      calls.push('forceStop');
    },
    ping: async () => {
      if (crashed) throw new Error('Connection is closed.');
      return { message: 'pong', timestamp: new Date(0).toISOString() };
    },
    listModels: async () => setup.models ?? [],
    getStatus: async () => setup.status ?? { version: '1.0.97', protocolVersion: 3 },
    getAuthStatus: async () =>
      setup.auth ?? { isAuthenticated: true, authType: 'user', host: 'https://github.com' },
    createSession: async (config) => {
      opened.push({ how: 'create', config });
      return open(config, 'copilot-session');
    },
    resumeSession: async (sessionId, config) => {
      opened.push({ how: 'resume', sessionId, config });
      if (setup.resumeFails) {
        report(config, CLIENT_ONLY_POLICY);
        throw new Error('Session not found');
      }
      return open(config, sessionId);
    },
  };
  return { client, session, opened, sent, calls, play, disconnects: () => disconnects };
}
