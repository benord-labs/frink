// Split from executor.test.ts (vitest hoists module mocks per file, so the flag mock
// cannot be shared): an unreachable Railway backend must not block local sends or lose
// the renderer binding. The vi.mock preamble mirrors executor-plan-halt.test.ts.

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/launch-flags', () => ({
  LAUNCH_FLAGS: {
    flows: true,
    workQueue: true,
    integrations: true,
  },
}));

const { claudeQueryMock } = vi.hoisted(() => ({
  claudeQueryMock: vi.fn(),
}));
const flowQuestionParkMock = vi.hoisted(() => vi.fn());

const dbProjectState = vi.hoisted(() => ({
  projectRow: null as { id: string; name: string; path: string } | null,
  /** Every `.set()` payload the stub received — how a task-result write is observed. */
  updates: new Array<{ result?: object }>(),
}));

const dynamicChatServerMocks = vi.hoisted(() => ({
  bindChannelExecution: vi.fn(),
  setCurrentExecutionChat: vi.fn(() => 'exec-context-1'),
  clearCurrentExecutionChat: vi.fn(),
  getOrStartDynamicChatMcpUrl: vi.fn(async () => 'http://127.0.0.1:9999'),
  getLatestTaskSignal: vi.fn(),
}));

const flowProviderPreflightMocks = vi.hoisted(() => ({
  getFlowRun: vi.fn(async () => ({ id: 'flow-run', status: 'running' })),
  isFlowRunSignalDead: vi.fn(async () => false),
  liveAdmissionForRun: vi.fn(() => ({ flowRunId: 'flow-run', state: 'active' })),
  registerNodeAbort: vi.fn(),
  unregisterNodeAbort: vi.fn(),
}));

const wakeHoldMocks = vi.hoisted(() => ({
  hasWakeHold: vi.fn((_subChatId?: string, _session?: unknown) => false),
  releaseWakeHold: vi.fn(),
}));

const runtimeGateMocks = vi.hoisted(() => ({
  acquireRuntimeSlot: vi.fn(async () => () => {}),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeQueryMock,
}));

vi.mock('./streaming/question-hold-park', () => ({
  holdOrParkQuestion: flowQuestionParkMock,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app',
    getPath: (name: string) => (name === 'userData' ? '/mock/userData' : '/mock/home'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../sentry/init', () => ({
  captureMainException: vi.fn(),
  captureMainMessage: vi.fn(),
}));

vi.mock('../agent-runner', () => ({
  runCodexAgent: vi.fn(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- same Codex auth probe stub as executor.test.ts; this harness mocks every collaborator
vi.mock('../credentials/detect-codex', () => ({
  detectCodexAccount: vi.fn(() => ({
    available: true,
    displayName: 'Codex',
    sourcePath: 'codex-passthrough://local',
  })),
}));

vi.mock('../debug-ingest/ingest-server', () => ({
  startIngestServer: vi.fn(async () => 9876),
  registerDebugSession: vi.fn((sessionId: string) => ({
    endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
    logFilePath: `/tmp/project/.frink/debug/${sessionId}.ndjson`,
  })),
  unregisterDebugSession: vi.fn(),
  stopIngestServer: vi.fn(async () => {}),
}));

vi.mock('../claude', () => ({
  buildClaudeEnv: vi.fn(() => ({})),
  createTransformer: vi.fn(),
  getBundledClaudeBinaryPath: vi.fn(),
  clampEffortForBundledBinary: vi.fn((effort?: string) => effort),
}));

vi.mock('../cloud-client', () => ({
  denyBashPermission: vi.fn(),
  grantBashPermissionWithValidation: vi.fn(),
  isBashCommandApprovedInDb: vi.fn(),
  isBashCommandDeniedInDb: vi.fn(),
  recordBashPermissionUse: vi.fn(),
}));

vi.mock('../db/repos/tasks', () => ({
  getTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskResult: vi.fn(),
  isTerminalFinalTaskStatus: (status: string) =>
    ['done', 'completed', 'cancelled'].includes(status),
  getFlowDriveInfoForSubChat: vi.fn(async () => ({
    active: false,
    autoApprovePlan: false,
    taskId: null,
  })),
  getLatestFlowTaskForSubChat: vi.fn(async () => null),
  cancelFlowTaskForSubChat: vi.fn(async () => 'flow-task-1'),
  parkFlowTaskForSubChatOnUsageLimit: vi.fn(async () => 'parked-task-1'),
}));

vi.mock('../db/repos/sub-chats', () => ({
  updateSubChatMode: vi.fn(async () => undefined),
}));

vi.mock('../db/repos/flow-runs', () => ({
  getFlowRun: flowProviderPreflightMocks.getFlowRun,
  isFlowRunSignalDead: flowProviderPreflightMocks.isFlowRunSignalDead,
}));

vi.mock('../flows/admission/store', () => ({
  liveAdmissionForRun: flowProviderPreflightMocks.liveAdmissionForRun,
}));

vi.mock('../flows/cancel-registry', () => ({
  registerNodeAbort: flowProviderPreflightMocks.registerNodeAbort,
  unregisterNodeAbort: flowProviderPreflightMocks.unregisterNodeAbort,
}));

vi.mock('./claude-wake-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claude-wake-hold')>()),
  armWakePump: vi.fn(),
  hasWakeHold: wakeHoldMocks.hasWakeHold,
  releaseWakeHold: wakeHoldMocks.releaseWakeHold,
  takeWakeHold: vi.fn(() => null),
}));

vi.mock('./execution/wake-hold-registry-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./execution/wake-hold-registry-view')>()),
  hasReusableWakeHoldRuntimeSlot: vi.fn(() => false),
}));

vi.mock('./runtime-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime-gate')>()),
  acquireRuntimeSlot: runtimeGateMocks.acquireRuntimeSlot,
}));

vi.mock('../flows/resume', () => ({
  resumeFlowNodeInPlace: vi.fn(async () => true),
  isRunRestartInterrupted: vi.fn(async () => false),
  resumeInterruptedFlowInPlace: vi.fn(async () => true),
}));

vi.mock('../db/repos/chats', () => ({
  getChatWithProjectAccount: vi.fn(),
}));

vi.mock('../db', () => ({
  getDatabase: vi.fn(() => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(dbProjectState.projectRow ? [dbProjectState.projectRow] : []),
      update: () => builder,
      set: (values: { result?: object }) => {
        dbProjectState.updates.push(values);
        return builder;
      },
      returning: () => Promise.resolve([]),
    };
    return builder as unknown;
  }),
}));

vi.mock('../db/repos/projects', () => ({
  getProjectByPath: vi.fn(async () => null),
  listProjects: vi.fn(async () => []),
}));

vi.mock('../credentials', () => ({
  getClaudeCodeTokenByLabel: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  // Mirrors the real predicate (credentials.ts): passthrough rows are token-null by design,
  // so `passthrough` — not token presence — is what the spawn pre-flight gates on.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

vi.mock('../mcp/config', () => ({
  getGlobalMcpServers: vi.fn(() => []),
  getMcpCredentials: vi.fn(() => ({})),
}));

vi.mock('../mcp/dynamic-chat-server', () => ({
  bindChannelExecution: dynamicChatServerMocks.bindChannelExecution,
  setCurrentExecutionChat: dynamicChatServerMocks.setCurrentExecutionChat,
  clearCurrentExecutionChat: dynamicChatServerMocks.clearCurrentExecutionChat,
  getOrStartDynamicChatMcpUrl: dynamicChatServerMocks.getOrStartDynamicChatMcpUrl,
  getLatestTaskSignal: dynamicChatServerMocks.getLatestTaskSignal,
}));

vi.mock('../multi-project-prompt', () => ({
  getMultiProjectContext: vi.fn(),
}));

vi.mock('../frink-system-prompt', () => ({
  buildFrinkSystemPromptAppend: vi.fn(async () => '# Frink Platform\n(mock)'),
  FRINK_PLATFORM_BLOCK: '# Frink Platform\n(mock)',
}));

vi.mock('../permissions/command-parser', () => ({
  extractCommandSignatures: vi.fn(),
  generatePatternChoices: vi.fn(),
}));

vi.mock('../permissions/v2/check', () => ({
  checkPermission: vi.fn(),
}));

vi.mock('../permissions/v2/store-local', () => ({
  addProjectRule: vi.fn(async () => undefined),
}));

vi.mock('../permissions/cursor-config-sync', () => ({
  addBashRuleToCursorConfig: vi.fn(async () => undefined),
}));

vi.mock('../permissions/v2/persist-approved-rule', () => ({
  persistApprovedRule: vi.fn(async () => undefined),
}));

vi.mock('../permissions/proxy', () => ({
  isPathBypassed: vi.fn(() => false),
  SENSITIVE_DIRS: [],
}));

vi.mock('../trpc/routers/agent-utils', () => ({
  getAllAgentsForSdk: vi.fn(() => []),
}));

vi.mock('./client', () => ({
  broadcastToRenderer: vi.fn(),
  broadcastTaskSignalPersisted: vi.fn(),
  onPermissionResponse: vi.fn(() => () => {}),
  sendErrorDirect: vi.fn(),
  sendExecuteCompleteDirect: vi.fn(),
  sendPermissionRequest: vi.fn(),
  sendPermissionDismiss: vi.fn(),
  sendStreamSettledDirect: vi.fn(),
  sendStreamChunkDirect: vi.fn(),
  sendSubChatModeChange: vi.fn(),
  sendWakeHoldChanged: vi.fn(),
}));

import { runCodexAgent } from '../agent-runner';
import { createTransformer, getBundledClaudeBinaryPath } from '../claude';
import type { UIMessageChunk } from '../claude/types';
import { getDefaultClaudeCodeToken } from '../credentials';
import { getChatWithProjectAccount } from '../db/repos/chats';
import {
  cancelFlowTaskForSubChat,
  getFlowDriveInfoForSubChat,
  getLatestFlowTaskForSubChat,
  getTaskById,
  updateTaskStatus,
} from '../db/repos/tasks';
import {
  isRunRestartInterrupted,
  resumeFlowNodeInPlace,
  resumeInterruptedFlowInPlace,
} from '../flows/resume';
import { getMultiProjectContext } from '../multi-project-prompt';
import { checkPermission } from '../permissions/v2/check';
import type { TaskStopHook } from '../task-stop-hook';
import { clearActiveFlowTaskForChatIfMatches, setActiveFlowTaskForChat } from '../task-executor';
import { armWakePump, type WakeHold } from './claude-wake-hold';
import * as socketClient from './client';
import {
  _hasActiveExecutionForTests,
  abortActiveExecutionsForWebContents,
  handleRemoteExecute,
  handleRemoteStop,
} from './executor';

type HeldQueryInput = {
  options: { hooks: { Stop: Array<{ hooks: TaskStopHook[] }> } };
};

describe('local-only dispatch with unresolved machineId', () => {
  const project = {
    id: 'project-local-mode',
    name: 'Local Mode Project',
    path: '/tmp/project-local-mode',
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-local-mode',
    subChatId: '99999999-9999-4999-8999-999999999999',
    projectId: project.id,
    mode: 'agent' as const,
    assistantMessageId: 'assistant-local-mode',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    wakeHoldMocks.hasWakeHold.mockReturnValue(false);
    runtimeGateMocks.acquireRuntimeSlot.mockReset();
    runtimeGateMocks.acquireRuntimeSlot.mockResolvedValue(() => {});
    vi.mocked(checkPermission).mockResolvedValue({ decision: 'allow' });
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
    vi.mocked(getTaskById).mockResolvedValue(null);
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: null,
    });
    vi.mocked(getBundledClaudeBinaryPath).mockReturnValue('/mock/bin/claude');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the turn when machine resolution fails (cloud unreachable)', async () => {
    claudeQueryMock.mockImplementationOnce(() => {
      const gen = (async function* () {
        yield {
          chunks: [
            { type: 'finish', messageMetadata: { sessionId: 'sess-local-1' } },
          ] as UIMessageChunk[],
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn() });
    });

    await handleRemoteExecute({ ...basePayload, message: 'hello from an offline machine' });

    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads wake-hold state when deferred completion dispatches', async () => {
    claudeQueryMock.mockImplementationOnce(() => {
      const gen = (async function* () {
        yield { chunks: [{ type: 'finish' }] as UIMessageChunk[] };
        yield { type: 'result' };
      })();
      return Object.assign(gen, { interrupt: vi.fn() });
    });
    const immediateCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => {
      immediateCallbacks.push(() => callback(...args));
      return 0 as unknown as NodeJS.Immediate;
    }) as typeof setImmediate);
    let continuing = true;
    wakeHoldMocks.hasWakeHold.mockImplementation((_subChatId, session) => {
      return Boolean(session) && continuing;
    });

    await handleRemoteExecute({ ...basePayload, message: 'finish then defer completion' });
    expect(immediateCallbacks).toHaveLength(1);
    continuing = false;
    immediateCallbacks[0]?.();

    expect(socketClient.sendExecuteCompleteDirect).toHaveBeenCalledWith(
      expect.objectContaining({ continuesWakeHold: false }),
    );
  });

  it('terminalizes a registered stream when Stop wins while waiting for a runtime slot', async () => {
    let releaseSlot = () => {};
    const slot = new Promise<() => void>((resolve) => {
      releaseSlot = () => resolve(() => {});
    });
    runtimeGateMocks.acquireRuntimeSlot.mockReturnValueOnce(slot);

    const execution = handleRemoteExecute({ ...basePayload, message: 'wait for a Claude slot' });
    await vi.waitFor(() => expect(runtimeGateMocks.acquireRuntimeSlot).toHaveBeenCalledOnce());
    handleRemoteStop({ chatId: basePayload.chatId, subChatId: basePayload.subChatId });
    releaseSlot();
    await execution;

    expect(socketClient.sendStreamSettledDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        subChatId: basePayload.subChatId,
        assistantMessageId: basePayload.assistantMessageId,
        streamEpoch: expect.any(String),
      }),
    );
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });

  it('gives a Flow AskUserQuestion the foreground execution settlement barrier', async () => {
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'flow-question-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'flow-question-task',
    });
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'flow-question-task',
      source: 'flow',
      status: 'running',
      flowRunId: 'flow-question-run',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);

    let settlement: Promise<void> | undefined;
    flowQuestionParkMock.mockImplementationOnce(
      async (params: { waitForSettlement: () => Promise<void> }) => {
        settlement = params.waitForSettlement();
        let settledEarly = false;
        void settlement.then(() => {
          settledEarly = true;
        });
        await Promise.resolve();
        expect(settledEarly).toBe(false);
        return { behavior: 'deny', message: 'test question handled' };
      },
    );
    claudeQueryMock.mockImplementationOnce((queryInput: unknown) => {
      const canUseTool = (
        queryInput as {
          options?: {
            canUseTool?: (
              name: string,
              input: Record<string, unknown>,
              options: { toolUseID: string },
            ) => Promise<unknown>;
          };
        }
      ).options?.canUseTool;
      const query = (async function* () {
        await canUseTool?.('AskUserQuestion', { questions: [] }, { toolUseID: 'ask-flow-1' });
        yield { type: 'result', chunks: [{ type: 'finish' }] };
      })();
      return Object.assign(query, { interrupt: vi.fn(async () => {}) });
    });

    await handleRemoteExecute({ ...basePayload, message: 'ask before proceeding' });

    expect(flowQuestionParkMock).toHaveBeenCalledOnce();
    await expect(settlement).resolves.toBeUndefined();
  });

  it('releases a hold-only Stop without cancelling its settled Flow task', async () => {
    wakeHoldMocks.hasWakeHold.mockReturnValue(true);

    handleRemoteStop({ chatId: basePayload.chatId, subChatId: basePayload.subChatId });
    await new Promise((resolve) => setImmediate(resolve));

    expect(wakeHoldMocks.releaseWakeHold).toHaveBeenCalledWith(
      basePayload.subChatId,
      'remote-stop',
      undefined,
    );
    expect(cancelFlowTaskForSubChat).not.toHaveBeenCalled();
  });

  it('fails closed before provider launch when Flow provenance is unknown under admission', async () => {
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-db-fault-admission' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockRejectedValueOnce(
      new Error('flow provenance read failed'),
    );
    await handleRemoteExecute({ ...basePayload, message: 'follow-up during db fault' });

    expect(claudeQueryMock).not.toHaveBeenCalled();
    expect(dynamicChatServerMocks.setCurrentExecutionChat).not.toHaveBeenCalled();
    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('flow provenance read failed') }),
    );
  });

  it('does not revive restart-interrupted Flow work before credential validation', async () => {
    const activity = await import('../flows/admission/activity');
    vi.mocked(getLatestFlowTaskForSubChat).mockResolvedValueOnce({
      id: 'restart-task',
      flowRunId: 'flow-run',
      status: 'cancelled',
    } as Awaited<ReturnType<typeof getLatestFlowTaskForSubChat>>);
    vi.mocked(isRunRestartInterrupted).mockResolvedValueOnce(true);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'claude-code',
      label: 'missing',
    });
    activity.setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
    await handleRemoteExecute({ ...basePayload, message: 'restart without credentials' });

    expect(flowProviderPreflightMocks.registerNodeAbort).toHaveBeenCalledOnce();
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(resumeInterruptedFlowInPlace).not.toHaveBeenCalled();
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });

  it('never launches a stale cancelled expected Flow task under admission', async () => {
    const activity = await import('../flows/admission/activity');
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'pinned-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'stale-flow-task',
      source: 'flow',
      flowRunId: 'flow-run',
      status: 'cancelled',
    } as Awaited<ReturnType<typeof getTaskById>>);
    activity.setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
    setActiveFlowTaskForChat(basePayload.chatId, 'stale-flow-task');

    try {
      await handleRemoteExecute({
        ...basePayload,
        expectedFlowTaskId: 'stale-flow-task',
        message: 'stale queued provider request',
      });

      expect(flowProviderPreflightMocks.registerNodeAbort).toHaveBeenCalledWith(
        'flow-run',
        expect.any(AbortController),
      );
      expect(flowProviderPreflightMocks.unregisterNodeAbort).toHaveBeenCalledOnce();
      expect(claudeQueryMock).not.toHaveBeenCalled();
      expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('no longer execution-eligible') }),
      );
    } finally {
      clearActiveFlowTaskForChatIfMatches(basePayload.chatId, 'stale-flow-task');
    }
  });

  it('declines an unaccepted expected task id rather than executing it as an ordinary follow-up', async () => {
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'ordinary-session' } }] };
      yield { type: 'result' };
    });
    await handleRemoteExecute({
      ...basePayload,
      expectedFlowTaskId: 'unaccepted-flow-task',
      message: 'ordinary follow-up',
    });

    expect(flowProviderPreflightMocks.registerNodeAbort).not.toHaveBeenCalled();
    expect(claudeQueryMock).not.toHaveBeenCalled();
    expect(socketClient.sendErrorDirect).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'FLOW_RUN_ENDED' }),
    );
  });

  it('does not resume or mutate a newer driver when a parked reply arrives after Flow advancement', async () => {
    dbProjectState.updates.length = 0;
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'newer-task',
    });
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'newer-task',
      source: 'flow',
      status: 'needs_attention',
      flowRunId: 'flow-run',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    const onExecutionStarted = vi.fn();
    await handleRemoteExecute({
      ...basePayload,
      expectedFlowTaskId: 'answered-task',
      message: 'answer to the earlier question',
      onExecutionStarted,
    });

    expect(onExecutionStarted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ category: 'FLOW_RUN_ENDED' }),
    );
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(resumeFlowNodeInPlace).not.toHaveBeenCalled();
    expect(dbProjectState.updates).toEqual([]);
    expect(dynamicChatServerMocks.setCurrentExecutionChat).not.toHaveBeenCalled();
    expect(claudeQueryMock).not.toHaveBeenCalled();
    expect(socketClient.sendErrorDirect).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'FLOW_RUN_ENDED' }),
    );
  });

  it('binds the renderer window even with null machine ids (abort-by-webContents reaches the run)', async () => {
    const webContentsId = 77;
    let boundDuringTurn: boolean | null = null;
    let clearedByAbort: boolean | null = null;

    claudeQueryMock.mockImplementationOnce(() => {
      const gen = (async function* () {
        boundDuringTurn = _hasActiveExecutionForTests(basePayload.subChatId);
        abortActiveExecutionsForWebContents(webContentsId, 'renderer torn down');
        clearedByAbort = !_hasActiveExecutionForTests(basePayload.subChatId);
        yield {
          chunks: [
            { type: 'finish', messageMetadata: { sessionId: 'sess-local-2' } },
          ] as UIMessageChunk[],
        };
      })();
      return Object.assign(gen, { close: vi.fn() });
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'bind me',
      sourceWebContentsId: webContentsId,
    });

    expect(boundDuringTurn).toBe(true);
    expect(clearedByAbort).toBe(true);
  });

  // The marker must land for every linked task even without the dynamic-chat MCP (single-project
  // install, as here: listProjects resolves []) — otherwise the flows sweep never parks the row.
  async function quietEndMarkerWritten(): Promise<boolean> {
    const { SQL, StringChunk } = await import('drizzle-orm');
    return dbProjectState.updates.some(
      ({ result }) =>
        result instanceof SQL &&
        result.queryChunks.some(
          (chunk) => chunk instanceof StringChunk && chunk.value.join('').includes('quietEndedAt'),
        ),
    );
  }

  it('a Flow cancel still ends a Claude session held on background work', async () => {
    const activity = await import('../flows/admission/activity');
    activity.setFlowAdmissionLifecycleHooks({
      reconcile: vi.fn(async () => {}),
      requestRelease: vi.fn(async () => {}),
    });
    // SAFETY: the executor reads only chat.taskId and account from this row.
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'flow-held-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    // SAFETY: task linkage reads only id/source/status/flowRunId/result.
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'flow-held-task',
      source: 'flow',
      status: 'running',
      flowRunId: 'flow-run',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    const close = vi.fn();
    claudeQueryMock.mockImplementationOnce(({ options }: HeldQueryInput) => {
      const query = (async function* () {
        await options.hooks.Stop[0].hooks[0]({
          hook_event_name: 'Stop',
          stop_hook_active: false,
          background_tasks: [{ id: 'bg1', type: 'shell', status: 'running', description: 'cov' }],
          session_id: '',
          transcript_path: '',
          cwd: '',
        });
        yield { type: 'result', chunks: [{ type: 'finish' }] };
      })();
      return Object.assign(query, { close });
    });
    vi.mocked(armWakePump).mockImplementationOnce(
      (params) =>
        // SAFETY: the executor reads only the Flow abort registration and the pump's end off a hold.
        ({
          unregisterFlowRunAbort: params.unregisterFlowRunAbort,
          pump: { done: new Promise(() => {}) },
        }) as WakeHold,
    );

    await handleRemoteExecute({ ...basePayload, message: 'run coverage and wait' });
    const [, controller] = flowProviderPreflightMocks.registerNodeAbort.mock.calls[0] ?? [];
    expect(close).not.toHaveBeenCalled();
    controller?.abort();

    expect(close).toHaveBeenCalled();
  });

  it('leaves the quiet-end marker on a Claude flow task turn that ends unsignalled', async () => {
    dbProjectState.updates.length = 0;
    // SAFETY: the executor reads only chat.taskId and account from this row.
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'flow-quiet-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'flow-quiet-task',
    });
    // SAFETY: task linkage reads only id/source/status/flowRunId/result.
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'flow-quiet-task',
      source: 'flow',
      status: 'running',
      flowRunId: 'flow-quiet-run',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    claudeQueryMock.mockImplementationOnce(() => {
      const chunks: UIMessageChunk[] = [
        { type: 'finish', messageMetadata: { sessionId: 'sess-flow-quiet' } },
      ];
      const query = (async function* () {
        yield { type: 'result', chunks };
      })();
      return Object.assign(query, { interrupt: vi.fn(async () => {}) });
    });

    await handleRemoteExecute({ ...basePayload, message: 'end quietly' });

    await expect(quietEndMarkerWritten()).resolves.toBe(true);
  });

  it('leaves the quiet-end marker on a Codex task turn that ends unsignalled', async () => {
    // Non-Claude providers have no Stop hook; the post-stream finalize is their only marker writer.
    dbProjectState.updates.length = 0;
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    // SAFETY: the executor reads only chat.taskId and account from this row.
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'codex-quiet-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    // SAFETY: task linkage reads only id/source/status/flowRunId/result.
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'codex-quiet-task',
      source: 'chat',
      status: 'running',
      flowRunId: null,
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      const chunks: UIMessageChunk[] = [
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'done, no signal' },
        { type: 'finish', messageMetadata: { sessionId: 'codex-quiet' } },
      ];
      yield* chunks;
    });

    await handleRemoteExecute({ ...basePayload, message: 'answer quietly' });

    await expect(quietEndMarkerWritten()).resolves.toBe(true);
  });
});
