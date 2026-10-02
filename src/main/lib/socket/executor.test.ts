/* eslint-disable max-lines */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_ABORT_ERROR_PATTERNS } from '../../../shared/lib/user-abort-error';
import type { TaskResultRecord } from '../db/repos/tasks';
import {
  registerClaudePrewarmTests,
  registerClaudeSessionCallbackTests,
  registerClaudeSessionTeardownTests,
  registerClaudeTurnAbortTests,
  registerClaudeTurnBindingTests,
  registerClaudeWarmSessionGuardTests,
  registerClaudeWarmSessionTests,
  registerCustomNodeTransportTest,
  registerExecutorPermissionTests,
  registerOperatorReminderDeliveryTests,
  registerPermissionDbUnavailableTests,
} from './test-suites';

// Enable the flag-gated flow and work-queue paths so the dispatch and permission paths run in tests.
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

/** The real SDK `query()` returns a Query synchronously; a spawn-time failure THROWS — it never
 * returns a rejected promise (the executor no longer awaits the call). */
const claudeQueryThrowOnce = (err: Error) =>
  claudeQueryMock.mockImplementationOnce(() => {
    throw err;
  });

// Project lookup moved to an inline getDatabase().select().from(projects).where().limit()
// Drizzle query (executor.ts:1633). This holder backs the chainable db mock; the row it holds
// is what that query resolves to.
const dbProjectState = vi.hoisted(() => ({
  projectRow: null as { id: string; name: string; path: string } | null,
}));
const USER_ABORT_ERROR_VARIANTS = [...USER_ABORT_ERROR_PATTERNS];

const dynamicChatServerMocks = vi.hoisted(() => ({
  bindChannelExecution: vi.fn(),
  setCurrentExecutionChat: vi.fn(() => 'exec-context-1'),
  clearCurrentExecutionChat: vi.fn(),
  getOrStartDynamicChatMcpUrl: vi.fn(async () => 'http://127.0.0.1:9999'),
  getLatestTaskSignal: vi.fn(),
  isTaskSignalDisarmed: vi.fn(() => false),
}));

/** Survives `vi.clearAllMocks()` — do not use `onPermissionResponse.mock.calls` (cleared each test). */
const clientPermissionBridge = vi.hoisted(() => ({
  lastResponseHandler: null as
    | ((response: {
        chatId: string;
        subChatId: string;
        requestId: string;
        approved: boolean;
        duration?: 'once' | 'always' | 'time-bound';
        hours?: number;
        timedOut?: boolean;
      }) => void)
    | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  // An execute abort ends its session through `close()`; a fake without one gets a no-op.
  query: (...args: Parameters<typeof claudeQueryMock>) => {
    const query = claudeQueryMock(...args);
    return Object.assign(query, { close: query.close ?? (() => {}) });
  },
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

vi.mock('../agent-runner', () => ({
  runCodexAgent: vi.fn(),
}));

vi.mock('../credentials/detect-codex', () => ({
  detectCodexAccount: vi.fn(() => ({
    available: true,
    displayName: 'Codex',
    sourcePath: 'codex-passthrough://local',
  })),
}));

const debugIngestMocks = vi.hoisted(() => ({
  startIngestServer: vi.fn(async () => 9876),
  registerDebugSession: vi.fn((sessionId: string) => ({
    endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
    logFilePath: `/tmp/project/.frink/debug/${sessionId}.ndjson`,
  })),
  unregisterDebugSession: vi.fn(),
  stopIngestServer: vi.fn(async () => {}),
}));

vi.mock('../debug-ingest/ingest-server', () => ({
  startIngestServer: debugIngestMocks.startIngestServer,
  registerDebugSession: debugIngestMocks.registerDebugSession,
  unregisterDebugSession: debugIngestMocks.unregisterDebugSession,
  stopIngestServer: debugIngestMocks.stopIngestServer,
}));

vi.mock('../claude', () => ({
  buildClaudeEnv: vi.fn(() => ({})),
  createTransformer: vi.fn(),
  getBundledClaudeBinaryPath: vi.fn(),
  clampEffortForBundledBinary: vi.fn((effort?: string) => effort),
  claudeVersionSupportsUltra: vi.fn(() => true),
}));
vi.mock('../cloud-client', () => ({
  denyBashPermission: vi.fn(),
  grantBashPermissionWithValidation: vi.fn(),
  isBashCommandApprovedInDb: vi.fn(),
  isBashCommandDeniedInDb: vi.fn(),
  recordBashPermissionUse: vi.fn(),
}));

// Phase 1 tasks migration: failed-task resume reads/writes go through local SQLite
// repo (db-first-arg), not cloud-client. Source: executor.ts resumeTaskOnFollowUpMessage.
// Run-liveness half of the signal-disarm check (the task-status half lives in the tasks mock below).
// Default: the signal target's run is still live, so arming is decided by task status alone — the
// path every pre-existing resume/disarm test asserts. Overridden per-test for the terminal-run case.
vi.mock('../db/repos/flow-runs', () => ({
  isFlowRunSignalDead: vi.fn(async () => false),
}));

vi.mock('../db/repos/tasks', () => ({
  getTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskResult: vi.fn(),
  // Pure predicate — mirror the real terminal-final set so disarm tests exercise real behavior.
  isTerminalFinalTaskStatus: (status: string) =>
    ['done', 'completed', 'cancelled'].includes(status),
  // Default: not flow-driven, so signalTaskId falls back to the pinned taskIdForExecution
  // (the degraded path every existing resume test relies on). Overridden per-test for the
  // driving≠pinned flow case.
  getFlowDriveInfoForSubChat: vi.fn(async () => ({
    active: false,
    autoApprovePlan: false,
    taskId: null,
  })),
  // Default: no terminal flow task on the sub-chat → the restart-interrupted resume branch is
  // skipped and the disarm path runs unchanged. Overridden per-test for the cancelled-resume case.
  getLatestFlowTaskForSubChat: vi.fn(async () => null),
  // Default: no flow briefing (interactive/non-flow). Injected into systemPrompt.append when set.
  getFlowBriefingForSubChat: vi.fn(async () => ''),
  // Teardown reconcile target — returns a task id so the wiring tests can assert the interrupted flag.
  cancelFlowTaskForSubChat: vi.fn(async () => 'flow-task-1'),
  parseResultRecord: (result: TaskResultRecord | null | undefined) => result ?? {},
}));

// Interruption-park target — wiring tests assert (subChatId, reason) land on the parking module.
vi.mock('../db/repos/task-parking', () => ({
  parkFlowTaskOnClaudeInterruption: vi.fn(async () => undefined),
}));

vi.mock('../db/repos/sub-chats', () => ({
  getSubChatById: vi.fn(async () => null),
  // Must return a promise: every call site chains `.catch()` on it (fire-and-forget persist).
  updateSubChatMode: vi.fn(async () => undefined),
  // Early session-id persist target (first metadata chunk, before finish).
  updateSubChatSession: vi.fn(async () => undefined),
}));

vi.mock('../flows/resume', () => ({
  // Default: no run is restart-interrupted, so a follow-up never takes the cancelled-resume branch.
  isRunRestartInterrupted: vi.fn(async () => false),
}));

// What a resume writes is covered in tasks/*.test.ts; here only which task is resumed, and when.
vi.mock('../tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tasks')>()),
  resumeParkedTaskInPlace: vi.fn(async () => true),
  reviveRestartInterruptedFlow: vi.fn(async () => undefined),
}));

vi.mock('../db/repos/chats', () => ({
  getChatWithProjectAccount: vi.fn(),
}));

// Phase 1.5: bash perm reads/writes go through local SQLite repo + getDatabase().
// Tests mock-stubbed cloud-client functions but production calls localPerms.* —
// without these mocks, getDatabase() tries to spin up a real SQLite at /mock/userData/data
// and tests crash. localPerms mocks default to "no row found" so existing test
// assertions (which expect prompt-user fallback) keep working unchanged.
vi.mock('../db', () => ({
  getDatabase: vi.fn(() => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(dbProjectState.projectRow ? [dbProjectState.projectRow] : []),
    };
    return builder as unknown;
  }),
}));

vi.mock('../db/repos/projects', () => ({
  getProjectById: vi.fn(async () => dbProjectState.projectRow),
  getProjectByPath: vi.fn(async () => null),
  listProjects: vi.fn(async () => []),
}));

vi.mock('../credentials', () => ({
  getClaudeCodeTokenById: vi.fn(),
  getDefaultClaudeCodeToken: vi.fn(),
  // Faithful to the real impl (credentials.ts): "resolved" = has a token OR is a passthrough row
  // (claude + codex are token-null by design; the provider binary reads its own credential store).
  // Both the spawn pre-flight and the project-override branch call this — keep them in step.
  isResolvedCredential: (
    cred: { token?: string | null; passthrough?: boolean } | null | undefined,
  ) => !!cred?.token || cred?.passthrough === true,
}));

vi.mock('../mcp/config', () => ({
  getGlobalMcpServers: vi.fn(() => []),
  getMcpCredentials: vi.fn(() => ({})),
}));

// sentry/init pulls @sentry/electron/main + `app` from electron; stub it so the suite loads.
vi.mock('../sentry/init', () => ({
  captureMainMessage: vi.fn(),
  captureMainException: vi.fn(),
}));

vi.mock('../mcp/dynamic-chat-server', () => dynamicChatServerMocks);

const quietMarkerMocks = vi.hoisted(() => ({
  setQuietEndMarker: vi.fn(),
  removeQuietEndMarker: vi.fn(),
}));
vi.mock('../db/repos/task-parking/quiet-marker', () => quietMarkerMocks);

vi.mock('../multi-project-prompt', () => ({
  getMultiProjectContext: vi.fn(),
}));

vi.mock('../frink-system-prompt', () => ({
  buildFrinkSystemPromptAppend: vi.fn(async () => '# Frink Platform\n(mock)'),
  FRINK_PLATFORM_BLOCK: '# Frink Platform\n(mock)',
}));

vi.mock('../permissions/v2/check', () => ({
  checkPermission: vi.fn(),
}));

vi.mock('../permissions/v2/store-local', () => ({
  addProjectRule: vi.fn(async () => undefined),
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
  onPermissionResponse: vi.fn((cb) => {
    clientPermissionBridge.lastResponseHandler = cb as NonNullable<
      typeof clientPermissionBridge.lastResponseHandler
    >;
    return () => {};
  }),
  sendErrorDirect: vi.fn(),
  sendExecuteCompleteDirect: vi.fn(),
  sendPermissionRequest: vi.fn(),
  sendPermissionDismiss: vi.fn(),
  sendStreamSettledDirect: vi.fn(),
  sendStreamChunkDirect: vi.fn(),
  sendSubChatModeChange: vi.fn(),
  sendWakeHoldChanged: vi.fn(),
}));

import { filterCanonicalPlanParts } from '../../../shared/plan-parts-filter';
import { runCodexAgent } from '../agent-runner';
import { createTransformer, getBundledClaudeBinaryPath } from '../claude';
import type { UIMessageChunk } from '../claude/types';
import { getClaudeCodeTokenById, getDefaultClaudeCodeToken } from '../credentials';
import { getChatWithProjectAccount } from '../db/repos/chats';
import { isFlowRunSignalDead } from '../db/repos/flow-runs';
import { updateSubChatMode, updateSubChatSession } from '../db/repos/sub-chats';
import { parkFlowTaskOnClaudeInterruption } from '../db/repos/task-parking';
import {
  cancelFlowTaskForSubChat,
  getFlowBriefingForSubChat,
  getFlowDriveInfoForSubChat,
  getLatestFlowTaskForSubChat,
  getTaskById,
  updateTaskStatus,
} from '../db/repos/tasks';
import { isRunRestartInterrupted } from '../flows/resume';
import { getGlobalMcpServers, getMcpCredentials } from '../mcp/config';
import * as dynamicChatServer from '../mcp/dynamic-chat-server';
import { channelOwner } from '../mcp/execution-identity';
import { getMultiProjectContext } from '../multi-project-prompt';
import * as toolValidation from '../permissions/tool-validation';
import { checkPermission } from '../permissions/v2/check';
import { resumeParkedTaskInPlace, reviveRestartInterruptedFlow } from '../tasks';
import type { MessagePart } from './client';
import type { PlanFallbackSend } from './executor';
import { applyApprovedPlanContextToPrompt } from './execution/prompt-prefix/approved-plan-prompt';
import { FLOW_BRIEFING_PROVENANCE_NOTE } from './execution/prompt-prefix/flow-briefing-section';
import {
  shouldSuppressExitPlanModeToolChunk,
  shouldSuppressNativePlanStreamChunk,
  shouldSuppressNativePlanToolChunk,
  shouldSuppressPlanTextChunk,
} from './streaming/plan-mode-suppression';

/** Reset v2 permission check mock — `mockResolvedValue` survives `clearAllMocks`. Default: allow. */
function stubPermissionsStoreDefault() {
  vi.mocked(checkPermission).mockResolvedValue({ decision: 'allow' });
}

import {
  applyChunkToParts,
  buildPartsFromChunks,
  createPartsState,
  partsSnapshot,
} from './claude-turn-context';
import * as socketClient from './client';
import {
  _clearActiveExecutionsForTests,
  _extractImagePartsFromMessageForTests,
  _getActiveExecutionCountForTests,
  _hasActiveExecutionForTests,
  _registerExecutionForTests,
  _resetExecutorStateForTests,
  abortActiveExecutionsForWebContents,
  buildPlanFallbackSends,
  clearCodexSession,
  drainPendingPermissions,
  emitPlanFallbackSends,
  extractNativePlanPathFromChunks,
  getClaudeSessionPlansDir,
  handleRemoteExecute,
  handleRemoteStop,
  hasPendingPermissionRequest,
  isAllowedClaudePlanWritePath,
  pauseActiveExecutionForSubChat,
  validateToolPermission,
} from './executor';
import {
  claudePromptText,
  getPreToolUseHook,
  type PreToolUseHook,
  type PreToolUseQueryInput,
  stopHookQuery,
  userPromptSubmitReminder,
} from './test-utils';

// The invariant middle of the handleRemoteExecute describe blocks' beforeEach. Each block's
// own prefix (clearAllMocks/reset/state) and suffix (credential/provider mocks) stay inline.
function applyExecutorMockDefaults(
  machineId: string,
  project: NonNullable<typeof dbProjectState.projectRow>,
) {
  dbProjectState.projectRow = project;
  vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
  vi.mocked(getMultiProjectContext).mockResolvedValue({
    promptPrefix: '',
    dynamicChatMcpUrl: null,
  });
  vi.mocked(getBundledClaudeBinaryPath).mockReturnValue('/mock/bin/claude');
}

/** What each spawned CLI's UserPromptSubmit hook injected, fired as the CLI reads its prompt: a
 * kept session detaches its turn once the turn ends, so a read after the execute sees none. */
const firedReminders = new WeakMap<object, string | undefined>();
async function firePromptSubmit(input: object): Promise<void> {
  firedReminders.set(input, await userPromptSubmitReminder(input));
}

// CLAUDE_CONFIG_DIR isolation creates dirs under app.getPath('userData') (/mock/userData).
// Re-stub after clearAllMocks.
beforeEach(() => {
  stubPermissionsStoreDefault();
  dbProjectState.projectRow = null;
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'symlinkSync').mockReturnValue(undefined);
  vi.spyOn(fs.promises, 'writeFile').mockResolvedValue().mockClear();
  vi.spyOn(fs.promises, 'chmod').mockResolvedValue().mockClear();
  vi.spyOn(fs.promises, 'rm').mockResolvedValue().mockClear();
});

describe('isAllowedClaudePlanWritePath', () => {
  it('allows writes under ~/.claude/plans', () => {
    expect(isAllowedClaudePlanWritePath('/mock/home/.claude/plans/a.md', 'any-id')).toBe(true);
  });

  it('allows writes under session plans when subChatId matches path', () => {
    const sid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    expect(
      isAllowedClaudePlanWritePath(`/mock/userData/claude-sessions/${sid}/plans/p.md`, sid),
    ).toBe(true);
  });

  it('denies session plan path when subChatId does not match', () => {
    const sid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    expect(
      isAllowedClaudePlanWritePath(
        `/mock/userData/claude-sessions/${sid}/plans/p.md`,
        'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22',
      ),
    ).toBe(false);
  });
});

describe('getClaudeSessionPlansDir', () => {
  const validSid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  it('returns a resolved path under userData/claude-sessions/<id>/plans', () => {
    expect(getClaudeSessionPlansDir(validSid)).toBe(
      path.resolve('/mock/userData', 'claude-sessions', validSid, 'plans'),
    );
  });

  it('throws when subChatId is empty', () => {
    expect(() => getClaudeSessionPlansDir('')).toThrow(/required/);
  });

  it('throws when subChatId contains path traversal', () => {
    expect(() => getClaudeSessionPlansDir(`${validSid}..`)).toThrow(/path traversal/);
    expect(() => getClaudeSessionPlansDir(`..${validSid}`)).toThrow(/path traversal/);
  });

  it('throws when subChatId contains a path separator', () => {
    expect(() => getClaudeSessionPlansDir(`${validSid}/x`)).toThrow(/path separators/);
    expect(() => getClaudeSessionPlansDir(`x\\${validSid}`)).toThrow(/path separators/);
  });

  it('accepts a cuid2-shaped id (no longer UUID-strict post-migration)', () => {
    const cuid = 'mokno4jiwil9h117';
    expect(getClaudeSessionPlansDir(cuid)).toBe(
      path.resolve('/mock/userData', 'claude-sessions', cuid, 'plans'),
    );
  });

  it('throws when subChatId has unsafe characters', () => {
    expect(() => getClaudeSessionPlansDir('bad id with spaces')).toThrow(/Invalid subChatId/);
    expect(() => getClaudeSessionPlansDir('has@symbol#chars')).toThrow(/Invalid subChatId/);
  });
});

describe('socket file permission edge cases', () => {
  const machineId = 'machine-perm';
  const project = {
    id: 'project-perm-1',
    user_id: 'user-1',
    name: 'Perm Project',
    path: '/tmp/project-perm',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-perm-1',
    subChatId: '11111111-1111-4111-8111-111111111111',
    projectId: project.id,
    mode: 'agent' as const,
    assistantMessageId: 'assistant-perm-1',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  function getRegisteredPermissionResponseHandler():
    | ((response: {
        chatId: string;
        subChatId: string;
        requestId: string;
        approved: boolean;
        duration?: 'once' | 'always' | 'time-bound';
        hours?: number;
        timedOut?: boolean;
      }) => void)
    | null {
    return clientPermissionBridge.lastResponseHandler;
  }

  type QueuedPermissionRequest = {
    chatId: string;
    subChatId: string;
    requestId: string;
    type: 'file' | 'bash' | 'mcp_tool';
    path: string;
    operation: 'read' | 'write' | 'delete' | 'bash' | 'mcp_tool';
    reason?: string;
    patternChoices?: string[];
    toolName?: string;
    projectName?: string;
    projectPath?: string;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
    vi.mocked(getTaskById).mockResolvedValue(null);
    // Resolve a row by default: the follow-up resume treats null as a lost CAS (skip side-effects).
    vi.mocked(updateTaskStatus).mockResolvedValue({ id: 'task-row' } as Awaited<
      ReturnType<typeof updateTaskStatus>
    >);
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
    vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockImplementation(
      (pathValue) => pathValue,
    );

    // Default: auto-approve all permission requests.
    vi.mocked(socketClient.sendPermissionRequest).mockImplementation((payload) => {
      const handler = getRegisteredPermissionResponseHandler();
      if (!handler) return;
      handler({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        requestId: payload.requestId,
        approved: true,
        duration: 'always',
      });
    });
  });

  it('uses Claude native Auto Mode and delegates only the v2 ask residual', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    // SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    let hookResult: Awaited<ReturnType<PreToolUseHook>> | undefined;
    claudeQueryMock.mockImplementationOnce(async function* (queryInput: PreToolUseQueryInput) {
      const input = queryInput;
      expect(input.options?.permissionMode).toBe('auto');
      expect(input.options?.env?.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe('1');

      hookResult = await getPreToolUseHook(queryInput)(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
        'tool-auto-1',
      );
      yield { type: 'result', chunks: [{ type: 'finish' }] };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run the tests',
      settings: { model: 'sonnet', autoReviewTools: true },
    });

    expect(hookResult).toEqual({});
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('abstains for a vendor plugin MCP tool too — the hook layer carries no tool-class exception', async () => {
    // Guards the seam one layer up: a plugin condition reintroduced in the hook would card again.
    const { checkPermission } = await import('../permissions/v2/check');
    // SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    const hookInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__plugin_slack_slack__chat_post_message',
      tool_input: {},
    };
    let hookResult: Awaited<ReturnType<PreToolUseHook>> | undefined;
    claudeQueryMock.mockImplementationOnce(async function* (queryInput: PreToolUseQueryInput) {
      hookResult = await getPreToolUseHook(queryInput)(hookInput, 'tool-plugin-auto-1');
      yield { type: 'result', chunks: [{ type: 'finish' }] };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'post to slack',
      settings: { model: 'sonnet', autoReviewTools: true },
    });

    expect(hookResult).toEqual({});
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });

  registerCustomNodeTransportTest({
    basePayload,
    claudeQueryMock,
    handleRemoteExecute,
    socketClient,
  });

  it('a consenting PLAN turn opens in plan mode and, once armed on the first frame, abstains to the reviewer', async () => {
    // The renderer sends Auto consent for plan turns; the turn opens in `permissionMode: 'plan'`
    // (read-only from t=0). On the first live frame armAutoDuringPlan arms the during-plan classifier
    // (plan→default→plan flip, opt-in first) and sets the abstain flag, so from then on an ask-bucket
    // tool returns `{}` — the hook defers to the classifier (the canUseTool deny-floor backstops it if
    // the classifier is inactive), rather than blanket-allowing or reaching a human.
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValue({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    let spawnMode: string | undefined;
    let hookResult: Awaited<ReturnType<PreToolUseHook>> | undefined;
    claudeQueryMock.mockImplementationOnce((queryInput: PreToolUseQueryInput) => {
      spawnMode = (queryInput as { options?: { permissionMode?: string } }).options?.permissionMode;
      const gen = (async function* () {
        // First live frame — armAutoDuringPlan runs on this, arming the reviewer + abstain flag.
        yield { type: 'system', chunks: [] };
        hookResult = await getPreToolUseHook(queryInput)(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
          },
          'tool-plan-1',
        );
        yield { type: 'result', chunks: [{ type: 'finish' }] };
      })();
      return Object.assign(gen, {
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode,
        applyFlagSettings,
      });
    });

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan' as const,
      message: 'plan the work',
      settings: { model: 'sonnet', autoReviewTools: true },
    });

    // Opens in 'plan' (never the permissive 'auto'), the opt-in is applied, and after arming the hook
    // abstains ({}) so the during-plan classifier decides — not a human prompt, not a blanket allow.
    expect(spawnMode).toBe('plan');
    expect(applyFlagSettings).toHaveBeenCalledWith({ skipAutoPermissionPrompt: true });
    expect(hookResult).toEqual({});
  });

  it('streams the prompt through an input queue and closes it at turn end so stdin stays open all turn', async () => {
    // The permission control channel is the CLI's stdin, kept open by an unfinished streaming-input
    // queue. This turn has no task-signal Stop hook (dynamicChatMcpUrl is null), so the executor must
    // close the queue on the first `result` frame — keeping stdin open through the whole turn, then
    // releasing it. If the queue were NOT closed, iterating `prompt` below would hang (the leak).
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { type: 'assistant', chunks: [{ type: 'text-delta', delta: 'hi' }] };
      yield { type: 'result', chunks: [{ type: 'finish' }] };
    });

    await handleRemoteExecute({ ...basePayload, message: 'hello world' });

    const call = claudeQueryMock.mock.calls[0][0] as {
      prompt: AsyncIterable<{ type: string; message: { content: unknown } }>;
    };
    // Prompt is a streaming AsyncIterable now, not a bare string.
    expect(typeof (call.prompt as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBe(
      'function',
    );

    // Exactly the initial user turn (string content — parity with the pre-streaming string prompt),
    // and the loop terminates, proving the executor closed the queue at turn end (no leaked stdin).
    const seen: Array<{ type: string; content: unknown }> = [];
    for await (const m of call.prompt) {
      seen.push({ type: m.type, content: m.message.content });
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('user');
    expect(typeof seen[0].content).toBe('string');
    expect(seen[0].content).toContain('hello world');
  });

  it('the input queue survives the Stop-hook allow and closes only at post-turn disposal', async () => {
    // Evolution of the "Stream closed" fix: the queue (the CLI's stdin / control channel) now
    // outlives the WHOLE turn — the Stop-hook allow no longer closes it, because closing kills
    // pending background work and the harness wake (the CLI stops backgrounded tasks on stdin
    // close). With nothing pending, the post-turn disposition (armOrDisposeClaudeSession) ends
    // the session, which is the only closer.
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    mockPinnedTaskChat('task-onallow-close', { status: 'running' });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue({
      state: 'awaiting_input',
      summary: 'done',
      at: new Date().toISOString(),
    });

    const promptCapture: { iterator?: AsyncIterator<unknown> } = {};
    claudeQueryMock.mockImplementationOnce(async function* (queryInput: PreToolUseQueryInput) {
      const input = queryInput as {
        prompt: AsyncIterable<unknown>;
        options?: { hooks?: { Stop?: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> } };
      };
      const stopHook = input.options?.hooks?.Stop?.[0]?.hooks?.[0];
      expect(stopHook).toBeTypeOf('function'); // armed chat → Stop hook mounted
      promptCapture.iterator = input.prompt[Symbol.asyncIterator]();
      await promptCapture.iterator.next(); // consume the buffered initial turn (queue still open)
      // Signal present → the hook allows without forcing a continuation…
      const allow = await stopHook?.({ hook_event_name: 'Stop', stop_hook_active: false });
      expect(allow).toEqual({});
      yield {
        type: 'result',
        chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-onallow' } }],
      };
    });

    await handleRemoteExecute({ ...basePayload, message: 'do the task' });

    // …and only the post-turn disposal (nothing pending) closed the queue.
    const promptIterator = promptCapture.iterator;
    if (!promptIterator) throw new Error('Expected the prompt iterator to be captured');
    expect((await promptIterator.next()).done).toBe(true);
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined); // avoid leaking to next test
  });

  // ── Wake hold: pending background work keeps the CLI alive; the harness wake streams ──

  /** See {@link stopHookQuery}: turn 1 reports pending work via the Stop hook, the stream stays
   * OPEN for wake bursts. Registers the impl on `claudeQueryMock` and returns the handle. */
  function mockHoldableQuery(
    backgroundTasks: unknown[] = [
      { id: 'bg1', type: 'shell', status: 'running', description: 'coverage run' },
    ],
    opts: { sessionId?: string; prelude?: unknown[]; wakeText?: string } = {},
  ) {
    const handle = stopHookQuery({
      sessionId: opts.sessionId ?? 'sess-wake-hold',
      backgroundTasks,
      prelude: opts.prelude,
      wakeText: opts.wakeText ?? 'coverage finished — proceeding',
      interrupt: vi.fn().mockResolvedValue(undefined),
    });
    claudeQueryMock.mockImplementationOnce(handle.impl);
    return handle;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const mockMcpContext = () =>
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });

  it('holds the session on pending background work and streams the wake into the arming message', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    mockPinnedTaskChat('task-wake-hold', { status: 'running' });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    const query = mockHoldableQuery();

    await handleRemoteExecute({ ...basePayload, message: 'run coverage and wait' });
    await settle();

    const clientModule = await import('./client');
    const completesBefore = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls.length;

    // The harness wakes on its own — no user input, no new execute.
    query.emitWake();
    await settle();

    const streamCalls = vi
      .mocked(clientModule.sendStreamChunkDirect)
      .mock.calls.map((c) => c[0] as { assistantMessageId: string; chunk: { type: string } });
    const wakeChunk = streamCalls.find((c) => c.chunk.type === 'text-delta');
    expect(wakeChunk).toBeDefined();
    // The wake extends the turn it woke from. A separate id per wake made one wait render as
    // several collapsed step bars, each with its own action row and its own claimed final answer.
    expect(wakeChunk?.assistantMessageId).toBe(basePayload.assistantMessageId);

    const completes = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completes.length).toBe(completesBefore + 1);
    expect((completes.at(-2)?.[0] as { continuesWakeHold?: boolean }).continuesWakeHold).toBe(true);
    expect((completes.at(-1)?.[0] as { assistantMessageId?: string }).assistantMessageId).toBe(
      wakeChunk?.assistantMessageId,
    );

    query.endStream(); // CLI ends → pump exits → session disposed
    await settle();
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
  });

  it('holds the session when the turn entered plan mode mid-turn, with the lock carried into the burst', async () => {
    // Mid-turn EnterPlanMode used to hard-close the session at turn end, killing live background
    // work. Plan turns now arm the pump — safe because burst contexts INHERIT the arming turn's
    // planTerminalsLocked instead of defaulting it false.
    mockMcpContext();
    mockPinnedTaskChat('task-plan-no-hold', { status: 'running' });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);

    const planEnter = {
      type: 'tool-input-available',
      toolCallId: 'c1',
      toolName: 'EnterPlanMode',
      input: {},
    };
    const handle = mockHoldableQuery(undefined, {
      sessionId: 'sess-plan-no-hold',
      wakeText: 'back from plan',
      prelude: [{ chunks: [planEnter] }],
    });

    await handleRemoteExecute({ ...basePayload, message: 'look into this then plan it' });
    await settle();

    const clientModule = await import('./client');
    const before = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls.length;
    handle.emitWake();
    await settle();

    // The pump armed: the wake burst streams into the arming turn's message.
    const after = vi
      .mocked(clientModule.sendStreamChunkDirect)
      .mock.calls.slice(before)
      .map((c) => c[0] as { assistantMessageId: string; chunk: { type: string } })
      .filter((c) => c.chunk.type === 'text-delta');
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]?.assistantMessageId).toBe(basePayload.assistantMessageId);

    const { getSession } = await import('./claude-session-registry');
    const burstTurn = getSession(basePayload.subChatId)?.currentTurn;
    expect(burstTurn?.planTerminalsLocked).toBe(true);
    expect(burstTurn?.isWakeBurst).toBe(true);

    handle.endStream();
    await settle();
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
  });

  it('holds a turn that STARTED in plan mode when background subagents are still running', async () => {
    // A plan-drafting chat launches background research agents and stops to wait. A plan-mode
    // dispose here would close stdin, and the CLI kills live backgrounded agents on stdin close.
    mockMcpContext();
    mockPinnedTaskChat('task-plan-agents-hold', { status: 'running' });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    const handle = mockHoldableQuery(
      [
        { id: 'a1', type: 'subagent', status: 'running', description: 'Explore settings UI' },
        { id: 'a2', type: 'subagent', status: 'running', description: 'Explore usage data' },
      ],
      { sessionId: 'sess-plan-agents', wakeText: 'agent reported' },
    );

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan' as const,
      message: 'research with two background agents, wait for both, then draft the plan',
    });
    await settle();

    const clientModule = await import('./client');
    const before = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls.length;
    handle.emitWake();
    await settle();

    const after = vi
      .mocked(clientModule.sendStreamChunkDirect)
      .mock.calls.slice(before)
      .map((c) => c[0] as { assistantMessageId: string; chunk: { type: string } })
      .filter((c) => c.chunk.type === 'text-delta');
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]?.assistantMessageId).toBe(basePayload.assistantMessageId);

    // The held wait keeps its quiet-end marker — the renderer reads it to defer the transition.
    expect(quietMarkerMocks.setQuietEndMarker).toHaveBeenCalledWith(
      expect.anything(),
      'task-plan-agents-hold',
      expect.any(String),
    );

    handle.endStream();
    await settle();
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
  });

  it('does not quiet-mark a plan turn ending with nothing pending — the plan machinery owns it', async () => {
    // The amendment shape (plan file rewritten, no ExitPlanMode): a quiet-end marker here would
    // defer the renderer's plan_ready transition to a sweep that nothing re-triggers.
    mockMcpContext();
    mockPinnedTaskChat('task-plan-amend', { status: 'running' });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    const handle = mockHoldableQuery([], { sessionId: 'sess-plan-amend' });

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan' as const,
      message: 'tighten step 3 of the plan',
    });
    await settle();

    expect(quietMarkerMocks.setQuietEndMarker).not.toHaveBeenCalled();
    handle.endStream();
  });

  registerClaudeTurnBindingTests({
    basePayload,
    claudeQueryMock,
    clientPermissionBridge,
    handleRemoteExecute,
  });
  registerClaudeTurnAbortTests({ basePayload, claudeQueryMock, handleRemoteExecute });
  registerClaudeSessionTeardownTests({ basePayload, claudeQueryMock, handleRemoteExecute });
  registerClaudeSessionCallbackTests({ basePayload, claudeQueryMock, handleRemoteExecute });
  registerClaudeWarmSessionTests({ basePayload, claudeQueryMock, handleRemoteExecute });
  registerClaudeWarmSessionGuardTests({ basePayload, claudeQueryMock, handleRemoteExecute });
  registerClaudePrewarmTests({ basePayload, claudeQueryMock, handleRemoteExecute });

  it('pauseActiveExecutionForSubChat releases a wake hold (Stop works while nothing is executing)', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    mockPinnedTaskChat('task-wake-pause', { status: 'running' });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    const query = mockHoldableQuery();

    await handleRemoteExecute({ ...basePayload, message: 'run coverage and wait' });
    await settle();

    // No activeExecutions record exists any more — the hold IS the active work.
    expect(pauseActiveExecutionForSubChat(basePayload.subChatId)).toBe(true);
    query.endStream(); // released hold closed stdin; the CLI exits
    await settle();
    // A second pause finds nothing to stop.
    expect(pauseActiveExecutionForSubChat(basePayload.subChatId)).toBe(false);
  });

  it('starts a turn whose tools are decided by the permission rules', async () => {
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { type: 'result', chunks: [{ type: 'finish' }] };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run with no account',
    });
    await settle();

    expect(claudeQueryMock).toHaveBeenCalled();
    expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Not authenticated' }),
    );
  });

  it('resumes a failed task before execution', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce({
      state: 'done',
      summary: 'Resume succeeded',
      at: new Date().toISOString(),
    });
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-resume-1' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'task-resume-1',
      status: 'failed',
      result: {
        agentSignal: { state: 'failed', summary: 'Old failure' },
        error: 'Old error',
        existing: 'keep-me',
      },
    } as Awaited<ReturnType<typeof getTaskById>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-resume-1' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'follow-up message after failure',
    });

    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-resume-1', status: 'failed' }),
      'follow_up_message',
      basePayload.subChatId,
    );
    expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
  });

  it('flow follow-up resumes the DRIVING plan task (not the pinned task) and keeps plan mode', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    // Pinned/first task on the chat is an already-completed upstream node.
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'pinned-evaluate-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    // The flow is actively driving THIS sub-chat via a different (plan) task.
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'driving-plan-task',
    });
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'driving-plan-task',
      status: 'needs_attention',
      flowRunId: 'fr-1',
      nodeRunId: 'nr-1',
      result: {
        startMode: 'plan',
        agentSignal: { state: 'awaiting_input', summary: 'Which package manager should I assume?' },
      },
    } as Awaited<ReturnType<typeof getTaskById>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-flow-resume' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'bun' });

    // Resume targets the DRIVING task, never the pinned (already-done) one. Answering a question is
    // NOT plan approval, so the sub-chat's plan permission-mode persists.
    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'driving-plan-task' }),
      'follow_up_message',
      basePayload.subChatId,
    );
    expect(vi.mocked(updateSubChatMode)).not.toHaveBeenCalled();
  });

  it('flow follow-up on a debug-mode park also keeps the mode (mode persists generally)', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'pinned-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'driving-debug-task',
    });
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'driving-debug-task',
      status: 'needs_attention',
      flowRunId: 'fr-1',
      nodeRunId: 'nr-1',
      result: {
        startMode: 'debug',
        agentSignal: { state: 'awaiting_input', summary: 'Can you reproduce the crash?' },
      },
    } as Awaited<ReturnType<typeof getTaskById>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-debug-resume' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'yes, on save' });

    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'driving-debug-task' }),
      'follow_up_message',
      basePayload.subChatId,
    );
    expect(vi.mocked(updateSubChatMode)).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: 'Codex',
      credential: {
        token: null,
        isApiKey: false,
        type: 'codex' as const,
        label: 'codex-test',
        passthrough: true,
      },
    },
  ])(
    '$provider resumes and unparks before provider execution, then persists its task signal',
    async ({ provider, credential }) => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(credential);
      vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
        chat: { taskId: 'pinned-upstream-task' },
        account: null,
      } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
      vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
        active: true,
        autoApprovePlan: false,
        taskId: 'driving-paused-task',
      });
      vi.mocked(getMultiProjectContext).mockResolvedValueOnce({
        promptPrefix: '',
        dynamicChatMcpUrl: 'http://127.0.0.1:9999/mcp',
      });
      vi.mocked(getTaskById)
        .mockResolvedValueOnce({
          id: 'driving-paused-task',
          status: 'needs_attention',
          flowRunId: 'flow-run-1',
          nodeRunId: 'node-run-1',
          result: {
            subChatId: basePayload.subChatId,
            userPause: { at: '2026-07-24T12:00:00.000Z' },
          },
        } as Awaited<ReturnType<typeof getTaskById>>)
        .mockResolvedValueOnce({
          id: 'driving-paused-task',
          status: 'running',
          flowRunId: 'flow-run-1',
          nodeRunId: 'node-run-1',
          result: { subChatId: basePayload.subChatId },
        } as Awaited<ReturnType<typeof getTaskById>>)
        .mockResolvedValue({
          id: 'driving-paused-task',
          status: 'running',
          flowRunId: 'flow-run-1',
          nodeRunId: 'node-run-1',
          result: { subChatId: basePayload.subChatId },
        } as Awaited<ReturnType<typeof getTaskById>>);
      dynamicChatServerMocks.getLatestTaskSignal.mockReset();
      dynamicChatServerMocks.getLatestTaskSignal.mockReturnValue({
        state: 'done',
        summary: `${provider} completed the resumed step`,
        at: '2026-07-24T12:00:05.000Z',
      });

      const runner = vi.mocked(runCodexAgent);
      runner.mockImplementationOnce(async function* () {
        yield {
          type: 'finish',
          messageMetadata: { sessionId: `${provider.toLowerCase()}-session` },
        } as UIMessageChunk;
      });

      await handleRemoteExecute({
        ...basePayload,
        message: 'resume the paused flow',
      });

      expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'driving-paused-task', nodeRunId: 'node-run-1' }),
        'follow_up_message',
        basePayload.subChatId,
      );
      expect(vi.mocked(resumeParkedTaskInPlace).mock.invocationCallOrder[0]).toBeLessThan(
        runner.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(vi.mocked(dynamicChatServer.getLatestTaskSignal)).toHaveBeenCalledWith(
        'exec-context-1',
      );
      expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(
        expect.anything(),
        'driving-paused-task',
        'done',
        expect.objectContaining({ expectStatuses: ['running', 'failed'] }),
      );
      expect(dynamicChatServer.clearCurrentExecutionChat).toHaveBeenCalledWith('exec-context-1');
      expect(vi.mocked(updateTaskStatus).mock.invocationCallOrder.at(-1)).toBeLessThan(
        vi.mocked(dynamicChatServer.clearCurrentExecutionChat).mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
      dynamicChatServerMocks.getLatestTaskSignal.mockReset();
      dynamicChatServerMocks.getLatestTaskSignal.mockReturnValue(undefined);
    },
  );

  /** Mock the chat row pinned to `taskId` plus the pinned task row itself (null = deleted row). */
  function mockPinnedTaskChat(taskId: string, row: { status: string; result?: unknown } | null) {
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockResolvedValueOnce(
      (row ? { id: taskId, result: {}, ...row } : null) as Awaited<ReturnType<typeof getTaskById>>,
    );
  }

  /** Mock one Claude turn whose stream finishes immediately. */
  function mockClaudeFinishTurn(sessionId: string) {
    claudeQueryMock.mockImplementationOnce(async function* (input: object) {
      await firePromptSubmit(input);
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId } }] };
      yield { type: 'result' };
    });
  }

  /** The taskSignalEnabled flag threaded into a setCurrentExecutionChat registration. */
  function taskSignalEnabledArg(callIndex: number): unknown {
    const calls = vi.mocked(dynamicChatServer.setCurrentExecutionChat).mock.calls;
    return calls.at(callIndex)?.[6];
  }

  it('disarms task signal when nothing drives the chat and the pinned task is done', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    // Pinned fallback task is terminal-final — the flow that spawned this chat already completed.
    mockPinnedTaskChat('finished-flow-task', {
      status: 'done',
      result: { agentSignal: { state: 'done', summary: 'Flow finished' } },
    });
    mockClaudeFinishTurn('sess-disarm-1');

    await handleRemoteExecute({ ...basePayload, message: 'follow-up after the flow completed' });

    // Registered disarmed (taskSignalEnabled=false): frink_task_signal calls are refused.
    expect(taskSignalEnabledArg(-1)).toBe(false);
    // The dead task is never resumed or touched.
    expect(vi.mocked(resumeParkedTaskInPlace)).not.toHaveBeenCalled();
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalled();
  });

  it('disarms task signal when the pinned task row was deleted (work-queue bulk delete)', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    // The chat's pinned task was removed (e.g. history bulk delete) — chats.taskId dangles.
    // Nothing can consume a signal for a missing row, so the apparatus must disarm.
    mockPinnedTaskChat('deleted-history-task', null);
    mockClaudeFinishTurn('sess-disarm-4');

    await handleRemoteExecute({ ...basePayload, message: 'follow-up after task deletion' });

    expect(taskSignalEnabledArg(-1)).toBe(false);
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalled();
  });

  it('keeps task signal armed for a failed pinned task (chat-reply resume surface)', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('task-failed-armed', { status: 'failed' });
    mockClaudeFinishTurn('sess-disarm-2');

    await handleRemoteExecute({ ...basePayload, message: 'carry on' });

    expect(taskSignalEnabledArg(-1)).toBe(true);
    // Resume still runs on the task (the single prefetched read feeds both checks).
    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-failed-armed' }),
      'follow_up_message',
      basePayload.subChatId,
    );
  });

  // The single-agent-node case: chats.taskId IS the parked task, so the pinned fallback resolves to
  // the same needs_attention row. Task status alone can never disarm it (needs_attention is
  // deliberately resumable), so before the run-liveness check the Stop hook stayed armed and blocked
  // ordinary interactive turns after the user stopped the flow.
  it('disarms a parked pinned task once its run is terminal (single-agent-node flow after Stop)', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('parked-single-node-task', {
      status: 'needs_attention',
      result: { subChatId: 'sub-1' },
    });
    vi.mocked(getTaskById).mockImplementation(
      async () =>
        ({
          id: 'parked-single-node-task',
          status: 'needs_attention',
          flowRunId: 'fr-cancelled',
          result: { subChatId: 'sub-1' },
        }) as Awaited<ReturnType<typeof getTaskById>>,
    );
    vi.mocked(isFlowRunSignalDead).mockResolvedValueOnce(true);
    mockClaudeFinishTurn('sess-disarm-terminal-run');

    await handleRemoteExecute({ ...basePayload, message: 'are you in flow mode now?' });

    expect(taskSignalEnabledArg(-1)).toBe(false);
    // Nothing is resumed — the run is over, so there is no signal for the agent to land.
    expect(vi.mocked(resumeParkedTaskInPlace)).not.toHaveBeenCalled();
    vi.mocked(getTaskById).mockReset();
  });

  // The negative of the above: `paused`/`failed` runs are chat-reply resume surfaces, so the same
  // parked task must stay armed for them (isFlowRunSignalDead returns false by default here).
  it('keeps a parked pinned task armed while its run is still live', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('parked-live-run-task', {
      status: 'needs_attention',
      result: { subChatId: 'sub-1' },
    });
    mockClaudeFinishTurn('sess-armed-live-run');

    await handleRemoteExecute({ ...basePayload, message: 'bun' });

    expect(taskSignalEnabledArg(-1)).toBe(true);
    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parked-live-run-task' }),
      'follow_up_message',
      basePayload.subChatId,
    );
  });

  it('flow follow-up REVIVES a restart-interrupted (cancelled) run in place — armed, no re-dispatch', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'cancelled-driving-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: false,
      autoApprovePlan: false,
      taskId: null,
    });
    // Newest flow task on the sub-chat is a cancelled driving task whose run was restart-interrupted.
    vi.mocked(getLatestFlowTaskForSubChat).mockResolvedValueOnce({
      id: 'cancelled-driving-task',
      status: 'cancelled',
      flowRunId: 'fr-restart',
    });
    vi.mocked(isRunRestartInterrupted).mockResolvedValueOnce(true);
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'cancelled-driving-task',
      status: 'cancelled',
      flowRunId: 'fr-restart',
      nodeRunId: 'nr-restart',
      result: { cancelled: true, error: 'Interrupted by app restart', subChatId: 'sub-1' },
    } as Awaited<ReturnType<typeof getTaskById>>);
    mockClaudeFinishTurn('sess-restart-resume');

    await handleRemoteExecute({ ...basePayload, message: 'carry on - limit resolved' });

    // A restart-interrupted resume is NOT a dead chat — the signal apparatus stays armed.
    expect(taskSignalEnabledArg(-1)).toBe(true);
    // Reaching the revive with this run's ids is what this test owns; what the revive then WRITES
    // (status flip, marker scrub, linkage) is covered directly in revive-interrupted-flow.test.ts.
    expect(vi.mocked(reviveRestartInterruptedFlow)).toHaveBeenCalledWith(
      'cancelled-driving-task',
      'fr-restart',
      basePayload.subChatId,
    );
  });

  it('flow follow-up does NOT revive a USER-cancelled run (no marker) — disarms, no resume', async () => {
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'user-cancelled-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: false,
      autoApprovePlan: false,
      taskId: null,
    });
    // Newest flow task is cancelled, but the run was cancelled by the USER (no restart marker).
    vi.mocked(getLatestFlowTaskForSubChat).mockResolvedValueOnce({
      id: 'user-cancelled-task',
      status: 'cancelled',
      flowRunId: 'fr-user',
    });
    vi.mocked(isRunRestartInterrupted).mockResolvedValueOnce(false);
    // Disarm path reads the pinned (terminal-final cancelled) task.
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'user-cancelled-task',
      status: 'cancelled',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    mockClaudeFinishTurn('sess-user-cancel');

    await handleRemoteExecute({ ...basePayload, message: 'carry on' });

    // Marker gate held: no in-place revive, no task flip, and the dead chat disarms its signal.
    expect(vi.mocked(reviveRestartInterruptedFlow)).not.toHaveBeenCalled();
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalled();
    expect(taskSignalEnabledArg(-1)).toBe(false);
  });

  it('disarms task signal on the codex provider path (flag threaded before the provider branch)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    mockPinnedTaskChat('finished-flow-task', { status: 'done' });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-disarm' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex follow-up after flow completed' });

    // First registration threads the flag; later re-calls on the same executionId omit it and
    // inherit (inheritance unit-tested in dynamic-chat-server tests).
    expect(taskSignalEnabledArg(0)).toBe(false);
    expect(vi.mocked(resumeParkedTaskInPlace)).not.toHaveBeenCalled();
  });

  it('prepends the disarmed reminder to the prompt on the Codex path (no in-conversation system-prompt channel; sc-996)', async () => {
    // Codex has no in-conversation system-prompt channel, so the reminder rides the prompt as
    // <system-reminder> text (interim fallback) rather than the Claude UserPromptSubmit hook.
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockPinnedTaskChat('task-dead-codex', { status: 'done' });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-reminder' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex follow-up on dead chat',
      history: [
        { role: 'user', content: 'do the task' },
        { role: 'assistant', content: 'done' },
      ],
    });

    const codexPrompt = vi.mocked(runCodexAgent).mock.calls[0]?.[0]?.prompt;
    expect(codexPrompt).toContain('<system-reminder>');
    expect(codexPrompt).toContain('intentionally not available');
    // Codex does not use the Claude SDK hook path.
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });

  it('hides frink_task_signal for plain chats with no task link', async () => {
    // Default mocks: no chat row → no pinned task. An interactive chat has nothing to signal, so
    // the tool (whose description says MANDATORY) must not be offered at all.
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValueOnce(undefined);
    mockClaudeFinishTurn('sess-plain-1');

    await handleRemoteExecute({ ...basePayload, message: 'hello' });

    expect(taskSignalEnabledArg(-1)).toBe(false);
  });

  it('arms signal enforcement only for a live task — a disarmed chat gets the passive pending-reader hook', async () => {
    const stopHookOf = (callIndex: number) =>
      (claudeQueryMock.mock.calls[callIndex][0] as { options?: { hooks?: { Stop?: unknown } } })
        .options?.hooks?.Stop;
    // Armed: live running task + dynamic-chat MCP mounted → Stop hook present.
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    mockPinnedTaskChat('task-armed-stop-hook', { status: 'running' });
    mockClaudeFinishTurn('sess-stop-armed');

    await handleRemoteExecute({ ...basePayload, message: 'armed turn' });

    expect(stopHookOf(0)).toBeDefined();

    // Disarmed: pinned task done → the PASSIVE Stop hook (pending-background-work reader) is
    // still mounted, but it must never force a continuation ("MANDATORY: You have not called
    // frink_task_signal yet…") on a dead chat's follow-up turns — it always allows.
    mockPinnedTaskChat('task-dead-stop-hook', { status: 'done' });
    mockClaudeFinishTurn('sess-stop-dead');

    await handleRemoteExecute({ ...basePayload, message: 'follow-up on dead chat' });

    const passiveStop = (
      stopHookOf(1) as Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> | undefined
    )?.[0]?.hooks?.[0];
    expect(passiveStop).toBeTypeOf('function');
    await expect(
      passiveStop?.({ hook_event_name: 'Stop', stop_hook_active: false }),
    ).resolves.toEqual({});
  });

  registerOperatorReminderDeliveryTests({ basePayload, claudeQueryMock, handleRemoteExecute });

  it('aborts the turn when the drive-info read faults', async () => {
    // A recorded provenance fault is rethrown at admission, ahead of any provider work — see
    // docs/decisions/flow-admission-capacity-lifecycle.md.
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-db-fault' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getFlowDriveInfoForSubChat).mockRejectedValueOnce(new Error('db read failed'));

    await handleRemoteExecute({ ...basePayload, message: 'follow-up during db fault' });

    const { chatId, subChatId, assistantMessageId } = basePayload;
    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({ chatId, subChatId, assistantMessageId, error: 'db read failed' }),
    );
    expect(vi.mocked(dynamicChatServer.setCurrentExecutionChat)).not.toHaveBeenCalled();
  });

  it('Claude: injects the flow briefing into systemPrompt.append (prompt-cached), never into the user message', async () => {
    vi.mocked(getFlowBriefingForSubChat).mockResolvedValueOnce('PRD: use strict mode');
    mockClaudeFinishTurn('sess-brief-claude');

    await handleRemoteExecute({ ...basePayload, message: 'do the work' });

    const call = claudeQueryMock.mock.calls[0][0] as {
      prompt?: string;
      options?: { systemPrompt?: { append?: string } };
    };
    expect(call.options?.systemPrompt?.append).toContain('## Flow Briefing');
    expect(call.options?.systemPrompt?.append).toContain('PRD: use strict mode');
    expect(call.options?.systemPrompt?.append).toContain(FLOW_BRIEFING_PROVENANCE_NOTE);
    // The whole point: it is NOT re-shipped in the user turn's transcript.
    const promptText = await claudePromptText(call.prompt);
    expect(promptText).not.toContain('## Flow Briefing');
    expect(promptText).not.toContain('PRD: use strict mode');
  });

  it('Claude: omits the Flow Briefing section from systemPrompt.append for a non-flow chat (empty briefing)', async () => {
    // getFlowBriefingForSubChat default mock returns '' → guard must inject nothing.
    mockClaudeFinishTurn('sess-no-brief');

    await handleRemoteExecute({ ...basePayload, message: 'do the work' });

    const call = claudeQueryMock.mock.calls[0][0] as {
      options?: { systemPrompt?: { append?: string } };
    };
    expect(call.options?.systemPrompt?.append).not.toContain('## Flow Briefing');
  });

  it('Codex: prepends the flow briefing to the user message on the first turn (no system-prompt channel)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    vi.mocked(getFlowBriefingForSubChat).mockResolvedValueOnce('PRD: use strict mode');
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-brief' },
      } as UIMessageChunk;
    });

    // A sub-chat with no cached provider session → the chat's first turn.
    await handleRemoteExecute({
      ...basePayload,
      subChatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      message: 'do the work',
    });

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain('## Flow Briefing');
    expect(prompt).toContain('PRD: use strict mode');
    expect(prompt).toContain(FLOW_BRIEFING_PROVENANCE_NOTE);
  });

  it('Codex: does NOT re-prepend the briefing on a resume turn (continuation inherits it via transcript replay)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    vi.mocked(getFlowBriefingForSubChat).mockResolvedValueOnce('PRD: use strict mode');
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-brief-2' },
      } as UIMessageChunk;
    });

    // A persisted session id marks a resume turn (not the chat's first turn).
    await handleRemoteExecute({
      ...basePayload,
      subChatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      message: 'follow-up',
      sessionId: 'existing-codex-session',
    });

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[0]?.prompt;
    expect(prompt).not.toContain('## Flow Briefing');
  });

  it('Claude: a briefing-lookup fault fails open — the turn proceeds with no Flow Briefing section', async () => {
    // The briefing read is isolated so a DB fault never blocks the turn (or disarms flow signals).
    vi.mocked(getFlowBriefingForSubChat).mockRejectedValueOnce(new Error('db read failed'));
    mockClaudeFinishTurn('sess-brief-fault');

    await handleRemoteExecute({ ...basePayload, message: 'do the work' });

    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    const call = claudeQueryMock.mock.calls[0][0] as {
      options?: { systemPrompt?: { append?: string } };
    };
    expect(call.options?.systemPrompt?.append).not.toContain('## Flow Briefing');
  });

  it('resumes failed task status on the Codex provider path', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-test',
      passthrough: true,
    });
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-resume-codex-1' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'task-resume-codex-1',
      status: 'failed',
      result: {
        agentSignal: { state: 'failed', summary: 'Old failure' },
        error: 'Old error',
      },
    } as Awaited<ReturnType<typeof getTaskById>>);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      // SAFETY: the executor reads only type and messageMetadata.sessionId from a finish chunk.
      yield { type: 'finish', messageMetadata: { sessionId: 'sess-codex-1' } } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex follow-up after failure',
    });

    expect(vi.mocked(resumeParkedTaskInPlace)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-resume-codex-1', status: 'failed' }),
      'follow_up_message',
      basePayload.subChatId,
    );
  });

  it('does not resume failed task before Claude credential preflight when credentials are missing', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: true,
      type: 'claude-code',
      label: 'claude-test',
    });
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-preflight-creds-1' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'task-preflight-creds-1',
      status: 'failed',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);

    await handleRemoteExecute({
      ...basePayload,
      message: 'follow-up with missing claude credentials',
    });

    expect(vi.mocked(resumeParkedTaskInPlace)).not.toHaveBeenCalled();
    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: basePayload.chatId,
        subChatId: basePayload.subChatId,
        error: expect.stringContaining('No Claude Code credentials configured'),
      }),
    );
  });

  it('does not resume failed task before Claude binary preflight when binary is missing', async () => {
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-preflight-bin-1' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockResolvedValueOnce({
      id: 'task-preflight-bin-1',
      status: 'failed',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    vi.spyOn(fs, 'existsSync').mockImplementation((pathLike) => {
      const pathValue = String(pathLike);
      if (pathValue === '/mock/bin/claude') return false;
      return true;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'follow-up with missing claude binary',
    });

    expect(vi.mocked(resumeParkedTaskInPlace)).not.toHaveBeenCalled();
    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: basePayload.chatId,
        subChatId: basePayload.subChatId,
        error: expect.stringContaining('Claude binary not found'),
      }),
    );
  });

  it('includes assistantMessageId when project lookup returns null', async () => {
    dbProjectState.projectRow = null;

    await handleRemoteExecute({
      ...basePayload,
      message: 'run with missing project',
    });

    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: basePayload.chatId,
        subChatId: basePayload.subChatId,
        assistantMessageId: basePayload.assistantMessageId,
        error: `Project ${basePayload.projectId} not found`,
      }),
    );
  });

  it('includes assistantMessageId when no credentials are configured', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce({
      token: null,
      isApiKey: true,
      type: 'claude-code',
      label: 'claude-test',
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run with no credentials configured',
    });

    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: basePayload.chatId,
        subChatId: basePayload.subChatId,
        assistantMessageId: basePayload.assistantMessageId,
        error: expect.stringContaining('credentials configured'),
      }),
    );
  });

  it('includes assistantMessageId when dev Claude binary is missing', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((pathLike) => {
      const pathValue = String(pathLike);
      if (pathValue === '/mock/bin/claude') return false;
      return true;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run with missing dev binary',
    });

    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: basePayload.chatId,
        subChatId: basePayload.subChatId,
        assistantMessageId: basePayload.assistantMessageId,
        error: expect.stringContaining('Claude binary not found'),
      }),
    );
  });

  it('queries task signal without proactively stopping heartbeat', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    // Self-contained: this used to lean on an unconsumed Once leaked by an earlier test, so it
    // failed when run alone and whenever an armed turn ran first.
    dynamicChatServerMocks.getLatestTaskSignal.mockReset();
    dynamicChatServerMocks.getLatestTaskSignal.mockReturnValue(undefined);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-signal-persist-no-stop' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockImplementation(async (_db, taskId) => {
      if (taskId !== 'task-signal-persist-no-stop') {
        return null as Awaited<ReturnType<typeof getTaskById>>;
      }
      return {
        id: 'task-signal-persist-no-stop',
        status: 'running',
        result: { executionLeaseId: 'lease-signal', startMode: 'execute' },
      } as Awaited<ReturnType<typeof getTaskById>>;
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-signal' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run with persisted signal',
    });

    expect(vi.mocked(dynamicChatServer.getLatestTaskSignal)).toHaveBeenCalledWith('exec-context-1');
    // No signal was recorded, so the post-stream block sees a quiet end and records the marker
    // (no terminal status write).
    expect(quietMarkerMocks.setQuietEndMarker).toHaveBeenCalledWith(
      expect.anything(),
      'task-signal-persist-no-stop',
      expect.any(String),
    );
  });

  it('post-stream quiet end in Claude plan mode stamps nothing — no terminal status, and no quiet marker when nothing is pending', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    dynamicChatServerMocks.getLatestTaskSignal.mockReset();
    dynamicChatServerMocks.getLatestTaskSignal.mockReturnValue(undefined);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-signal-plan-mode' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById).mockImplementation(async (_db, taskId) => {
      if (taskId !== 'task-signal-plan-mode') {
        return null as Awaited<ReturnType<typeof getTaskById>>;
      }
      return {
        id: 'task-signal-plan-mode',
        status: 'running',
        result: { executionLeaseId: 'lease-plan-signal', startMode: 'plan' },
      } as Awaited<ReturnType<typeof getTaskById>>;
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-signal-plan-mode' } }],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'plan mode persisted signal',
    });

    expect(vi.mocked(dynamicChatServer.getLatestTaskSignal)).toHaveBeenCalledWith('exec-context-1');
    // A quiet end must never stamp a terminal status. A plan-DRAFTING end with nothing pending no
    // longer records the quiet marker either: the plan machinery (card → plan_ready) owns that
    // transition. Only a plan stop with pending background work marks quiet.
    expect(quietMarkerMocks.setQuietEndMarker).not.toHaveBeenCalled();
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalled();

    // Plan mode DOES mount a Stop hook (it is the pending-work reader for every agent chat), but a
    // plan-DRAFTING turn owes no signal: the plan is its terminal artifact, so the hook must allow
    // rather than force a continuation — coercing here deadlocks an agent paused mid-plan.
    const planStopHook = (
      claudeQueryMock.mock.calls.at(-1)?.[0] as {
        options?: { hooks?: { Stop?: Array<{ hooks: Array<(i: unknown) => Promise<unknown>> }> } };
      }
    ).options?.hooks?.Stop?.[0]?.hooks?.[0];
    expect(planStopHook).toBeTypeOf('function');
    await expect(
      planStopHook?.({ hook_event_name: 'Stop', stop_hook_active: false }),
    ).resolves.toEqual({});

    dynamicChatServerMocks.getLatestTaskSignal.mockReset();
  });

  it('persists signal transition for lease-expired failed task after execution', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    // Stop hook + post-stream both read the signal — use a persistent return, not Once.
    dynamicChatServerMocks.getLatestTaskSignal.mockReset();
    dynamicChatServerMocks.getLatestTaskSignal.mockReturnValue({
      state: 'done',
      summary: 'Recovered and complete',
      at: new Date().toISOString(),
    });
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-lease-expired-signal' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    // Clear queued mockResolvedValueOnce from earlier tests in this file (full suite order).
    vi.mocked(getTaskById).mockReset();
    vi.mocked(getTaskById)
      // Resume check should skip because task is already running at execution start.
      .mockResolvedValueOnce({
        id: 'task-lease-expired-signal',
        status: 'running',
        result: { executionLeaseId: 'lease-a' },
      } as Awaited<ReturnType<typeof getTaskById>>)
      // Turn-start quiet-end marker clear reads the task once (no marker → no write).
      .mockResolvedValueOnce({
        id: 'task-lease-expired-signal',
        status: 'running',
        result: { executionLeaseId: 'lease-a' },
      } as Awaited<ReturnType<typeof getTaskById>>)
      // Post-run signal persistence sees stale lease failure and applies signal override.
      .mockResolvedValueOnce({
        id: 'task-lease-expired-signal',
        status: 'failed',
        result: {
          failureCode: 'EXECUTION_LEASE_EXPIRED',
          staleExecution: true,
          error: 'Execution lease expired (no heartbeat)',
          executionLeaseId: 'lease-a',
        },
      } as Awaited<ReturnType<typeof getTaskById>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-lease-override' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'resume stale-failed task by terminal signal',
    });

    expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(
      expect.anything(),
      'task-lease-expired-signal',
      'done',
      expect.objectContaining({
        result: expect.objectContaining({
          agentSignal: expect.objectContaining({ state: 'done' }),
          executionLeaseId: 'lease-a',
        }),
      }),
    );
  });

  it('continues execution when heartbeat restart from resume result returns false', async () => {
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:9/mcp',
    });
    vi.mocked(dynamicChatServer.getLatestTaskSignal).mockReturnValue(undefined);
    vi.mocked(getTaskById).mockReset();
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { taskId: 'task-resume-no-lease' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getTaskById)
      .mockResolvedValueOnce({
        id: 'task-resume-no-lease',
        status: 'failed',
        result: {
          agentSignal: { state: 'failed', summary: 'Old failure' },
          error: 'Execution lease expired (no heartbeat)',
        },
      } as Awaited<ReturnType<typeof getTaskById>>)
      .mockResolvedValueOnce({
        id: 'task-resume-no-lease',
        status: 'running',
        result: {},
      } as Awaited<ReturnType<typeof getTaskById>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-resume-no-lease' } }],
      };
      yield { type: 'result' };
    });

    await expect(
      handleRemoteExecute({
        ...basePayload,
        message: 'follow-up with stale task but no lease id in result',
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
  });

  it('drainPendingPermissions resolves pending bash permission wait as denied', async () => {
    // v2 bash check returns ask → executor prompts via socket; drain resolves it denied.
    vi.mocked(checkPermission).mockResolvedValue({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const queuedRequests: QueuedPermissionRequest[] = [];
    vi.mocked(socketClient.sendPermissionRequest).mockImplementation((payload) => {
      queuedRequests.push(payload as QueuedPermissionRequest);
    });

    claudeQueryMock.mockImplementationOnce(async function* (queryInput: PreToolUseQueryInput) {
      const hook = getPreToolUseHook(queryInput);

      const pending = hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'sleep 999' },
        },
        'tool-bash-drain-pending',
      );

      await Promise.resolve();
      expect(queuedRequests).toHaveLength(1);
      drainPendingPermissions();

      // Drain must also pop the prompt from the renderer queue, mirroring the
      // timeout path — otherwise the card lingers and a re-request stacks.
      expect(socketClient.sendPermissionDismiss).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: queuedRequests[0].requestId }),
      );

      const res = await pending;
      expect(res.hookSpecificOutput.permissionDecision).toBe('deny');

      yield {
        chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-bash-drain-pending' } }],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'drain pending permissions simulates disconnect',
    });
  });

  it('worktree file op: canonical ROOT path drives BOTH the decision input and the prompt display (real PreToolUse hook + real remap)', async () => {
    const worktree = '/tmp/wt/perm-brave-lion-aabbcc';
    const worktreeFile = `${worktree}/src/foo.ts`;
    const canonicalFile = `${project.path}/src/foo.ts`;

    // Chat is in a worktree; the permission boundary resolves worktree -> root project.
    // (The default beforeEach spy returns the path unchanged — override it here so the
    // real remapPathForPermissionBoundary has a distinct root to map onto.)
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { worktreePath: worktree },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockImplementation((p) =>
      p === worktree ? project.path : p,
    );

    // Force a prompt so the displayed path is asserted too; auto-approve it.
    vi.mocked(checkPermission).mockResolvedValue({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const requests: QueuedPermissionRequest[] = [];
    vi.mocked(socketClient.sendPermissionRequest).mockImplementation((payload) => {
      requests.push(payload as QueuedPermissionRequest);
      getRegisteredPermissionResponseHandler()?.({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        requestId: payload.requestId,
        approved: true,
        duration: 'always',
      });
    });

    claudeQueryMock.mockImplementationOnce(async function* (queryInput: PreToolUseQueryInput) {
      const hook = getPreToolUseHook(queryInput);
      const res = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: worktreeFile },
        },
        'tool-read-worktree',
      );
      expect(res.hookSpecificOutput.permissionDecision).toBe('allow');
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-wt-read' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'worktree read canonicalization' });

    // Decision: the canonical ROOT path (not the raw worktree path) reaches checkPermission.
    const decisionCall = vi.mocked(checkPermission).mock.calls.find((c) => c[0]?.tool === 'Read');
    expect(decisionCall?.[0]?.input).toMatchObject({ file_path: canonicalFile });
    expect((decisionCall?.[0]?.input as Record<string, unknown>).file).toBeUndefined();
    expect(decisionCall?.[0]?.projectPath).toBe(project.path);

    // Display: the prompt the user sees shows the canonical path too.
    const fileReq = requests.find((r) => r.type === 'file');
    expect(fileReq?.path).toBe(canonicalFile);
  });

  it('worktree chat: a path OUTSIDE the worktree is NOT canonicalized into the project (no escalation)', async () => {
    const worktree = '/tmp/wt/perm-brave-lion-aabbcc';
    const externalFile = '/etc/hosts';

    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { worktreePath: worktree },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockImplementation((p) =>
      p === worktree ? project.path : p,
    );

    claudeQueryMock.mockImplementationOnce(async function* (queryInput: PreToolUseQueryInput) {
      const hook = getPreToolUseHook(queryInput);
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: externalFile },
        },
        'tool-read-external',
      );
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-wt-external' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'worktree external read' });

    // remapPathForPermissionBoundary only rewrites paths UNDER the worktree prefix; an
    // outside path passes through verbatim, so the decision still sees the real external path.
    const decisionCall = vi.mocked(checkPermission).mock.calls.find((c) => c[0]?.tool === 'Read');
    expect((decisionCall?.[0]?.input as Record<string, unknown>).file_path).toBe(externalFile);
  });
});

describe('validateToolPermission — worktree canonical decision path', () => {
  const root = '/Users/dev/myproj';
  const worktreeFile = '/Users/dev/.frink/worktrees/myproj/brave-lion-aabbcc/src/lib/foo.ts';
  const canonicalFile = '/Users/dev/myproj/src/lib/foo.ts';
  const subChatId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    stubPermissionsStoreDefault();
  });

  function lastDecisionInput(): Record<string, unknown> {
    return vi.mocked(checkPermission).mock.calls[0]?.[0]?.input as Record<string, unknown>;
  }

  it('feeds the canonical override path into the PATH-tool decision and clears stale file/path fields', async () => {
    await validateToolPermission(
      'Read',
      { file_path: worktreeFile },
      root,
      'chat-1',
      subChatId,
      'Tool: Read',
      canonicalFile,
    );

    const input = lastDecisionInput();
    expect(input.file_path).toBe(canonicalFile);
    expect(input.file).toBeUndefined();
    expect(input.path).toBeUndefined();
    expect(vi.mocked(checkPermission).mock.calls[0]?.[0]?.projectPath).toBe(root);
  });

  it('canonicalizes a worktree path carried in the `file` field (SDK alias) onto file_path', async () => {
    await validateToolPermission(
      'Edit',
      { file: worktreeFile },
      root,
      'chat-1',
      subChatId,
      'Tool: Edit',
      canonicalFile,
    );

    const input = lastDecisionInput();
    expect(input.file_path).toBe(canonicalFile);
    expect(input.file).toBeUndefined();
    expect(input.path).toBeUndefined();
  });

  it('passes raw input through unchanged when no override is supplied (non-worktree chat)', async () => {
    await validateToolPermission(
      'Read',
      { file_path: canonicalFile },
      root,
      'chat-1',
      subChatId,
      'Tool: Read',
    );

    const input = lastDecisionInput();
    expect(input.file_path).toBe(canonicalFile);
    expect('file' in input).toBe(false);
  });

  it('does not canonicalize Bash input — override is display-only for non-PATH tools', async () => {
    await validateToolPermission(
      'Bash',
      { command: 'ls -la' },
      root,
      'chat-1',
      subChatId,
      'Tool: Bash',
      canonicalFile,
    );

    const input = lastDecisionInput();
    expect(input.command).toBe('ls -la');
    expect(input.file_path).toBeUndefined();
  });
});

describe('context isolation edge cases', () => {
  const machineId = 'machine-edge';
  const project = {
    id: 'project-edge-1',
    user_id: 'user-1',
    name: 'Edge Project',
    path: '/tmp/project-edge',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  /** Claude passthrough: token-null on purpose — the spawned CLI reads the keychain itself. */
  const passthroughCredential = {
    token: null,
    isApiKey: false,
    type: 'claude-code' as const,
    label: 'claude-passthrough-test',
    passthrough: true,
  };

  const codexCredential = {
    token: null,
    isApiKey: false,
    type: 'codex' as const,
    label: 'codex-test',
    passthrough: true,
  };

  const basePayload = {
    chatId: 'chat-edge-1',
    subChatId: '11111111-1111-4111-8111-111111111111',
    projectId: project.id,
    mode: 'agent' as const,
    assistantMessageId: 'assistant-edge-1',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  function expectSafeClaudeFailurePark(): void {
    expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
      basePayload.subChatId,
      { kind: 'api-error', status: null, message: 'Claude execution failed. Please try again.' },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    applyExecutorMockDefaults(machineId, project);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
  });

  it('does not pass continue/resume for fresh Claude runs in existing projects', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-edge-1' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'fresh run',
    });

    const queryInput = claudeQueryMock.mock.calls[0]?.[0] as {
      options?: { resume?: string; continue?: boolean };
    };
    expect(queryInput.options?.resume).toBeUndefined();
    expect(queryInput.options?.continue).toBeUndefined();
  });

  it('returns error when subChatId is path-unsafe for Claude Code path', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    await handleRemoteExecute({
      ...basePayload,
      subChatId: 'bad id',
      message: 'bad session id',
    });
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Invalid chat session'),
      }),
    );
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });

  it('does not pass continue/resume for first-turn retry payloads', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-edge-regen' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'regen first turn',
    });

    const queryInput = claudeQueryMock.mock.calls[0]?.[0] as {
      options?: { resume?: string; continue?: boolean };
    };
    expect(queryInput.options?.resume).toBeUndefined();
    expect(queryInput.options?.continue).toBeUndefined();
  });

  it('uses explicit resume as the sole selector when a persisted session exists', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-edge-resume' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'resume run',
      sessionId: 'sess-prev-123',
    });

    const call = claudeQueryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> };
    expect(call.options?.resume).toBe('sess-prev-123');
    expect(call.options?.continue).toBeUndefined();
  });

  it('retries Claude execution without resume when resume fails during stream iteration', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock
      // Async generator that rejects on first iteration (matches SDK Query semantics); no yield before throw.
      // biome-ignore lint/correctness/useYield: intentional — throw on first next() like production SDK
      .mockImplementationOnce(async function* () {
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: stale-session-1',
        );
      })
      .mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-fresh-retry' } }] };
        yield { type: 'result' };
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'resume then retry fresh',
      sessionId: 'stale-session-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstCall = claudeQueryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> };
    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as { options?: Record<string, unknown> };
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(firstCall.options?.resume).toBe('stale-session-1');
    expect(firstCall.options?.continue).toBeUndefined();
    expect(secondCall.options?.resume).toBeUndefined();
    expect(secondCall.options?.continue).toBeUndefined();
    expect(vi.mocked(socketClient.sendExecuteCompleteDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-fresh-retry',
      }),
    );
  });

  const historyFixture = [
    { role: 'user' as const, content: 'earlier question' },
    { role: 'assistant' as const, content: 'earlier answer' },
  ];

  it('suppresses the conversation_history block when resuming a Claude session (SDK replays the transcript)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-resume-nohist' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'resume run',
      sessionId: 'sess-prev-123',
      history: historyFixture,
    });

    const prompt = await claudePromptText(claudeQueryMock.mock.calls[0]?.[0]?.prompt);
    expect(prompt).not.toContain('<conversation_history>');
    expect(prompt).not.toContain('earlier question');
    expect(prompt).toContain('resume run');
  });

  it('injects the conversation_history block on a fresh Claude run (no server transcript to replay)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-fresh-hist' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'fresh run',
      history: historyFixture,
    });

    const prompt = await claudePromptText(claudeQueryMock.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain('<conversation_history>');
    expect(prompt).toContain('earlier question');
    expect(prompt).toContain('fresh run');
  });

  it('sends history once on fresh Codex, then suppresses it on cached native resume while retaining a fresh fallback', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getFlowBriefingForSubChat).mockResolvedValue('PRD: preserve native history');
    vi.mocked(runCodexAgent)
      .mockImplementationOnce(async function* () {
        yield {
          type: 'finish',
          messageMetadata: { sessionId: 'codex-cached-thread' },
        } as UIMessageChunk;
      })
      .mockImplementationOnce(async function* () {
        yield {
          type: 'finish',
          messageMetadata: { sessionId: 'codex-cached-thread' },
        } as UIMessageChunk;
      });

    const codexPayload = {
      ...basePayload,
      chatId: 'chat-edge-codex-history',
      subChatId: '22222222-2222-4222-8222-222222222222',
    };
    await handleRemoteExecute({
      ...codexPayload,
      message: 'fresh Codex run',
      history: historyFixture,
    });
    await handleRemoteExecute({
      ...codexPayload,
      assistantMessageId: 'assistant-edge-codex-2',
      message: 'latest Codex message',
      history: historyFixture,
    });

    const freshCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(freshCall?.resumeThreadId).toBeUndefined();
    expect(freshCall?.freshThreadFallbackPrompt).toBeUndefined();
    expect(freshCall?.prompt).toContain('## Flow Briefing');
    expect(freshCall?.prompt).toContain('<conversation_history>');
    expect(freshCall?.prompt).toContain('earlier question');

    const resumedCall = vi.mocked(runCodexAgent).mock.calls[1]?.[0];
    expect(resumedCall?.resumeThreadId).toBe('codex-cached-thread');
    expect(resumedCall?.prompt).toContain('latest Codex message');
    expect(resumedCall?.prompt).not.toContain('<conversation_history>');
    expect(resumedCall?.prompt).not.toContain('earlier question');
    expect(resumedCall?.prompt).not.toContain('## Flow Briefing');
    expect(resumedCall?.freshThreadFallbackPrompt).toContain('## Flow Briefing');
    expect(resumedCall?.freshThreadFallbackPrompt).toContain('<conversation_history>');
    expect(resumedCall?.freshThreadFallbackPrompt).toContain('earlier question');
    expect(resumedCall?.freshThreadFallbackPrompt).toContain('latest Codex message');
    expect(resumedCall?.freshThreadFallbackPrompt?.match(/<conversation_history>/g)).toHaveLength(
      1,
    );
  });

  it('restores the conversation_history block on the fresh retry after a resume failure', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock
      // biome-ignore lint/correctness/useYield: intentional — throw on first next() like production SDK
      .mockImplementationOnce(async function* () {
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: stale-session-2',
        );
      })
      .mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-retry-hist' } }] };
        yield { type: 'result' };
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'resume then retry',
      sessionId: 'stale-session-2',
      history: historyFixture,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstPrompt = await claudePromptText(claudeQueryMock.mock.calls[0]?.[0]?.prompt);
    const secondPrompt = await claudePromptText(claudeQueryMock.mock.calls[1]?.[0]?.prompt);
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    // Resume attempt suppressed history; the fresh retry must restore it (no SDK replay).
    expect(firstPrompt).not.toContain('<conversation_history>');
    expect(secondPrompt).toContain('<conversation_history>');
    expect(secondPrompt).toContain('earlier question');
    expect(secondPrompt).toContain('resume then retry');
  });

  const approvedPlanFixture = {
    planId: 'plan-ctx-resume',
    planText: 'Migrate the API safely.',
  };

  it('suppresses history but keeps the approved-plan context on a resumed plan→execute turn', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-plan-resume' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'implement the approved plan',
      sessionId: 'sess-plan-prev',
      history: historyFixture,
      approvedPlanContext: approvedPlanFixture,
    });

    const prompt = await claudePromptText(claudeQueryMock.mock.calls[0]?.[0]?.prompt);
    // Prepended plan context survives suppression; SDK-replayed history is NOT re-shipped.
    expect(prompt).toContain('<approved_plan>');
    expect(prompt).toContain('Migrate the API safely.');
    expect(prompt).not.toContain('<conversation_history>');
    expect(prompt).not.toContain('earlier question');
    expect(prompt).toContain('implement the approved plan');
  });

  it('restores history while preserving approved-plan context on the fresh retry after resume failure', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock
      // biome-ignore lint/correctness/useYield: intentional — throw on first next() like production SDK
      .mockImplementationOnce(async function* () {
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: stale-plan-1',
        );
      })
      .mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-plan-retry' } }] };
        yield { type: 'result' };
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'implement the approved plan',
      sessionId: 'stale-plan-1',
      history: historyFixture,
      approvedPlanContext: approvedPlanFixture,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstPrompt = await claudePromptText(claudeQueryMock.mock.calls[0]?.[0]?.prompt);
    const secondPrompt = await claudePromptText(claudeQueryMock.mock.calls[1]?.[0]?.prompt);
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    // Resume attempt: plan context present, history suppressed.
    expect(firstPrompt).toContain('<approved_plan>');
    expect(firstPrompt).not.toContain('<conversation_history>');
    // Fresh retry: suffix-swap restores history AND keeps the prepended plan context,
    // in the same order as a fresh turn (plan context before history block).
    expect(secondPrompt).toContain('<approved_plan>');
    expect(secondPrompt).toContain('<conversation_history>');
    expect(secondPrompt).toContain('earlier question');
    expect(secondPrompt).toContain('implement the approved plan');
    expect(secondPrompt?.indexOf('<approved_plan>')).toBeLessThan(
      secondPrompt?.indexOf('<conversation_history>') ?? -1,
    );
  });

  it('retries without resume when resume fails after SDK skeleton chunks only (no user-visible content)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock
      .mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'start' }] };
        yield { chunks: [{ type: 'message-metadata', messageMetadata: {} }] };
        yield { chunks: [{ type: 'finish', messageMetadata: {} }] };
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: skel-sess-1',
        );
      })
      .mockImplementationOnce(async function* () {
        yield {
          chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-after-skel-retry' } }],
        };
        yield { type: 'result' };
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'skeleton then retry',
      sessionId: 'skel-sess-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstCall = claudeQueryMock.mock.calls[0]?.[0] as { options?: Record<string, unknown> };
    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as { options?: Record<string, unknown> };
    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(firstCall.options?.resume).toBe('skel-sess-1');
    expect(firstCall.options?.continue).toBeUndefined();
    expect(secondCall.options?.resume).toBeUndefined();
    expect(secondCall.options?.continue).toBeUndefined();
    expect(vi.mocked(socketClient.sendExecuteCompleteDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-after-skel-retry',
      }),
    );
  });

  describe('usage-limit park — flow task → needs_attention (resumable), never failed', () => {
    const LIMIT_TEXT = "You've hit your limit · resets 2:20pm (Europe/London)";

    it('error-result shape: parks the flow task and tags the error RATE_LIMIT_SDK', async () => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
      claudeQueryThrowOnce(new Error(`Claude Code returned an error result: ${LIMIT_TEXT}`));

      await handleRemoteExecute({ ...basePayload, message: 'turn that hits the limit' });

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        {
          kind: 'usage-limit',
          limitText: 'Claude usage limit reached. Please try again later.',
        },
      );
      expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'RATE_LIMIT_SDK' }),
      );
    });

    it('clean-stream shape: parks when the limit text is the final text part, no error emitted', async () => {
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            { type: 'text-delta', id: 'limit-1', delta: LIMIT_TEXT },
            { type: 'finish', messageMetadata: { sessionId: 'sess-limit-clean' } },
          ],
        };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'turn that ends on the limit' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        { kind: 'usage-limit', limitText: LIMIT_TEXT },
      );
      // Clean stream still completes normally for the renderer.
      expect(vi.mocked(socketClient.sendExecuteCompleteDirect)).toHaveBeenCalled();
      expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    });

    it('does not park when the limit phrase only appears before the final text part', async () => {
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            { type: 'text-delta', id: 'quote-1', delta: `The toast text is "${LIMIT_TEXT}".` },
            { type: 'text-delta', id: 'after-1', delta: 'Continuing with the actual work now.' },
            { type: 'finish', messageMetadata: { sessionId: 'sess-limit-quoted' } },
          ],
        };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'turn that quotes the limit text' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
    });

    it('still emits the categorized error when the park write fails (park never blocks teardown)', async () => {
      vi.mocked(parkFlowTaskOnClaudeInterruption).mockRejectedValueOnce(
        new Error('database is locked'),
      );
      claudeQueryThrowOnce(new Error(`Claude Code returned an error result: ${LIMIT_TEXT}`));

      await handleRemoteExecute({ ...basePayload, message: 'limit turn with failing park' });

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalled();
      // Degrades to today's behavior (status untouched) but the renderer MUST still hear the error.
      expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'RATE_LIMIT_SDK' }),
      );
    });

    it('parks a non-limit error as an unclassified api-error (status null), no category tag', async () => {
      claudeQueryThrowOnce(new Error('claude stream exploded'));

      await handleRemoteExecute({ ...basePayload, message: 'turn that just fails' });

      expectSafeClaudeFailurePark();
      expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Claude execution failed. Please try again.' }),
      );
      const errorPayload = vi.mocked(socketClient.sendErrorDirect).mock.calls.at(-1)?.[0] as {
        category?: string;
      };
      expect(errorPayload.category).toBeUndefined();
    });
  });

  describe('clean-stream api-error park — a turn that ENDS on an API error is not a completion', () => {
    // Verbatim from flow run ms0qlgm13c8kekvr: the SDK yielded a normal result frame with this as
    // the final assistant text, so nothing threw, nothing parked, and the run read `running` until
    // the quiet-idle ceiling.
    const REVOKED_TOKEN_TEXT =
      'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';

    /**
     * Each argument becomes its OWN text part. `text-end` is what closes a block — consecutive
     * deltas without it accumulate into a single merged part, which is not the shape a real
     * multi-block turn produces.
     */
    function cleanStreamEndingIn(...blocks: string[]): void {
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            ...blocks.flatMap((delta, i) => [
              { type: 'text-delta', id: `api-err-${i}`, delta },
              { type: 'text-end', id: `api-err-${i}` },
            ]),
            { type: 'finish', messageMetadata: { sessionId: 'sess-api-error-clean' } },
          ],
        };
        yield { type: 'result' };
      });
    }

    it('parks the flow task when the revoked-token error is the final text part', async () => {
      cleanStreamEndingIn(REVOKED_TOKEN_TEXT);

      await handleRemoteExecute({ ...basePayload, message: 'turn whose token gets revoked' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        { kind: 'api-error', status: 401, message: REVOKED_TOKEN_TEXT },
      );
      // The stream itself was clean, so the renderer still completes normally.
      expect(vi.mocked(socketClient.sendExecuteCompleteDirect)).toHaveBeenCalled();
      expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    });

    it('parks when real work precedes the error — the trailing part is what decides', async () => {
      cleanStreamEndingIn('Migrated the first three routers.', REVOKED_TOKEN_TEXT);

      await handleRemoteExecute({ ...basePayload, message: 'turn that works then dies' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        expect.objectContaining({ kind: 'api-error', status: 401 }),
      );
    });

    it('does not park a turn that hit the error and then carried on', async () => {
      cleanStreamEndingIn(REVOKED_TOKEN_TEXT, 'Re-authenticated and finished the migration.');

      await handleRemoteExecute({ ...basePayload, message: 'turn that recovers' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
    });

    it('does not park an agent that merely reports on an API error it was investigating', async () => {
      cleanStreamEndingIn(
        `I traced the wedge: the turn died with "${REVOKED_TOKEN_TEXT}" and nothing parked it.`,
      );

      await handleRemoteExecute({ ...basePayload, message: 'turn about the bug' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
    });

    // Codex signals CLI/API failure with an `error` chunk then a finish: a failed turn otherwise
    // settles as complete with the flow task `running`. `Once` keeps later tests on claude.
    const CODEX_401 = 'Codex app-server returned 401 Unauthorized — invalid credentials';

    it('parks a Codex turn that ended on an error chunk', async () => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
      vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
        // SAFETY: the executor reads only type and errorText from an error chunk.
        yield { type: 'error', errorText: CODEX_401 } as UIMessageChunk;
        // SAFETY: the executor reads only type and messageMetadata.sessionId from a finish chunk.
        yield {
          type: 'finish',
          messageMetadata: { sessionId: 'sess-codex-401' },
        } as UIMessageChunk;
      });

      await handleRemoteExecute({ ...basePayload, message: 'codex turn with a revoked key' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        { kind: 'api-error', status: null, message: CODEX_401 },
      );
    });

    registerExecutorPermissionTests({
      handleRemoteExecute,
      runCodexAgent,
      getDefaultClaudeCodeToken,
      getChatWithProjectAccount,
      getTaskById,
      socketClient,
      toolValidation,
      validateToolPermission,
      parkFlowTaskOnClaudeInterruption,
      clientPermissionBridge,
      basePayload,
      codexCredential,
      project,
    });

    it('leaves a clean Codex turn alone', async () => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
      vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
        yield { type: 'text-delta', id: 'ok-1', delta: 'Done.' } as UIMessageChunk;
        yield {
          type: 'finish',
          messageMetadata: { sessionId: 'sess-codex-ok' },
        } as UIMessageChunk;
      });

      await handleRemoteExecute({ ...basePayload, message: 'codex turn that succeeds' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
    });

    it('parks a Codex turn that threw — its own catch swallows the error from the outer handler', async () => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
      // Streams a little, then the transport dies mid-turn — the shape that reaches Codex's catch.
      vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
        yield { type: 'text-delta', id: 'codex-1', delta: 'Starting…' } as UIMessageChunk;
        throw new Error('codex app-server connection closed');
      });

      await handleRemoteExecute({ ...basePayload, message: 'codex turn that dies' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        { kind: 'api-error', status: null, message: 'codex app-server connection closed' },
      );
    });
  });

  describe('stream-error fallback park — unclassified errors must not wedge the flow task', () => {
    it('"exited with code" crash parks with status null', async () => {
      claudeQueryThrowOnce(new Error('claude process exited with code 1'));

      await handleRemoteExecute({ ...basePayload, message: 'turn whose process dies' });

      expectSafeClaudeFailurePark();
    });

    it('a long unanchored message (classifier rejects >600 chars) still parks, message capped', async () => {
      const longError = `stream failed: ${'x'.repeat(5000)}`;
      claudeQueryThrowOnce(new Error(longError));

      await handleRemoteExecute({ ...basePayload, message: 'turn with a huge error' });

      expectSafeClaudeFailurePark();
    });

    it('an ambiguous AbortError (no user stop recorded) parks instead of wedging', async () => {
      claudeQueryThrowOnce(new Error('The operation was aborted'));

      await handleRemoteExecute({ ...basePayload, message: 'turn killed by a network abort' });

      expectSafeClaudeFailurePark();
      // Abort-shaped text still suppresses the error toast.
      expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    });

    it('an explicit "aborted by user" error does not park (deliberate stop owns disposition)', async () => {
      claudeQueryThrowOnce(new Error('Claude Code process aborted by user'));

      await handleRemoteExecute({ ...basePayload, message: 'turn the user stopped' });

      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
      expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    });
  });

  describe('SDK exit errors are classified without their CLI stderr tail', () => {
    const exitWithStderr = (tail: string) =>
      new Error(`Claude Code process exited with code 1. stderr: ${tail}`);

    it('a resume-failure phrase in stderr does not retry without resume', async () => {
      claudeQueryThrowOnce(exitWithStderr('No conversation found with session ID x'));

      await handleRemoteExecute({ ...basePayload, message: 'resumed turn', sessionId: 'sess-x' });

      expect(claudeQueryMock).toHaveBeenCalledTimes(1);
      expectSafeClaudeFailurePark();
    });

    it('an abort phrase in stderr is reported as an error, not a silent user stop', async () => {
      claudeQueryThrowOnce(exitWithStderr('AbortError: The operation was aborted'));

      await handleRemoteExecute({ ...basePayload, message: 'turn whose CLI crashed' });

      expectSafeClaudeFailurePark();
      expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Claude execution failed. Please try again.' }),
      );
    });

    it('a usage-limit phrase in stderr does not park as a usage limit', async () => {
      claudeQueryThrowOnce(exitWithStderr("You've hit your limit · resets 3pm"));

      await handleRemoteExecute({ ...basePayload, message: 'turn whose CLI crashed' });

      expectSafeClaudeFailurePark();
    });
  });

  describe('API-error retry + park — transient/auth errors retry once, then park (non-batch)', () => {
    const AUTH_ERROR =
      'Claude Code returned an error result: Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}';
    const OVERLOADED_ERROR = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';

    it('api-key 401 with an UNCHANGED credential does not retry — parks api-error and tags API_ERROR', async () => {
      claudeQueryThrowOnce(new Error(AUTH_ERROR));

      await handleRemoteExecute({ ...basePayload, message: 'turn that 401s' });

      expect(claudeQueryMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        expect.objectContaining({ kind: 'api-error', status: 401 }),
      );
      expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'API_ERROR' }),
      );
    });

    it('api-key 401 with a ROTATED credential retries once with the fresh key', async () => {
      // Only api-key accounts re-resolve on 401: frink owns that secret, so a cloud sync can
      // legitimately hand back a newer one mid-turn. Passthrough has no token to swap.
      let resolveCalls = 0;
      vi.mocked(getDefaultClaudeCodeToken).mockImplementation(async () =>
        ++resolveCalls === 1
          ? claudeCredential
          : { ...claudeCredential, token: 'claude-token-fresh' },
      );
      claudeQueryThrowOnce(new Error(AUTH_ERROR));
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-after-401' } }] };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'turn that 401s then recovers' });

      expect(claudeQueryMock).toHaveBeenCalledTimes(2);
      const [first, retry] = [0, 1].map((i) => claudeQueryMock.mock.calls[i]?.[0]?.options);
      expect(JSON.stringify(retry.env)).not.toContain('claude-token');
      expect(retry.spawnClaudeCodeProcess).not.toBe(first.spawnClaudeCodeProcess); // fresh pipe
      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
      expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    });

    it('transient 529 recreates the query with explicit resume only and succeeds', async () => {
      claudeQueryThrowOnce(new Error(OVERLOADED_ERROR));
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-after-529' } }] };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'resume', sessionId: 'resume-529' });

      expect(claudeQueryMock).toHaveBeenCalledTimes(2);
      expect(
        claudeQueryMock.mock.calls.map(([input]) => [
          input.options?.resume,
          input.options?.continue,
        ]),
      ).toEqual([
        ['resume-529', undefined],
        ['resume-529', undefined],
      ]);
      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
      expect(vi.mocked(socketClient.sendErrorDirect)).not.toHaveBeenCalled();
    }, 15_000);

    it('passthrough 401 retries on plain backoff and never re-resolves the credential', async () => {
      // The incident this guards: frink used to pin a keychain access token into the agent's env.
      // When anything else on the machine rotated the shared credential, that token was revoked
      // server-side and every in-flight agent 401'd. Re-resolving was useless — the keychain still
      // held the same revoked value until the CLI rotated it. Now frink injects nothing and the
      // CLI recovers on its own, so the retry must NOT consult frink's credential store.
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(passthroughCredential);
      vi.mocked(getDefaultClaudeCodeToken).mockClear();
      claudeQueryThrowOnce(new Error(AUTH_ERROR));
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-after-401-pt' } }] };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'passthrough turn that 401s' });

      expect(claudeQueryMock).toHaveBeenCalledTimes(2);
      // Resolved once for the spawn; the retry path must not ask again.
      expect(vi.mocked(getDefaultClaudeCodeToken)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).not.toHaveBeenCalled();
    }, 15_000);

    it('passthrough spawns carry no token and pin the canonical keychain', async () => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(passthroughCredential);

      await handleRemoteExecute({ ...basePayload, message: 'passthrough spawn' });

      const { env, spawnClaudeCodeProcess } = claudeQueryMock.mock.calls[0]?.[0]?.options;
      expect(spawnClaudeCodeProcess).toBeUndefined(); // SDK default spawn: no credential pipe
      // Strict equality: toBeFalsy() would also pass on `undefined`, which is the broken state —
      // the CLI branches on `!== undefined`, so an absent var re-enables the hashed service name.
      expect(env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('');
      expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    it('api-key spawns receive the key through the fd pipe, never the env Bash inherits', async () => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);

      await handleRemoteExecute({ ...basePayload, message: 'api-key spawn' });

      const { env, spawnClaudeCodeProcess } = claudeQueryMock.mock.calls[0]?.[0]?.options;
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env?.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR).toBe('3');
      expect(spawnClaudeCodeProcess).toBeTypeOf('function');
    });

    it('persists the session id EARLY (first raw SDK frame) so a mid-stream failure stays resumable', async () => {
      // Session id normally lands at stream finish — a turn that dies mid-stream never gets
      // there, leaving sub_chats.session_id NULL and Carry on with nothing to resume.
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          session_id: 'sess-early',
          chunks: [{ type: 'start' }, { type: 'text-delta', id: 't1', delta: 'partial work' }],
        };
        throw new Error('claude stream exploded');
      });

      await handleRemoteExecute({ ...basePayload, message: 'turn that dies mid-stream' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(vi.mocked(updateSubChatSession)).toHaveBeenCalledWith(
        expect.anything(),
        basePayload.subChatId,
        'sess-early',
      );
    });

    it('does NOT retry after user-visible work — parks instead (side effects must not double)', async () => {
      claudeQueryMock.mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'text-delta', id: 'part-1', delta: 'did some work' }] };
        throw new Error(OVERLOADED_ERROR);
      });

      await handleRemoteExecute({ ...basePayload, message: 'turn that half-works then 529s' });

      expect(claudeQueryMock).toHaveBeenCalledTimes(1);
      expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
        basePayload.subChatId,
        expect.objectContaining({ kind: 'api-error', status: 529 }),
      );
    });
  });

  it('does not retry Claude when resume fails after user-visible stream chunks', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'text-delta', id: 't1', delta: 'Partial reply' }] };
      throw new Error(
        'Claude Code returned an error result: No conversation found with session ID: stale-after-uvp',
      );
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'partial then resume fail',
      sessionId: 'stale-after-uvp',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(socketClient.sendErrorDirect).mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        failedSessionId: 'stale-after-uvp',
      }),
    );
  });

  it('retries Claude execution without resume when claudeQuery rejects synchronously (resume failure)', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock
      .mockImplementationOnce(() => {
        // The real SDK query() throws synchronously on a spawn-time resume failure.
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: stale-session-1',
        );
      })
      .mockImplementationOnce(async function* () {
        yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-fresh-retry' } }] };
        yield { type: 'result' };
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'resume then retry fresh',
      sessionId: 'stale-session-1',
    });

    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as {
      options?: { resume?: string; continue?: boolean };
    };
    expect(secondCall.options?.resume).toBeUndefined();
    expect(secondCall.options?.continue).toBeUndefined();
  });

  it('re-iterates the image-prompt user message on retry when resume fails', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);

    type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
    type ImagePromptInput = {
      prompt: string | AsyncIterable<SDKUserMessage>;
    };

    const consumed: SDKUserMessage[][] = [];
    // The prompt is now a streaming input queue kept OPEN for the whole turn, so draining it with
    // `for await` would block (the executor closes it only at turn end). Mirror the real SDK, which
    // reads the buffered turn message without waiting for EOF: pull a single `.next()`.
    async function consumePrompt(input: ImagePromptInput): Promise<SDKUserMessage[]> {
      if (typeof input.prompt === 'string') return [];
      const first = await input.prompt[Symbol.asyncIterator]().next();
      return first.done ? [] : [first.value];
    }
    claudeQueryMock
      // biome-ignore lint/correctness/useYield: throws on first iteration
      .mockImplementationOnce(async function* (queryInput: unknown) {
        consumed.push(await consumePrompt(queryInput as ImagePromptInput));
        throw new Error(
          'Claude Code returned an error result: No conversation found with session ID: stale-img',
        );
      })
      .mockImplementationOnce(async function* (queryInput: unknown) {
        consumed.push(await consumePrompt(queryInput as ImagePromptInput));
        yield {
          chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-img-retry' } }],
        };
        yield { type: 'result' };
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'describe the screenshot',
      sessionId: 'stale-img',
      userMessageParts: [
        {
          type: 'file',
          mimeType: 'image/png',
          data: 'AAAA',
        },
      ],
    });

    expect(claudeQueryMock).toHaveBeenCalledTimes(2);
    expect(consumed).toHaveLength(2);
    expect(consumed[0]).toHaveLength(1);
    expect(consumed[1]).toHaveLength(1);
    const retryMessage = consumed[1][0]?.message as
      | { content?: Array<{ type?: string }> }
      | undefined;
    const hasImage = retryMessage?.content?.some((c) => c.type === 'image');
    expect(hasImage).toBe(true);
  });

  it('does not retry when execution is aborted between attempts', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);

    // biome-ignore lint/correctness/useYield: aborts then throws on first iteration
    claudeQueryMock.mockImplementationOnce(async function* () {
      handleRemoteStop(basePayload);
      throw new Error(
        'Claude Code returned an error result: No conversation found with session ID: aborted-mid',
      );
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'aborted between attempts',
      sessionId: 'aborted-mid',
    });

    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
  });

  it('closes the input queue when a turn is aborted mid-stream (finally safety net, no leaked stdin)', async () => {
    // Abort exits the stream loop before any `result` frame, so neither the Stop-hook allow nor the
    // first-result close fires — the queue must still be closed by runClaudeQueryAttempt's finally.
    // If it leaked, iterating `prompt` below would hang forever.
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { type: 'assistant', chunks: [{ type: 'text-delta', delta: 'partial' }] };
      handleRemoteStop(basePayload); // abort mid-turn — the executor drops the frames that follow
      yield { type: 'assistant', chunks: [{ type: 'text-delta', delta: 'never processed' }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'abort me mid-stream' });

    const prompt = claudeQueryMock.mock.calls[0]?.[0]?.prompt as AsyncIterable<{
      message: { content: unknown };
    }>;
    const seen: unknown[] = [];
    for await (const m of prompt) seen.push(m.message.content);
    expect(seen).toHaveLength(1); // the buffered initial turn, then the queue is closed → loop ends
  });

  it('includes failedSessionId on execute:error after resume retry is exhausted', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    const noConversationErr =
      'Claude Code returned an error result: No conversation found with session ID: dead-sess';
    claudeQueryMock
      // biome-ignore lint/correctness/useYield: intentional — throw on first next() like production SDK
      .mockImplementationOnce(async function* () {
        throw new Error(noConversationErr);
      })
      // biome-ignore lint/correctness/useYield: intentional — second attempt also fails
      .mockImplementationOnce(async function* () {
        throw new Error(noConversationErr);
      });

    await handleRemoteExecute({
      ...basePayload,
      message: 'stale resume twice',
      sessionId: 'dead-sess',
    });

    expect(vi.mocked(socketClient.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Claude execution failed. Please try again.',
        failedSessionId: 'dead-sess',
      }),
    );
  });

  it('does not retry Claude execution for non-resume errors', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryThrowOnce(new Error('rate limit exceeded'));

    await handleRemoteExecute({
      ...basePayload,
      message: 'non-resume failure should not retry',
      sessionId: 'session-x',
    });

    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).toHaveBeenCalled();
  });

  it('does not retry when no persisted session was provided', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryThrowOnce(new Error('invalid session'));

    await handleRemoteExecute({
      ...basePayload,
      message: 'fresh run invalid session should not retry',
    });

    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).toHaveBeenCalled();
  });

  it('does not emit execute:error when Claude process is aborted by user', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryThrowOnce(new Error('Claude Code process aborted by user'));

    await handleRemoteExecute({
      ...basePayload,
      message: 'stop this run',
      sessionId: 'session-user-stop',
    });

    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
  });

  it.each(USER_ABORT_ERROR_VARIANTS)(
    'suppresses execute:error for abort variant: %s',
    async (abortErrorText) => {
      vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
      claudeQueryThrowOnce(new Error(abortErrorText));

      await handleRemoteExecute({
        ...basePayload,
        message: 'stop this run variant',
        sessionId: 'session-user-stop-variant',
      });

      const clientModule = await import('./client');
      expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
    },
  );

  it('keeps sub-chat session isolation under parallel sends', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(runCodexAgent).mockImplementation(async function* (input) {
      await Promise.resolve();
      const sessionId = input.prompt.includes('sub-a')
        ? 'sess-sub-a'
        : input.prompt.includes('sub-b')
          ? 'sess-sub-b'
          : 'sess-unknown';
      yield {
        type: 'finish',
        messageMetadata: { sessionId, resumedFrom: input.resumeThreadId },
      } as UIMessageChunk;
    });

    await Promise.all([
      handleRemoteExecute({
        ...basePayload,
        chatId: 'chat-parallel-1',
        subChatId: '55555555-5555-4555-8555-555555555555',
        message: 'first parallel message sub-a',
      }),
      handleRemoteExecute({
        ...basePayload,
        chatId: 'chat-parallel-1',
        subChatId: '66666666-6666-4666-8666-666666666666',
        message: 'first parallel message sub-b',
      }),
    ]);

    await handleRemoteExecute({
      ...basePayload,
      chatId: 'chat-parallel-1',
      subChatId: '55555555-5555-4555-8555-555555555555',
      message: 'follow up sub-a',
    });

    expect(vi.mocked(runCodexAgent).mock.calls[0]?.[0]?.resumeThreadId).toBeUndefined();
    expect(vi.mocked(runCodexAgent).mock.calls[1]?.[0]?.resumeThreadId).toBeUndefined();
    expect(vi.mocked(runCodexAgent).mock.calls[2]?.[0]?.resumeThreadId).toBe('sess-sub-a');
  }, 25_000);

  it('keeps approved-plan handoff explicit without implicit continue on fresh agent turns', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-approved-edge' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'implement approved plan',
      approvedPlanContext: {
        planId: 'plan-edge-1',
        planText: 'Use explicit approved plan handoff.',
      },
    });

    const queryInput = claudeQueryMock.mock.calls[0]?.[0] as {
      prompt?: unknown;
      options?: { resume?: string; continue?: boolean };
    };
    const prompt = await claudePromptText(queryInput.prompt);
    expect(prompt).toContain('<approved_plan>');
    expect(prompt).toContain('Use explicit approved plan handoff.');
    expect(queryInput.options?.resume).toBeUndefined();
    expect(queryInput.options?.continue).toBeUndefined();
  });

  it('uses chat worktree_path as cwd for provider execution when available', async () => {
    const worktreePath = '/tmp/worktrees/chat-edge-1';
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { worktreePath: worktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-worktree-cwd-1' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run in assigned worktree',
    });

    const providerCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(providerCall?.cwd).toBe(worktreePath);
  });

  it('falls back to project.path when chat worktree_path is missing on disk', async () => {
    const missingWorktreePath = '/tmp/worktrees/missing-chat-edge-1';
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { worktreePath: missingWorktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.spyOn(fs, 'existsSync').mockImplementation((targetPath: fs.PathLike) => {
      return targetPath !== missingWorktreePath;
    });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-project-cwd-1' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'run with missing worktree path',
    });

    const providerCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(providerCall?.cwd).toBe(project.path);
  });

  it('uses chat worktree_path as cwd for Claude execution when available', async () => {
    const worktreePath = '/tmp/worktrees/chat-edge-claude';
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { worktreePath: worktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-claude-worktree-1' } }],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'claude run in assigned worktree',
    });

    const claudeInput = claudeQueryMock.mock.calls[0]?.[0] as {
      options?: { cwd?: string };
    };
    expect(claudeInput.options?.cwd).toBe(worktreePath);
  });

  it('falls back to project.path for Claude execution when chat worktree_path is missing', async () => {
    const missingWorktreePath = '/tmp/worktrees/missing-chat-edge-claude';
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { worktreePath: missingWorktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.spyOn(fs, 'existsSync').mockImplementation((targetPath: fs.PathLike) => {
      return targetPath !== missingWorktreePath;
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-claude-project-1' } }],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'claude run with missing worktree path',
    });

    const claudeInput = claudeQueryMock.mock.calls[0]?.[0] as {
      options?: { cwd?: string };
    };
    expect(claudeInput.options?.cwd).toBe(project.path);
  });

  it('does not override general chat cwd with chat worktree_path', async () => {
    const worktreePath = '/tmp/worktrees/chat-edge-general';
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { worktreePath: worktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-general-cwd-1' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      projectId: '',
      message: 'general chat should stay in home dir',
    });

    const providerCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(providerCall?.cwd).toBe(os.homedir());
  });

  it('does not override virtual-folder cwd with chat worktree_path', async () => {
    const worktreePath = '/tmp/worktrees/chat-edge-virtual';
    dbProjectState.projectRow = { ...project, path: 'virtual://remote-project' };
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValueOnce({
      chat: { worktreePath: worktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-virtual-cwd-1' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'virtual folder should stay in home dir',
    });

    const providerCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    expect(providerCall?.cwd).toBe(os.homedir());
  });

  it('keeps worktree cwd isolated across concurrent executions for different chats', async () => {
    const worktreeA = '/tmp/worktrees/chat-a';
    const worktreeB = '/tmp/worktrees/chat-b';
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockImplementation(async (_db, chatId) => {
      if (chatId === 'chat-edge-a') {
        return { chat: { worktreePath: worktreeA, taskId: null }, account: null } as Awaited<
          ReturnType<typeof getChatWithProjectAccount>
        >;
      }
      if (chatId === 'chat-edge-b') {
        return { chat: { worktreePath: worktreeB, taskId: null }, account: null } as Awaited<
          ReturnType<typeof getChatWithProjectAccount>
        >;
      }
      return null;
    });
    vi.mocked(runCodexAgent).mockImplementation(async function* (input) {
      await Promise.resolve();
      yield {
        type: 'finish',
        messageMetadata: { sessionId: input.prompt.includes('chat-a') ? 'sess-a' : 'sess-b' },
      } as UIMessageChunk;
    });

    await Promise.all([
      handleRemoteExecute({
        ...basePayload,
        chatId: 'chat-edge-a',
        subChatId: '55555555-5555-4555-8555-555555555555',
        message: 'run chat-a',
      }),
      handleRemoteExecute({
        ...basePayload,
        chatId: 'chat-edge-b',
        subChatId: '66666666-6666-4666-8666-666666666666',
        message: 'run chat-b',
      }),
    ]);

    const seenCwds = new Set(
      vi
        .mocked(runCodexAgent)
        .mock.calls.map((call) => call[0]?.cwd)
        .filter((cwd): cwd is string => typeof cwd === 'string'),
    );
    expect(seenCwds.has(worktreeA)).toBe(true);
    expect(seenCwds.has(worktreeB)).toBe(true);
    expect(seenCwds.has(project.path)).toBe(false);
  });

  // Provider routing: the project-assigned account must drive which provider runs, NOT the
  // workspace default. Regression — the executor read a stale stand-in that always returned a
  // null account, so it fell back to the default account and ran the wrong provider while the UI
  // showed the assigned one (a Claude-assigned project executed as Codex). These two cover both
  // directions; the override branch (getClaudeCodeTokenById → isResolvedCredential) only runs
  // when an override is set, which no prior test exercised.
  it('runs the project-assigned Claude account, not a Codex default [provider routing]', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue({
      token: null,
      isApiKey: false,
      type: 'codex',
      label: 'codex-default',
      passthrough: true,
    });
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { taskId: null },
      account: { id: 'cred-personal-claude', label: 'Personal Claude' },
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getClaudeCodeTokenById).mockResolvedValue(claudeCredential);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { chunks: [{ type: 'finish', messageMetadata: { sessionId: 'sess-route-claude' } }] };
      yield { type: 'result' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'who are you' });

    // claudeQueryMock IS the Claude SDK seam — its invocation proves the Claude override beat the
    // Codex default. Pre-fix (null label) the Codex app-server would have run and this would fail.
    expect(vi.mocked(getClaudeCodeTokenById)).toHaveBeenCalledWith('cred-personal-claude');
    expect(claudeQueryMock).toHaveBeenCalled();
  });

  it('runs a project-assigned Codex account over a Claude default, not the default [provider routing]', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { taskId: null },
      account: { id: 'cred-work-codex', label: 'work-codex' },
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getClaudeCodeTokenById).mockResolvedValue(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-route-codex' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'run' });

    expect(vi.mocked(runCodexAgent)).toHaveBeenCalled();
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });
});

// The helpers below execute up to five full turns; keep their budget load-safe and their mocks local.
describe('provider session cache helpers', () => {
  const machineId = 'machine-1';
  const project = {
    id: 'project-1',
    user_id: 'user-1',
    name: 'Project One',
    path: '/tmp/project',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };
  const codexCredential = {
    token: null,
    isApiKey: false,
    type: 'codex' as const,
    label: 'codex-test',
    passthrough: true,
  };

  async function runExecute(
    chatId: string,
    subChatId: string,
    sessionIdFromStream: string,
  ): Promise<void> {
    vi.mocked(runCodexAgent).mockImplementation(async function* (input) {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: sessionIdFromStream, resumedFrom: input.resumeThreadId },
      } as never;
    });
    await handleRemoteExecute({
      chatId,
      subChatId,
      projectId: project.id,
      message: 'hello',
      mode: 'agent',
      assistantMessageId: `assistant-${subChatId}`,
      history: [],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCodexAgent).mockReset();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    applyExecutorMockDefaults(machineId, project);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
  });

  afterEach(() => {
    clearCodexSession('chat-a');
    clearCodexSession('chat-b');
    vi.clearAllMocks();
  });

  it('stores sessions by sub-chat ID to prevent collisions', async () => {
    await runExecute('chat-a', 'sub-1', 'sess-1');
    await runExecute('chat-a', 'sub-2', 'sess-2');
    await runExecute('chat-a', 'sub-1', 'sess-1b');

    expect(vi.mocked(runCodexAgent).mock.calls[0]?.[0]?.resumeThreadId).toBeUndefined();
    expect(vi.mocked(runCodexAgent).mock.calls[1]?.[0]?.resumeThreadId).toBeUndefined();
    expect(vi.mocked(runCodexAgent).mock.calls[2]?.[0]?.resumeThreadId).toBe('sess-1');
  }, 25_000);

  it('clears all sub-chat sessions for a parent chat ID', async () => {
    await runExecute('chat-a', 'sub-1', 'sess-1');
    await runExecute('chat-a', 'sub-2', 'sess-2');
    await runExecute('chat-b', 'sub-3', 'sess-3');

    clearCodexSession('chat-a');

    await runExecute('chat-a', 'sub-1', 'sess-1-new');
    await runExecute('chat-b', 'sub-3', 'sess-3-new');

    expect(vi.mocked(runCodexAgent).mock.calls[3]?.[0]?.resumeThreadId).toBeUndefined();
    expect(vi.mocked(runCodexAgent).mock.calls[4]?.[0]?.resumeThreadId).toBe('sess-3');
  }, 25_000);
});

describe('execute-complete payload', () => {
  const machineId = 'machine-1';
  const project = {
    id: 'project-1',
    user_id: 'user-1',
    name: 'Project One',
    path: '/tmp/project',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };
  const codexCredential = {
    token: null,
    isApiKey: false,
    type: 'codex' as const,
    label: 'codex-test',
    passthrough: true,
  };

  beforeEach(() => {
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(codexCredential);
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects approved plan context into handleRemoteExecute prompt when payload includes approvedPlanContext', async () => {
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-approved-context-1' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      chatId: 'chat-approved-context-1',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'Implement now',
      mode: 'agent',
      assistantMessageId: 'assistant-approved-context-1',
      history: [],
      approvedPlanContext: {
        planId: 'plan-ctx-1',
        planText: 'Implement API migration safely.',
      },
    });

    const latestCall = vi.mocked(runCodexAgent).mock.calls.at(-1)?.[0];
    if (!latestCall || typeof latestCall.prompt !== 'string') {
      throw new Error('Expected runCodexAgent to be called with a string prompt');
    }
    expect(latestCall.prompt).toContain('<approved_plan>');
    expect(latestCall.prompt).toContain('Implement API migration safely.');
    expect(latestCall.prompt).toContain('Implement now');
  });

  it('passes partial finalParts through the sole error terminal when claude throws', async () => {
    const claudeCredential = {
      token: 'claude-token',
      isApiKey: true,
      type: 'claude-code' as const,
      label: 'claude-test',
    };
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.mocked(getBundledClaudeBinaryPath).mockReturnValue('/mock/bin/claude');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'text-delta',
            id: 'partial-1',
            delta: 'partial output',
          } satisfies UIMessageChunk,
        ],
      };
      throw new Error('claude stream exploded');
    });

    await handleRemoteExecute({
      chatId: 'chat-claude-err',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'create plan',
      mode: 'plan',
      assistantMessageId: 'assistant-claude-err',
      history: [],
    });
    const clientModule = await import('./client');
    const [, finalization] = vi.mocked(clientModule.sendErrorDirect).mock.calls.at(-1) ?? [];
    const finalizationPayload = finalization as { finalParts?: Array<{ type?: string }> };
    expect((finalizationPayload.finalParts?.length ?? 0) > 0).toBe(true);
    expect(
      vi
        .mocked(clientModule.sendExecuteCompleteDirect)
        .mock.calls.some(([payload]) => payload.assistantMessageId === 'assistant-claude-err'),
    ).toBe(false);
  });
});

type StagedMcpServer = { env?: Record<string, string>; url?: string; command?: string };
const stagedMcpServers = (): Record<string, StagedMcpServer> => {
  const configWrite = vi
    .mocked(fs.promises.writeFile)
    .mock.calls.find(([filePath]) => /\/mcp-config-[^/]+\.json$/.test(String(filePath)));
  return JSON.parse(String(configWrite?.[1])).mcpServers;
};

describe('execution-scoped MCP URL wiring', () => {
  const machineId = 'machine-1';
  const project = {
    id: 'project-url-1',
    user_id: 'user-1',
    name: 'URL Project',
    path: '/tmp/project-url',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  it('addresses Claude frink_dynamic_chat by its channel and toolset, never an executionId', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue({
      token: 'claude-token',
      isApiKey: true,
      type: 'claude-code',
      label: 'claude-test',
    });
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:7100',
    });
    vi.mocked(getBundledClaudeBinaryPath).mockReturnValue('/mock/bin/claude');
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield { type: 'result' };
      await new Promise(() => {}); // the CLI stays up, idle, with its channel live
    });

    await handleRemoteExecute({
      chatId: 'chat-ctx-2',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'run claude',
      mode: 'agent',
      assistantMessageId: 'assistant-ctx-2',
      history: [],
    });

    const mcpUrl = stagedMcpServers().frink_dynamic_chat?.url;
    expect(mcpUrl).toBeDefined();
    const parsed = new URL(mcpUrl as string);
    expect(parsed.searchParams.get('executionId')).toBeNull();
    expect(channelOwner(parsed.searchParams.get('channel') ?? '')?.runtime).toBe('claude');
    expect(parsed.searchParams.get('toolset')).toBe('nosignal');
  });
});

describe('Claude MCP runtime loading', () => {
  const machineId = 'machine-1';
  const project = {
    id: 'project-mcp-1',
    user_id: 'user-1',
    name: 'MCP Project',
    path: '/tmp/project-mcp',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };
  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  beforeEach(() => {
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    // Keep these tests local-only; project scope map is not relevant here.
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: null,
    });
    vi.mocked(getBundledClaudeBinaryPath).mockReturnValue('/mock/bin/claude');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
  });

  afterEach(() => {
    delete process.env.EXA_API_KEY;
    delete process.env.QAVIS_ARGV_SECRET_CANARY;
  });

  it('includes env_var MCP when required key exists in process env', async () => {
    process.env.EXA_API_KEY = 'exa-secret';
    process.env.QAVIS_ARGV_SECRET_CANARY = 'ambient-secret-canary';
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      exa: {
        name: 'exa',
        description: 'Imported from Cursor',
        type: 'custom',
        authType: 'env_var',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        requiredEnvVars: ['EXA_API_KEY'],
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(async function* () {
      vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error('cleanup busy'));
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-mcp-env-1' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-mcp-env-1',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test mcp env',
      mode: 'agent',
      assistantMessageId: 'assistant-mcp-env-1',
      history: [],
    });

    const queryOptions = claudeQueryMock.mock.calls[0]?.[0]?.options;
    expect(queryOptions).not.toHaveProperty('mcpServers');
    const servers = stagedMcpServers();
    expect(servers.exa?.env?.EXA_API_KEY).toBe('exa-secret');
    expect(JSON.stringify(servers)).not.toContain('ambient-secret-canary');
    const { captureMainException } = await import('../sentry/init');
    expect(vi.mocked(captureMainException)).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ surface: 'claude-mcp-config-cleanup' }),
    );
  });

  it('keeps authType none HTTP MCPs without stored credentials', async () => {
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      public_http: {
        name: 'public_http',
        description: 'No auth HTTP MCP',
        type: 'cloud_api',
        authType: 'none',
        command: '',
        args: [],
        url: 'https://example.com/mcp',
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-mcp-http-1' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-mcp-http-1',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test http mcp',
      mode: 'agent',
      assistantMessageId: 'assistant-mcp-http-1',
      history: [],
    });

    expect(claudeQueryMock).toHaveBeenCalled();
    const servers = stagedMcpServers();
    expect(servers.public_http).toBeDefined();
    expect(servers.public_http?.url).toBe('https://example.com/mcp');
  });

  it('merges process env for non-env_var MCPs that only provide creds.env', async () => {
    process.env.PATH = '/usr/bin';
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      exa: {
        name: 'exa',
        description: 'Imported from Cursor',
        type: 'custom',
        authType: 'api_key',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue({
      env: {
        EXA_API_KEY: 'exa-secret',
      },
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-mcp-api-key-1' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-mcp-api-key-1',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test mcp api_key env merge',
      mode: 'agent',
      assistantMessageId: 'assistant-mcp-api-key-1',
      history: [],
    });

    const servers = stagedMcpServers();
    expect(servers.exa?.env?.EXA_API_KEY).toBe('exa-secret');
    expect(servers.exa?.env?.PATH).toBe('/usr/bin');
  });

  it('forces public npm registry for npx MCPs when no registry is configured', async () => {
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      exa: {
        name: 'exa',
        description: 'Imported from Cursor',
        type: 'custom',
        authType: 'env_var',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        requiredEnvVars: ['EXA_API_KEY'],
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue({
      env: {
        EXA_API_KEY: 'exa-secret',
      },
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-mcp-registry-default-1' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-mcp-registry-default-1',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test mcp registry default',
      mode: 'agent',
      assistantMessageId: 'assistant-mcp-registry-default-1',
      history: [],
    });

    const servers = stagedMcpServers();
    expect(servers.exa?.env?.npm_config_registry).toBe('https://registry.npmjs.org/');
  });

  it('preserves explicit npm registry for npx MCPs', async () => {
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      exa: {
        name: 'exa',
        description: 'Imported from Cursor',
        type: 'custom',
        authType: 'env_var',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        requiredEnvVars: ['EXA_API_KEY'],
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue({
      env: {
        EXA_API_KEY: 'exa-secret',
        npm_config_registry: 'https://npm-proxy.example.com/private',
      },
    });
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-mcp-registry-private-1' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-mcp-registry-private-1',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test mcp registry private',
      mode: 'agent',
      assistantMessageId: 'assistant-mcp-registry-private-1',
      history: [],
    });

    const servers = stagedMcpServers();
    expect(servers.exa?.env?.npm_config_registry).toBe('https://npm-proxy.example.com/private');
  });

  it('skips disabled MCPs', async () => {
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      disabled_mcp: {
        name: 'disabled_mcp',
        description: 'Disabled server',
        type: 'custom',
        authType: 'none',
        command: 'node',
        args: ['server.js'],
        enabled: false,
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-disabled' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-disabled',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test disabled',
      mode: 'agent',
      assistantMessageId: 'assistant-disabled',
      history: [],
    });

    const queryInput = claudeQueryMock.mock.calls[0]?.[0] as {
      options?: { extraArgs?: Record<string, string | null> };
    };
    expect(queryInput.options?.extraArgs?.['mcp-config']).toBeUndefined();
  });

  it('includes bearer HTTP MCP without credentials (SDK handles auth status)', async () => {
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      neon: {
        name: 'neon',
        description: 'Neon DB',
        type: 'cloud_api',
        authType: 'bearer',
        command: '',
        url: 'https://mcp.neon.tech/mcp',
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-bearer' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-bearer',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test bearer',
      mode: 'agent',
      assistantMessageId: 'assistant-bearer',
      history: [],
    });

    const servers = stagedMcpServers();
    expect(servers.neon).toBeDefined();
    expect(servers.neon?.url).toBe('https://mcp.neon.tech/mcp');
  });

  it('includes env_var MCP with missing keys (warns but does not filter)', async () => {
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      exa: {
        name: 'exa',
        description: 'Exa search',
        type: 'custom',
        authType: 'env_var',
        command: 'npx',
        args: ['-y', 'exa-mcp-server'],
        requiredEnvVars: ['EXA_API_KEY'],
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-missing-env' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-missing-env',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test missing env',
      mode: 'agent',
      assistantMessageId: 'assistant-missing-env',
      history: [],
    });

    expect(stagedMcpServers().exa).toBeDefined();
  });

  it('includes stdio MCP with missing script path (warns but passes to SDK)', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (String(p) === '/deleted/mcp-server.js') return false;
      return true;
    });
    vi.mocked(getGlobalMcpServers).mockImplementation(async () => ({
      stale_mcp: {
        name: 'stale_mcp',
        description: 'Moved server',
        type: 'custom',
        authType: 'none',
        command: 'node',
        args: ['/deleted/mcp-server.js'],
      },
    }));
    vi.mocked(getMcpCredentials).mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          { type: 'finish', messageMetadata: { sessionId: 'sess-stale' } } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      chatId: 'chat-stale',
      subChatId: '11111111-1111-4111-8111-111111111111',
      projectId: project.id,
      message: 'test stale path',
      mode: 'agent',
      assistantMessageId: 'assistant-stale',
      history: [],
    });

    const servers = stagedMcpServers();
    expect(servers.stale_mcp).toBeDefined();
    expect(servers.stale_mcp?.command).toBe('node');
  });
});

describe('prompt composition helpers', () => {
  it('prepends approved plan context block when plan context exists', () => {
    const prompt = applyApprovedPlanContextToPrompt('Implement now', {
      planId: 'plan-ctx-1',
      planText: 'Build feature X',
    });
    expect(prompt).toContain('<approved_plan>');
    expect(prompt).toContain('Build feature X');
    expect(prompt).toContain('Implement now');
  });

  it('does not prepend approved plan block when context is missing', () => {
    expect(applyApprovedPlanContextToPrompt('Implement now', undefined)).toBe('Implement now');
  });
});

describe('native plan path extraction', () => {
  it('extracts native plan path from PlanWrite input', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw1',
        toolName: 'PlanWrite',
        input: { plan: { filePath: '/tmp/from-planwrite.plan.md' } },
      },
    ];

    expect(extractNativePlanPathFromChunks(chunks)).toBe('/tmp/from-planwrite.plan.md');
  });

  it('extracts native plan path from PlanWrite output.filePath', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-output-1',
        toolName: 'PlanWrite',
        input: {},
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-output-1',
        output: { plan: 'x', filePath: '/tmp/from-planwrite-output.plan.md' },
      },
    ];

    expect(extractNativePlanPathFromChunks(chunks)).toBe('/tmp/from-planwrite-output.plan.md');
  });

  it('extracts native plan path from nested output.plan.filePath', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-output-2',
        toolName: 'PlanWrite',
        input: {},
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-output-2',
        output: { plan: { filePath: '/tmp/from-nested-output.plan.md' } },
      },
    ];

    expect(extractNativePlanPathFromChunks(chunks)).toBe('/tmp/from-nested-output.plan.md');
  });

  it('extracts native plan path from output planPath and file_path variants', () => {
    const outputPlanPathChunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-output-3',
        toolName: 'PlanWrite',
        input: {},
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-output-3',
        output: { planPath: '/tmp/from-output-planPath.plan.md' },
      },
    ];
    expect(extractNativePlanPathFromChunks(outputPlanPathChunks)).toBe(
      '/tmp/from-output-planPath.plan.md',
    );

    const outputSnakeCaseChunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-output-4',
        toolName: 'PlanWrite',
        input: {},
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-output-4',
        output: { file_path: '/tmp/from-output-file_path.plan.md' },
      },
    ];
    expect(extractNativePlanPathFromChunks(outputSnakeCaseChunks)).toBe(
      '/tmp/from-output-file_path.plan.md',
    );
  });

  it('keeps first non-empty PlanWrite path when later PlanWrite outputs arrive', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-mixed-1',
        toolName: 'PlanWrite',
        input: { filePath: '/tmp/from-planwrite-input.plan.md' },
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-mixed-1',
        output: { plan: { filePath: '/tmp/from-planwrite-output.plan.md' } },
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-mixed-1',
        output: { filePath: '/tmp/from-planwrite-output-2.plan.md' },
      },
    ];

    expect(extractNativePlanPathFromChunks(chunks)).toBe('/tmp/from-planwrite-input.plan.md');
  });

  it('ignores empty-string path fields from native input/output payloads', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-empty-1',
        toolName: 'PlanWrite',
        input: { filePath: '', plan: { filePath: '' } },
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-empty-1',
        output: { planPath: '', file_path: '' },
      },
    ];

    expect(extractNativePlanPathFromChunks(chunks)).toBeNull();
  });

  it('extracts native plan path from nested output.plan.plan_path', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'pw-output-snake-nested-1',
        toolName: 'PlanWrite',
        input: {},
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'pw-output-snake-nested-1',
        output: { plan: { plan_path: '/tmp/from-nested-plan_path.plan.md' } },
      },
    ];

    expect(extractNativePlanPathFromChunks(chunks)).toBe('/tmp/from-nested-plan_path.plan.md');
  });
});

describe('buildPartsFromChunks', () => {
  it('propagates permissionDenied to part.output when tool-output-error has permissionDenied: true', () => {
    const chunks = [
      { type: 'tool-input-available' as const, toolCallId: 'bash-1', toolName: 'Bash', input: {} },
      {
        type: 'tool-output-error' as const,
        toolCallId: 'bash-1',
        errorText: 'Bash command denied by policy.',
        permissionDenied: true,
      },
    ];
    const parts = buildPartsFromChunks(chunks);
    const toolPart = parts.find((p) => p.type === 'tool-Bash' && p.toolCallId === 'bash-1');
    expect(toolPart).toBeDefined();
    expect(toolPart?.state).toBe('output-error');
    expect((toolPart?.output as Record<string, unknown>)?.permissionDenied).toBe(true);
    expect((toolPart?.output as Record<string, unknown>)?.error).toBe(
      'Bash command denied by policy.',
    );
  });

  it('does not set part.output when tool-output-error has no permissionDenied', () => {
    const chunks = [
      { type: 'tool-input-available' as const, toolCallId: 'bash-2', toolName: 'Bash', input: {} },
      {
        type: 'tool-output-error' as const,
        toolCallId: 'bash-2',
        errorText: 'Command not found: poetry',
      },
    ];
    const parts = buildPartsFromChunks(chunks);
    const toolPart = parts.find((p) => p.type === 'tool-Bash' && p.toolCallId === 'bash-2');
    expect(toolPart).toBeDefined();
    expect(toolPart?.state).toBe('output-error');
    expect(toolPart?.errorText).toBe('Command not found: poetry');
    expect(
      (toolPart?.output as Record<string, unknown> | undefined)?.permissionDenied,
    ).toBeUndefined();
  });

  it('upserts repeated tool-input-available by toolCallId instead of appending duplicates', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'thinking-1',
        toolName: 'Thinking',
        input: { text: 'first' },
      },
      {
        type: 'tool-input-available' as const,
        toolCallId: 'thinking-1',
        toolName: 'Thinking',
        input: { text: 'second' },
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'thinking-1',
        output: { completed: true },
      },
      {
        type: 'tool-input-available' as const,
        toolCallId: 'thinking-1',
        toolName: 'Thinking',
        input: { text: 'replayed-input' },
      },
    ];

    const parts = buildPartsFromChunks(chunks);
    const thinkingParts = parts.filter(
      (p) => p.type === 'tool-Thinking' && p.toolCallId === 'thinking-1',
    );

    expect(thinkingParts).toHaveLength(1);
    const thinkingPart = thinkingParts[0];
    expect(thinkingPart.input).toEqual({ text: 'replayed-input' });
    // Replayed input should not downgrade a finished tool back to input-available.
    expect(thinkingPart.state).toBe('output-available');
    expect(thinkingPart.output).toEqual({ completed: true });
  });

  it('keeps output-error state when replayed input arrives for same toolCallId', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'thinking-error-1',
        toolName: 'Thinking',
        input: { text: 'first' },
      },
      {
        type: 'tool-output-error' as const,
        toolCallId: 'thinking-error-1',
        errorText: 'stream interrupted',
      },
      {
        type: 'tool-input-available' as const,
        toolCallId: 'thinking-error-1',
        toolName: 'Thinking',
        input: { text: 'replayed-input' },
      },
    ];

    const parts = buildPartsFromChunks(chunks);
    const thinkingParts = parts.filter(
      (p) => p.type === 'tool-Thinking' && p.toolCallId === 'thinking-error-1',
    );

    expect(thinkingParts).toHaveLength(1);
    const thinkingPart = thinkingParts[0];
    expect(thinkingPart.input).toEqual({ text: 'replayed-input' });
    expect(thinkingPart.state).toBe('output-error');
    expect(thinkingPart.errorText).toBe('stream interrupted');
  });

  it('preserves canonical frink-plan payload fields for persistence snapshots', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'frink-plan-1',
        toolName: 'frink-plan',
        input: {
          planId: 'frink-plan-1',
          summary: 'Implement plan persistence hardening',
          planText: '## Plan\nHarden persistence',
          planPath: '/tmp/persist.plan.md',
          status: 'awaiting_approval',
        },
      },
      {
        type: 'tool-output-available' as const,
        toolCallId: 'frink-plan-1',
        output: { success: true },
      },
    ];

    const parts = buildPartsFromChunks(chunks);
    const planPart = parts.find(
      (part) => part.type === 'tool-frink-plan' && part.toolCallId === 'frink-plan-1',
    );

    expect(planPart).toBeDefined();
    expect(planPart?.state).toBe('output-available');
    expect(planPart?.input).toEqual(
      expect.objectContaining({
        summary: 'Implement plan persistence hardening',
        planText: '## Plan\nHarden persistence',
        planPath: '/tmp/persist.plan.md',
        status: 'awaiting_approval',
      }),
    );
  });

  it('applies ask-user-question-result chunks to the matching AskUserQuestion tool part', () => {
    const chunks = [
      {
        type: 'tool-input-available' as const,
        toolCallId: 'ask-tool-1',
        toolName: 'AskUserQuestion',
        input: { questions: [] },
      },
      {
        type: 'ask-user-question-result' as const,
        toolUseId: 'ask-tool-1',
        result: { answers: { q: 'a' } },
      },
    ];
    const parts = buildPartsFromChunks(chunks);
    const toolPart = parts.find(
      (p) => p.type === 'tool-AskUserQuestion' && p.toolCallId === 'ask-tool-1',
    );
    expect(toolPart).toBeDefined();
    expect(toolPart?.state).toBe('output-available');
    expect(toolPart?.result).toEqual({ answers: { q: 'a' } });
  });
});

describe('incremental parts state (applyChunkToParts / partsSnapshot)', () => {
  // The streaming hot path mutates a `PartsState` per chunk instead of
  // re-walking `chunks` every event. These tests pin the observational
  // equivalence between the incremental builder and `buildPartsFromChunks`,
  // and the invariants the IPC/socket emit hot path depends on.

  const longFileEditChunks = (lineCount: number): UIMessageChunk[] => [
    { type: 'start-step' },
    {
      type: 'tool-input-available' as const,
      toolCallId: 'edit-1',
      toolName: 'Edit',
      input: {
        file_path: '/big.ts',
        old_string: 'a'.repeat(lineCount * 80),
        new_string: 'b'.repeat(lineCount * 80),
      },
    },
    { type: 'tool-output-available' as const, toolCallId: 'edit-1', output: { ok: true } },
    { type: 'text-start' as const, id: 'txt-1' } as UIMessageChunk,
    { type: 'text-delta' as const, id: 'txt-1', delta: 'Done.' } as UIMessageChunk,
    { type: 'text-end' as const, id: 'txt-1' } as UIMessageChunk,
  ];

  it('matches buildPartsFromChunks output for every prefix of a long Edit stream', () => {
    const chunks = longFileEditChunks(300);
    const state = createPartsState();

    for (let i = 0; i < chunks.length; i++) {
      applyChunkToParts(state, chunks[i]);
      const snapshotIncremental = partsSnapshot(state);
      const snapshotFromScratch = buildPartsFromChunks(chunks.slice(0, i + 1));
      expect(snapshotIncremental).toEqual(snapshotFromScratch);
    }
  });

  it('exposes in-flight text-delta in the snapshot before text-end arrives', () => {
    const state = createPartsState();
    applyChunkToParts(state, { type: 'start-step' });
    applyChunkToParts(state, { type: 'text-start', id: 't1' } as UIMessageChunk);

    applyChunkToParts(state, { type: 'text-delta', id: 't1', delta: 'Hel' } as UIMessageChunk);
    let snap = partsSnapshot(state);
    let textPart = snap.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();
    expect((textPart as { text: string }).text).toBe('Hel');

    applyChunkToParts(state, { type: 'text-delta', id: 't1', delta: 'lo' } as UIMessageChunk);
    snap = partsSnapshot(state);
    textPart = snap.find((p) => p.type === 'text');
    expect((textPart as { text: string }).text).toBe('Hello');

    // text-end flushes; the snapshot should still report the same content.
    applyChunkToParts(state, { type: 'text-end', id: 't1' } as UIMessageChunk);
    snap = partsSnapshot(state);
    textPart = snap.find((p) => p.type === 'text');
    expect((textPart as { text: string }).text).toBe('Hello');
  });

  it('does not double-flush text when a snapshot is taken between deltas', () => {
    // Regression: an earlier draft synthesised a transient text part on each
    // snapshot but also flushed into `state.parts` on the next chunk — that
    // would have produced two adjacent text parts for one logical text block.
    const state = createPartsState();
    applyChunkToParts(state, { type: 'text-start', id: 't1' } as UIMessageChunk);
    applyChunkToParts(state, { type: 'text-delta', id: 't1', delta: 'one' } as UIMessageChunk);
    partsSnapshot(state); // observed
    applyChunkToParts(state, { type: 'text-delta', id: 't1', delta: 'two' } as UIMessageChunk);
    partsSnapshot(state); // observed
    applyChunkToParts(state, { type: 'text-end', id: 't1' } as UIMessageChunk);

    const snap = partsSnapshot(state);
    const textParts = snap.filter((p) => p.type === 'text');
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as { text: string }).text).toBe('onetwo');
  });

  it('createPartsState returns isolated state — retries do not leak prior tool calls', () => {
    // Mirrors the resume-fallback retry path in `consumeStream` where the
    // SDK is re-invoked: each retry must start from a fresh PartsState.
    const stateA = createPartsState();
    applyChunkToParts(stateA, {
      type: 'tool-input-available',
      toolCallId: 'a-1',
      toolName: 'Read',
      input: { file_path: '/a' },
    });

    const stateB = createPartsState();
    expect(stateB.parts).toHaveLength(0);
    expect(stateB.toolPartsById.size).toBe(0);
    expect(partsSnapshot(stateB)).toHaveLength(0);

    // Mutating stateB does not affect stateA.
    applyChunkToParts(stateB, {
      type: 'tool-input-available',
      toolCallId: 'b-1',
      toolName: 'Write',
      input: { file_path: '/b' },
    });
    expect(stateA.parts.find((p) => p.toolCallId === 'b-1')).toBeUndefined();
    expect(stateB.parts.find((p) => p.toolCallId === 'a-1')).toBeUndefined();
  });

  it('partsSnapshot returns the underlying parts when there is no in-flight text — same reference across calls', () => {
    // The IPC/socket hot path relies on this: both sinks serialise their
    // payload synchronously before yielding, so handing them the live array
    // reference is safe and avoids per-chunk allocation. Pin the contract.
    const state = createPartsState();
    applyChunkToParts(state, {
      type: 'tool-input-available',
      toolCallId: 'edit-1',
      toolName: 'Edit',
      input: { file_path: '/x' },
    });
    const snap1 = partsSnapshot(state);
    const snap2 = partsSnapshot(state);
    expect(snap1).toBe(snap2);
    expect(snap1).toBe(state.parts);
  });

  it('partsSnapshot allocates a fresh wrapper while text is in flight', () => {
    // While text-delta is accumulating, the snapshot must include the
    // pending currentText as a synthetic text part. That MUST be a new
    // array (not aliasing state.parts) so a downstream serializer cannot
    // observe the synthetic text leak into state.parts later.
    const state = createPartsState();
    applyChunkToParts(state, { type: 'text-start', id: 't1' } as UIMessageChunk);
    applyChunkToParts(state, { type: 'text-delta', id: 't1', delta: 'hi' } as UIMessageChunk);
    const snap = partsSnapshot(state);
    expect(snap).not.toBe(state.parts);
    expect(snap.length).toBe(state.parts.length + 1);
    expect(snap[snap.length - 1]).toMatchObject({ type: 'text', text: 'hi' });
  });

  it('preserves giant tool-input strings without copying — tool input identity stable across snapshots', () => {
    // The whole point of incremental state: the giant Edit input string is
    // *not* re-allocated per chunk. Verify by checking object identity of
    // the tool part across multiple snapshots taken between unrelated chunks.
    const giantInput = { file_path: '/x', content: 'z'.repeat(200_000) };
    const state = createPartsState();
    applyChunkToParts(state, {
      type: 'tool-input-available',
      toolCallId: 'edit-big',
      toolName: 'Edit',
      input: giantInput,
    });
    const toolPartFirst = partsSnapshot(state).find((p) => p.toolCallId === 'edit-big');

    // Apply a series of unrelated chunks (text, tool-output) and snapshot
    // each time. The original tool part object must persist by identity.
    applyChunkToParts(state, { type: 'text-start', id: 't1' } as UIMessageChunk);
    applyChunkToParts(state, { type: 'text-delta', id: 't1', delta: 'ok' } as UIMessageChunk);
    applyChunkToParts(state, { type: 'text-end', id: 't1' } as UIMessageChunk);
    const toolPartLater = partsSnapshot(state).find((p) => p.toolCallId === 'edit-big');

    expect(toolPartLater).toBe(toolPartFirst);
    expect(toolPartLater?.input).toBe(giantInput);
  });
});

describe('plan-mode stream helpers', () => {
  it('suppresses plan-tool chunks when canonical plan UI is enabled', () => {
    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'p1',
          toolName: 'PlanWrite',
          input: {},
        },
        true,
      ),
    ).toBe(true);

    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'tool-output-available',
          toolCallId: 'e2',
          output: {},
        },
        true,
      ),
    ).toBe(false);

    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'tool-output-available',
          toolCallId: 'e2',
          output: {},
        },
        true,
        new Map([['e2', 'PlanWrite']]),
      ),
    ).toBe(true);

    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'b1',
          toolName: 'Bash',
          input: {},
        },
        true,
      ),
    ).toBe(false);

    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'text-delta',
          id: 't1',
          delta: 'hello',
        },
        true,
      ),
    ).toBe(false);
  });

  it('suppresses PlanWrite tool-input-start and following tool-input-delta in plan mode', () => {
    const ids = new Set<string>();
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-start',
          toolCallId: 'pw1',
          toolName: 'PlanWrite',
        },
        true,
        ids,
      ),
    ).toBe(true);
    expect(ids.has('pw1')).toBe(true);
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-delta',
          toolCallId: 'pw1',
          inputTextDelta: '{"',
        },
        true,
        ids,
      ),
    ).toBe(true);
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-delta',
          toolCallId: 'other',
          inputTextDelta: 'x',
        },
        true,
        ids,
      ),
    ).toBe(false);
  });

  it('suppresses Claude SDK Write (plan file) tool-input-start and deltas in plan mode', () => {
    const ids = new Set<string>();
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-start',
          toolCallId: 'w-plan',
          toolName: 'Write',
        },
        true,
        ids,
      ),
    ).toBe(true);
    expect(ids.has('w-plan')).toBe(true);
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-delta',
          toolCallId: 'w-plan',
          inputTextDelta: '# Plan',
        },
        true,
        ids,
      ),
    ).toBe(true);
    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'w-plan',
          toolName: 'Write',
          input: { file_path: '/tmp/plan.md' },
        },
        true,
      ),
    ).toBe(true);
    expect(
      shouldSuppressNativePlanToolChunk(
        {
          type: 'tool-output-available',
          toolCallId: 'w-plan',
          output: {},
        },
        true,
        new Map([['w-plan', 'Write']]),
      ),
    ).toBe(true);
  });

  it('suppresses Claude SDK ExitPlanMode tool-input-start and deltas in plan mode', () => {
    const ids = new Set<string>();
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-start',
          toolCallId: 'exit-1',
          toolName: 'ExitPlanMode',
        },
        true,
        ids,
      ),
    ).toBe(true);
    expect(ids.has('exit-1')).toBe(true);
    expect(
      shouldSuppressNativePlanStreamChunk(
        {
          type: 'tool-input-delta',
          toolCallId: 'exit-1',
          inputTextDelta: '{}',
        },
        true,
        ids,
      ),
    ).toBe(true);
  });

  it('suppresses only text chunks in plan mode when enabled', () => {
    expect(
      shouldSuppressPlanTextChunk(
        {
          type: 'text-start',
          id: 't1',
        },
        true,
      ),
    ).toBe(true);
    expect(
      shouldSuppressPlanTextChunk(
        {
          type: 'text-delta',
          id: 't1',
          delta: 'hello',
        },
        true,
      ),
    ).toBe(true);
    expect(
      shouldSuppressPlanTextChunk(
        {
          type: 'text-end',
          id: 't1',
        },
        true,
      ),
    ).toBe(true);

    expect(
      shouldSuppressPlanTextChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'f1',
          toolName: 'frink-plan',
          input: {},
        },
        true,
      ),
    ).toBe(false);
    expect(
      shouldSuppressPlanTextChunk(
        {
          type: 'text-delta',
          id: 't2',
          delta: 'visible',
        },
        false,
      ),
    ).toBe(false);
  });

  it('suppresses ExitPlanMode tool input and output when enabled', () => {
    const toolNameByCallId = new Map<string, string>([['exit-1', 'ExitPlanMode']]);
    expect(
      shouldSuppressExitPlanModeToolChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'exit-1',
          toolName: 'ExitPlanMode',
          input: {},
        },
        true,
        toolNameByCallId,
      ),
    ).toBe(true);
    expect(
      shouldSuppressExitPlanModeToolChunk(
        {
          type: 'tool-output-available',
          toolCallId: 'exit-1',
          output: { success: true },
        },
        true,
        toolNameByCallId,
      ),
    ).toBe(true);
    expect(
      shouldSuppressExitPlanModeToolChunk(
        {
          type: 'tool-input-available',
          toolCallId: 'w1',
          toolName: 'Write',
          input: {},
        },
        true,
        toolNameByCallId,
      ),
    ).toBe(false);
  });

  it('filters plan reload parts while preserving non-plan text', () => {
    const filtered = filterCanonicalPlanParts(
      [
        { type: 'text', text: 'Thinking: selecting a todo item' },
        { type: 'text', text: 'raw plan markdown' },
        { type: 'tool-PlanWrite', toolName: 'PlanWrite', toolCallId: 'p1' },
        { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
      ],
      'raw plan markdown',
    );

    expect(filtered).toEqual([
      { type: 'text', text: 'Thinking: selecting a todo item' },
      { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
    ]);
  });

  it('preserves pre-heading reasoning when text part contains reasoning plus full plan markdown', () => {
    const rawPlan =
      '## Overview\nShip feature X.\n\n## Implementation Steps\n1. Do A\n2. Do B\n\n## Execution Summary\nShort summary.';
    const mixedText =
      'I will first inspect the todo files and existing conventions before drafting the plan.\n\n' +
      rawPlan;

    const filtered = filterCanonicalPlanParts(
      [
        { type: 'text', text: mixedText },
        { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
      ],
      rawPlan,
    );

    expect(filtered).toEqual([
      {
        type: 'text',
        text: 'I will first inspect the todo files and existing conventions before drafting the plan.',
      },
      { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
    ]);
  });

  it('preserves non-plan preamble when plan text has no markdown heading', () => {
    const rawPlan = 'Step 1. Do A\nStep 2. Do B';
    const mixedText = 'I will verify assumptions first.\n\nStep 1. Do A\nStep 2. Do B';

    const filtered = filterCanonicalPlanParts(
      [
        { type: 'text', text: mixedText },
        { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
      ],
      rawPlan,
    );

    expect(filtered).toEqual([
      {
        type: 'text',
        text: 'I will verify assumptions first.',
      },
      { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
    ]);
  });

  it('keeps original text when plan text is absent from text parts', () => {
    const filtered = filterCanonicalPlanParts(
      [
        { type: 'text', text: 'A non-plan assistant update.' },
        { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
      ],
      '## Overview\nActual plan text',
    );

    expect(filtered).toEqual([
      { type: 'text', text: 'A non-plan assistant update.' },
      { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
    ]);
  });

  it('drops duplicate plan markdown text despite leading/trailing whitespace differences', () => {
    const rawPlan = '## Overview\nPlan text.\n\n## Execution Summary\nShort summary.';
    const filtered = filterCanonicalPlanParts(
      [
        { type: 'text', text: `\n\n   ${rawPlan}   \n` },
        { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
      ],
      rawPlan,
    );

    expect(filtered).toEqual([
      { type: 'tool-frink-plan', toolName: 'frink-plan', toolCallId: 'f1' },
    ]);
  });
});

describe('buildPlanFallbackSends', () => {
  // Plan mode hides prose behind the plan card. When a turn ends with no card the prose must be
  // replayed, or the live stream stays blank while a reload shows text the user never saw stream.
  const prose = (): UIMessageChunk[] => [
    { type: 'text-start', id: 'p' } as UIMessageChunk,
    { type: 'text-delta', id: 'p', delta: 'drafted plan' } as UIMessageChunk,
    { type: 'text-end', id: 'p' } as UIMessageChunk,
  ];
  const noise = (): UIMessageChunk[] => [
    {
      type: 'tool-input-available',
      toolCallId: 'c1',
      toolName: 'PlanWrite',
      input: {},
    } as UIMessageChunk,
    { type: 'tool-output-available', toolCallId: 'c1', output: {} } as UIMessageChunk,
    { type: 'finish' } as UIMessageChunk,
  ];

  it('replays only the text chunks plan mode suppressed, in stream order', () => {
    const sends = buildPlanFallbackSends([...noise(), ...prose()], 0, null);
    expect(sends.map((s) => s.chunk.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    expect(sends.every((s) => !s.isNotice)).toBe(true);
  });

  it('numbers sends from startIndex so a replay never lands on an already-applied index', () => {
    const sends = buildPlanFallbackSends(prose(), 7, null);
    expect(sends.map((s) => s.messageIndex)).toEqual([7, 8, 9]);
  });

  it('appends the notice as a complete text block under a single id', () => {
    const sends = buildPlanFallbackSends([], 0, 'plan failed');
    const notice = sends.filter((s) => s.isNotice);
    expect(notice.map((s) => s.chunk.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    const ids = new Set(notice.map((s) => (s.chunk as { id: string }).id));
    expect(ids.size).toBe(1);
    // A lone text-delta is rejected by the AI SDK stream reducer, so the wrapper is load-bearing.
    expect((notice[1]?.chunk as { delta: string }).delta).toBe('plan failed');
  });

  it('keeps the notice strictly above the replay so the renderer cannot drop it', () => {
    // The renderer holds a high-water messageIndex per message and discards anything at or below
    // it. Numbering the notice from the pre-replay history length would silently lose it.
    const sends = buildPlanFallbackSends(prose(), 0, 'plan failed');
    const replayIdx = sends.filter((s) => !s.isNotice).map((s) => s.messageIndex);
    const noticeIdx = sends.filter((s) => s.isNotice).map((s) => s.messageIndex);
    expect(Math.min(...noticeIdx)).toBeGreaterThan(Math.max(...replayIdx));
    expect(sends.map((s) => s.messageIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('emits nothing when the turn streamed no prose and needs no notice', () => {
    expect(buildPlanFallbackSends(noise(), 0, null)).toEqual([]);
  });

  it('numbers sends contiguously so a caller can advance its counter by sends.length', () => {
    // The Claude path does `messageIndex += sends.length` after the loop rather than tracking each
    // send. A gap in the sequence would desync that counter and drop later chunks below the
    // renderer's high-water mark.
    const sends = buildPlanFallbackSends(prose(), 4, 'plan failed');
    expect(sends.map((s) => s.messageIndex)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(sends.at(-1)?.messageIndex).toBe(4 + sends.length - 1);
  });

  it('replays every text run in stream order across interleaved tool chunks', () => {
    // Real plan turns alternate prose and tool calls; the replay must not reorder or coalesce runs.
    const chunks = [
      { type: 'text-start', id: 'a' },
      { type: 'text-delta', id: 'a', delta: 'first' },
      { type: 'text-end', id: 'a' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'Read', input: {} },
      { type: 'tool-output-available', toolCallId: 'c1', output: {} },
      { type: 'text-start', id: 'b' },
      { type: 'text-delta', id: 'b', delta: 'second' },
      { type: 'text-end', id: 'b' },
    ] as UIMessageChunk[];
    const sends = buildPlanFallbackSends(chunks, 0, null);
    expect(sends.map((s) => (s.chunk as { id: string }).id)).toEqual([
      'a',
      'a',
      'a',
      'b',
      'b',
      'b',
    ]);
    expect(sends.map((s) => s.messageIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps the notice its own paragraph when the prose run never closed', () => {
    // A failed plan often ends mid-stream with no text-end. applyChunkToParts appends a bare
    // text-delta to whatever run is still open, so an unwrapped notice fuses onto the last prose
    // paragraph; the notice's own text-start closes that run first.
    const truncated = [
      { type: 'text-start', id: 'p' },
      { type: 'text-delta', id: 'p', delta: 'half a plan' },
    ] as UIMessageChunk[];
    const noticeChunks = buildPlanFallbackSends(truncated, 0, 'NOTICE')
      .filter((s) => s.isNotice)
      .map((s) => s.chunk);
    const parts = buildPartsFromChunks([...truncated, ...noticeChunks]);
    expect(parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(
      ['half a plan', 'NOTICE'],
    );

    // Control: the unwrapped shape this replaced really does fuse, so the assertion above is not
    // trivially true and fails if the notice ever loses its text-start again.
    const fused = buildPartsFromChunks([
      ...truncated,
      { type: 'text-delta', id: 'notice', delta: 'NOTICE' } as UIMessageChunk,
    ]);
    expect(fused.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(
      ['half a planNOTICE'],
    );
  });

  it('survives canonical-plan dedup when a notice and a plan card share one message', () => {
    // The persistence-warning path emits a notice alongside a rendered card. filterCanonicalPlanParts
    // strips the duplicate plan markdown; the notice must not be swept up with it.
    const planText = '## Overview\nDo the thing.';
    const streamed = [
      { type: 'text-start', id: 'p' },
      { type: 'text-delta', id: 'p', delta: planText },
      { type: 'text-end', id: 'p' },
    ] as UIMessageChunk[];
    const noticeChunks = buildPlanFallbackSends([], 0, 'PERSIST FAILED')
      .filter((s) => s.isNotice)
      .map((s) => s.chunk);
    const filtered = filterCanonicalPlanParts(
      buildPartsFromChunks([...streamed, ...noticeChunks]),
      planText,
    );
    expect(
      filtered.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text),
    ).toEqual(['PERSIST FAILED']);
  });

  it('still emits the notice when the model produced no prose at all', () => {
    const sends = buildPlanFallbackSends(noise(), 3, 'plan failed');
    expect(sends).toHaveLength(3);
    expect(sends.every((s) => s.isNotice)).toBe(true);
    expect(sends.map((s) => s.messageIndex)).toEqual([3, 4, 5]);
  });
});

describe('emitPlanFallbackSends', () => {
  // Covers the wiring the three plan-fallback call sites share: what reaches the transport, what
  // gets appended to the collected history, and what the caller's index counter becomes.
  const prose = (): UIMessageChunk[] => [
    { type: 'text-start', id: 'p' } as UIMessageChunk,
    { type: 'text-delta', id: 'p', delta: 'drafted plan' } as UIMessageChunk,
    { type: 'text-end', id: 'p' } as UIMessageChunk,
  ];
  const capture = () => {
    const seen: Array<{ type: string; messageIndex: number; parts: MessagePart[] }> = [];
    const send = (item: PlanFallbackSend, parts: MessagePart[]) =>
      seen.push({ type: item.chunk.type, messageIndex: item.messageIndex, parts });
    return { seen, send };
  };

  it('appends only the notice to the collected history, never the replayed prose', () => {
    // Replaying prose that is already collected would duplicate it in the persisted message.
    const collected = prose();
    const { seen, send } = capture();
    emitPlanFallbackSends(collected, 0, 'NOTICE', send);
    expect(seen).toHaveLength(6);
    expect(collected).toHaveLength(6);
    expect(collected.slice(0, 3)).toEqual(prose());
    expect(collected.slice(3).map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end']);
  });

  it('reports the next free index so the Claude path keeps its counter in step', () => {
    const { send } = capture();
    const result = emitPlanFallbackSends(prose(), 10, 'NOTICE', send);
    expect(result).toEqual({ nextIndex: 16, replayedCount: 3 });
  });

  it('grows the parts payload only once the notice is appended', () => {
    // The replay's parts are cumulative and identical, so they are folded once; the notice adds a
    // part and must therefore ship a freshly folded payload rather than the stale replay one.
    const { seen, send } = capture();
    emitPlanFallbackSends(prose(), 0, 'NOTICE', send);
    const textCount = (p: MessagePart[]) => p.filter((x) => x.type === 'text').length;
    expect(seen.slice(0, 3).map((s) => textCount(s.parts))).toEqual([1, 1, 1]);
    expect(textCount(seen[5]?.parts ?? [])).toBe(2);
  });

  it('is a no-op that still reports the caller index when there is nothing to send', () => {
    const collected: UIMessageChunk[] = [{ type: 'finish' } as UIMessageChunk];
    const { seen, send } = capture();
    expect(emitPlanFallbackSends(collected, 7, null, send)).toEqual({
      nextIndex: 7,
      replayedCount: 0,
    });
    expect(seen).toEqual([]);
    expect(collected).toHaveLength(1);
  });
});

// Command delivery reads staged.json through this same spy; plan reads are the `.md` ones.
const planFileReads = () =>
  vi.mocked(fs.promises.readFile).mock.calls.filter((call) => String(call[0]).endsWith('.md'));

describe('Claude Code native plan mode (ExitPlanMode)', () => {
  const machineId = 'machine-plan-native';
  const project = {
    id: 'project-plan-native',
    user_id: 'user-1',
    name: 'Plan Native Project',
    path: '/tmp/project-plan-native',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-plan-native',
    subChatId: '99999999-9999-4999-8999-999999999999',
    projectId: project.id,
    mode: 'plan' as const,
    assistantMessageId: 'assistant-plan-native',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  // Plan content that validates successfully
  const validPlanContent = `---
name: "Test Plan"
overview: "Test plan overview"
todos:
  - id: t1
    title: "Step one"
    status: pending
isProject: false
---

## Overview
Test plan overview.

## Implementation Steps
1. Step one

## Execution Summary
Done.
<!-- FRINK_PLAN_COMPLETE -->`;

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    applyExecutorMockDefaults(machineId, project);
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

  it('emits frink-plan when ExitPlanMode completes and plan file exists', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    claudeQueryMock.mockImplementationOnce(async function* () {
      // Simulate SDK plan mode: Write plan file → ExitPlanMode
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-1',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/test-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-1',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-1',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-1',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      // Stream should continue until finish chunk is handled
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-plan-finish-1' },
          } satisfies UIMessageChunk,
        ],
      };
      // Chunks after finish should not be reached
      yield {
        chunks: [
          {
            type: 'text-delta',
            id: 'unreachable',
            delta: 'SHOULD NOT APPEAR',
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'create a plan',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      sessionId?: string;
      finalParts?: Array<{ type?: string; input?: { status?: string } }>;
    };
    expect(payload.sessionId).toBe('sess-plan-finish-1');
    expect(payload.finalParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-frink-plan',
        }),
      ]),
    );
    // Verify the plan has awaiting_approval status
    const planPart = payload.finalParts?.find((p) => p.type === 'tool-frink-plan');
    expect(planPart?.input?.status).toBe('awaiting_approval');

    // Verify the unreachable chunk was never streamed
    const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
    const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);
    expect(
      streamedChunks.some((c) => c.type === 'text-delta' && 'id' in c && c.id === 'unreachable'),
    ).toBe(false);
  });

  it('emits frink-plan when ExitPlanMode completes and plan file is under session plans dir', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const sid = '99999999-9999-4999-8999-999999999999';
    const sessionPlanPath = `/mock/userData/claude-sessions/${sid}/plans/sdk-plan.md`;

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-session-plan',
            toolName: 'Write',
            input: {
              file_path: sessionPlanPath,
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-session-plan',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-session-plan',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-session-plan',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-session-plan-finish' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'session plan path',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    expect(payload.finalParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-frink-plan' })]),
    );
  });

  it('sends normal reply when ExitPlanMode completes but no Write to ~/.claude/plans/', async () => {
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          // Write to a project file, not to plans dir
          {
            type: 'tool-input-available',
            toolCallId: 'write-proj-1',
            toolName: 'Write',
            input: { file_path: '/tmp/project-plan-native/src/file.ts', content: 'code' },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-proj-1',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-no-write',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-no-write',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'exit plan without plan file',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    // Should NOT contain a frink-plan part
    const hasFrinkPlan = payload.finalParts?.some((p) => p.type === 'tool-frink-plan');
    expect(hasFrinkPlan).toBeFalsy();
  });

  it('replays suppressed text chunks live when plan mode produces prose but no plan artifact', async () => {
    // Bug fix verification: plan mode unconditionally suppresses text-* chunks during the
    // stream (shouldSuppressPlanTextChunk). When the model answers in prose without
    // calling Write+ExitPlanMode, the user must still see the reply live — otherwise the
    // UI is blank until refresh. The post-stream branch replays the suppressed chunks.
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          { type: 'text-start', id: 'txt-1' } satisfies UIMessageChunk,
          {
            type: 'text-delta',
            id: 'txt-1',
            delta: "I'm Claude Opus 4.",
          } satisfies UIMessageChunk,
          { type: 'text-end', id: 'txt-1' } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'what model are you',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
    const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);
    expect(streamedChunks.some((c) => c.type === 'text-start')).toBe(true);
    expect(
      streamedChunks.some(
        (c) => c.type === 'text-delta' && 'delta' in c && c.delta.includes('Claude'),
      ),
    ).toBe(true);
    expect(streamedChunks.some((c) => c.type === 'text-end')).toBe(true);
  });

  it('does NOT replay text chunks when plan mode produces a valid plan card (no double-emit)', async () => {
    // Regression guard: when Write+ExitPlanMode succeeds and the canonical frink-plan
    // card is emitted, the suppressed prose must stay suppressed. Otherwise users see
    // both the plan card AND the raw plan markdown in the chat (double-emit).
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const planPath = '/mock/home/.claude/plans/no-double-emit.md';

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          { type: 'text-start', id: 'txt-prose' } satisfies UIMessageChunk,
          {
            type: 'text-delta',
            id: 'txt-prose',
            delta: 'Here is my plan body that must NOT leak as raw text.',
          } satisfies UIMessageChunk,
          { type: 'text-end', id: 'txt-prose' } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-file',
            toolName: 'Write',
            input: { file_path: planPath, content: validPlanContent },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-file',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-success',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-success',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-no-double-emit' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan that succeeds',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
    const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);
    // Plan card must be emitted (frink-plan as tool-input-available, see buildFrinkPlanChunks)
    expect(
      streamedChunks.some(
        (c) =>
          c.type === 'tool-input-available' &&
          'toolName' in c &&
          (c as { toolName: string }).toolName === 'frink-plan',
      ),
    ).toBe(true);
    // Raw text must NOT be streamed (suppressed during stream, replay branch must not fire)
    expect(streamedChunks.some((c) => c.type === 'text-start')).toBe(false);
    expect(streamedChunks.some((c) => c.type === 'text-delta')).toBe(false);
    expect(streamedChunks.some((c) => c.type === 'text-end')).toBe(false);
  });

  it('suppresses post-ExitPlanMode tool/thinking chunks that leak before user approval', async () => {
    // Bug: canUseTool auto-allows ExitPlanMode, so the SDK exits plan mode internally and the
    // model keeps generating (thinking blocks, further tool calls) in the same turn. The stream
    // loop waits for `finish` to capture trailing metadata, so those chunks would otherwise flow
    // to the UI beneath the "Plan ready for review" card before the user clicks Approve.
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const planPath = '/mock/home/.claude/plans/post-exit-leak.md';

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-leak',
            toolName: 'Write',
            input: { file_path: planPath, content: validPlanContent },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-leak',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-leak',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-leak',
            output: { success: true },
          } satisfies UIMessageChunk,
          // Anything the model emits after ExitPlanMode must NOT reach the UI.
          {
            type: 'tool-input-available',
            toolCallId: 'thinking-leak',
            toolName: 'Thinking',
            input: { text: 'Now let me implement the changes.' },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'thinking-leak',
            output: { completed: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'read-leak',
            toolName: 'Read',
            input: { file_path: '/tmp/should-not-stream.ts' },
          } satisfies UIMessageChunk,
        ],
      };
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-post-exit-leak' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'model keeps thinking after ExitPlanMode',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
    const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);
    // Plan card must still be emitted via sendStreamChunkDirect.
    expect(
      streamedChunks.some(
        (c) =>
          c.type === 'tool-input-available' &&
          'toolName' in c &&
          (c as { toolName: string }).toolName === 'frink-plan',
      ),
    ).toBe(true);
    // Leaked Thinking / follow-up tool calls must NOT be streamed to the renderer.
    expect(
      streamedChunks.some(
        (c) =>
          c.type === 'tool-input-available' &&
          'toolName' in c &&
          (c as { toolName: string }).toolName === 'Thinking',
      ),
    ).toBe(false);
    expect(
      streamedChunks.some(
        (c) =>
          c.type === 'tool-input-available' &&
          'toolName' in c &&
          (c as { toolName: string }).toolName === 'Read',
      ),
    ).toBe(false);
    // Finish metadata still flows so sessionId / token counts are captured.
    expect(
      streamedChunks.some(
        (c) =>
          c.type === 'finish' &&
          'messageMetadata' in c &&
          (c as { messageMetadata?: { sessionId?: string } }).messageMetadata?.sessionId ===
            'sess-post-exit-leak',
      ),
    ).toBe(true);
  });

  it('does not emit frink-plan when plan file is empty', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue('   ');

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-empty-plan',
            toolName: 'Write',
            input: { file_path: '/mock/home/.claude/plans/empty.md', content: '' },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-empty-plan',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-empty',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-empty',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan with empty file',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    const hasFrinkPlan = payload.finalParts?.some((p) => p.type === 'tool-frink-plan');
    expect(hasFrinkPlan).toBeFalsy();
  });

  it('handles plan file read failure gracefully without crashing', async () => {
    vi.spyOn(fs.promises, 'readFile').mockRejectedValue(
      new Error('ENOENT: no such file or directory'),
    );

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-deleted-plan',
            toolName: 'Write',
            input: { file_path: '/mock/home/.claude/plans/deleted.md', content: validPlanContent },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-deleted-plan',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-deleted',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-deleted',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    // Should not throw
    await handleRemoteExecute({
      ...basePayload,
      message: 'plan file deleted before read',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    // No frink-plan since read failed
    const hasFrinkPlan = payload.finalParts?.some((p) => p.type === 'tool-frink-plan');
    expect(hasFrinkPlan).toBeFalsy();
  });

  it('ignores ExitPlanMode in non-plan mode (agent mode)', async () => {
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-agent-mode',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-agent-mode',
            output: { success: true },
          } satisfies UIMessageChunk,
          // These should still be streamed since we're in agent mode
          {
            type: 'text-delta',
            id: 'after-exit-agent',
            delta: 'Continued output in agent mode',
          } satisfies UIMessageChunk,
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-agent-exit' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      message: 'agent mode with ExitPlanMode (should be ignored)',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    // The text-delta after ExitPlanMode should have been streamed
    const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
    const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);
    expect(
      streamedChunks.some(
        (c) => c.type === 'text-delta' && 'id' in c && c.id === 'after-exit-agent',
      ),
    ).toBe(true);
  });

  it('picks the correct plan file when multiple Write calls exist', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          // Write to a non-plan path first
          {
            type: 'tool-input-available',
            toolCallId: 'write-code-1',
            toolName: 'Write',
            input: { file_path: '/tmp/project-plan-native/src/utils.ts', content: 'export {}' },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-code-1',
            output: { success: true },
          } satisfies UIMessageChunk,
          // Write to the plan directory
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-correct',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/correct-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-correct',
            output: { success: true },
          } satisfies UIMessageChunk,
          // Write to another non-plan path
          {
            type: 'tool-input-available',
            toolCallId: 'write-code-2',
            toolName: 'Write',
            input: { file_path: '/tmp/project-plan-native/README.md', content: '# Readme' },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-code-2',
            output: { success: true },
          } satisfies UIMessageChunk,
          // ExitPlanMode
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-multi',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-multi',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan with multiple writes',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    // Should emit frink-plan since we found the plans dir Write
    expect(payload.finalParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-frink-plan' })]),
    );

    // readFile should have been called with the correct plan path
    expect(fs.promises.readFile).toHaveBeenCalledWith(
      '/mock/home/.claude/plans/correct-plan.md',
      'utf8',
    );
  });

  it('does not emit frink-plan when stream is aborted before ExitPlanMode output', async () => {
    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-abort',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/abort-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-abort',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-abort',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          // ExitPlanMode input arrives but no output yet — abort happens here
        ],
      };
      // Simulate the stream ending without ExitPlanMode output
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan that gets aborted',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    // No frink-plan since ExitPlanMode never got its output
    const hasFrinkPlan = payload.finalParts?.some((p) => p.type === 'tool-frink-plan');
    expect(hasFrinkPlan).toBeFalsy();
  });

  it('continues until finish chunk, then breaks stream loop after ExitPlanMode output', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    let secondBatchYielded = false;
    let thirdBatchYielded = false;

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-break',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/break-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-break',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-break',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-break',
            output: { success: true },
          } satisfies UIMessageChunk,
          // This chunk is in the SAME batch after ExitPlanMode output — should stream until finish
          {
            type: 'text-delta',
            id: 'same-batch-after',
            delta: 'SHOULD STREAM BEFORE FINISH',
          } satisfies UIMessageChunk,
        ],
      };
      // Second batch includes finish; stream should stop after this is handled.
      secondBatchYielded = true;
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-plan-finish-break' },
          } satisfies UIMessageChunk,
        ],
      };
      // Third batch — should never be consumed
      thirdBatchYielded = true;
      yield {
        chunks: [
          {
            type: 'text-delta',
            id: 'third-batch',
            delta: 'SHOULD NOT STREAM AFTER FINISH',
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan with extra chunks after exit',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
    const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);

    // Plan mode suppresses assistant text from IPC; chunks are still collected — verify trailing
    // text is not duplicated in the live stream.
    expect(
      streamedChunks.some(
        (c) => c.type === 'text-delta' && 'id' in c && c.id === 'same-batch-after',
      ),
    ).toBe(false);
    expect(
      streamedChunks.some((c) => c.type === 'text-delta' && 'id' in c && c.id === 'third-batch'),
    ).toBe(false);
    expect(secondBatchYielded).toBe(true);
    // The persistent-session model DRAINS the generator to its result (a for-await break would
    // kill the shared query); post-finish messages are pulled but dropped from the stream — the
    // not-streamed assertion above is the contract.
    expect(thirdBatchYielded).toBe(true);
  });

  it('passes permissionMode plan to SDK when mode is plan', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-pmode',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/pmode-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-pmode',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-pmode',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-pmode',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'verify plan permission mode',
    });

    const queryInput = claudeQueryMock.mock.calls[0]?.[0] as {
      options?: { permissionMode?: string };
    };
    expect(queryInput.options?.permissionMode).toBe('plan');
  });

  it('uses last Write to plans dir when multiple plan files are written', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          // First Write to plans dir
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-first',
            toolName: 'Write',
            input: { file_path: '/mock/home/.claude/plans/first-plan.md', content: 'draft 1' },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-first',
            output: { success: true },
          } satisfies UIMessageChunk,
          // Second Write to plans dir (should override first)
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-second',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/second-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-second',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-last',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-last',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan with multiple plan writes',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Should read the LAST Write to plans dir (second-plan.md)
    expect(fs.promises.readFile).toHaveBeenCalledWith(
      '/mock/home/.claude/plans/second-plan.md',
      'utf8',
    );
  });

  it('handles out-of-order ExitPlanMode output-before-input without crashing', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-ooo',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/out-of-order.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-ooo',
            output: { success: true },
          } satisfies UIMessageChunk,
          // Out-of-order: output arrives before matching input
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-ooo',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-ooo',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await expect(
      handleRemoteExecute({
        ...basePayload,
        message: 'out-of-order exit-plan events',
      }),
    ).resolves.toBeUndefined();

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    if (completeCalls.length > 0) {
      const payload = completeCalls[completeCalls.length - 1]?.[0] as {
        finalParts?: Array<{ type?: string }>;
      };
      const hasFrinkPlan = payload.finalParts?.some((p) => p.type === 'tool-frink-plan');
      expect(hasFrinkPlan).toBeFalsy();
    }
  });

  it('emits the native plan file verbatim even when its frontmatter is malformed', async () => {
    const malformedFrontmatterPlan = `---
name:
overview:
todos:
  - id:
    content:
isProject:
---

## Overview
Repair malformed metadata from native Claude plan.

## File Impact
- src/main/lib/socket/executor.ts

## Implementation Steps
1. Validate and normalize frontmatter.

## Risks & Verification
Run focused tests for plan-mode flow.

## Execution Summary
Emit canonical frink-plan payload with repaired metadata.
<!-- FRINK_PLAN_COMPLETE -->`;
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(malformedFrontmatterPlan);

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-malformed',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/malformed-frontmatter.md',
              content: malformedFrontmatterPlan,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-malformed',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-malformed',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-malformed',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'malformed frontmatter plan',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string; input?: { planText?: string } }>;
    };
    const planPart = payload.finalParts?.find((p) => p.type === 'tool-frink-plan');
    expect(planPart?.input?.planText).toBe(malformedFrontmatterPlan.trim());
  });

  it('emits only one frink-plan when duplicate ExitPlanMode completions appear', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    claudeQueryMock.mockImplementationOnce(async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-dup-exit',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/dup-exit.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'write-plan-dup-exit',
            output: { success: true },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-first',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-first',
            output: { success: true },
          } satisfies UIMessageChunk,
          // Duplicate completion that should never be processed after loop break
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-second',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-second',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'duplicate exit-plan completions',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string }>;
    };
    const frinkPlanParts = payload.finalParts?.filter((p) => p.type === 'tool-frink-plan') ?? [];
    expect(frinkPlanParts).toHaveLength(1);
  });

  describe('inline frink-plan emission', () => {
    it('emits frink-plan chunks via sendStreamChunkDirect during streaming before execute-complete', async () => {
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'write-inline-1',
              toolName: 'Write',
              input: {
                file_path: '/mock/home/.claude/plans/inline-plan.md',
                content: validPlanContent,
              },
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'write-inline-1',
              output: { success: true },
            } satisfies UIMessageChunk,
            {
              type: 'tool-input-available',
              toolCallId: 'exit-inline-1',
              toolName: 'ExitPlanMode',
              input: {},
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'exit-inline-1',
              output: { success: true },
            } satisfies UIMessageChunk,
          ],
        };
        yield {
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-inline-plan' },
            } satisfies UIMessageChunk,
          ],
        };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'inline emission test' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const clientModule = await import('./client');
      const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
      const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);

      // frink-plan input chunk must appear in stream calls (inline emission)
      const inlinePlanChunk = streamedChunks.find(
        (c) =>
          c.type === 'tool-input-available' &&
          'toolName' in c &&
          (c as { toolName: string }).toolName === 'frink-plan',
      );
      expect(inlinePlanChunk).toBeDefined();

      // Also confirm it appears in finalParts
      const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
      const payload = completeCalls[completeCalls.length - 1]?.[0] as {
        finalParts?: Array<{ type?: string }>;
      };
      expect(payload.finalParts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'tool-frink-plan' })]),
      );
      // One plan read (inline), proving the post-stream fallback did NOT fire
      expect(planFileReads()).toHaveLength(1);
    });

    it('does not send ExitPlanMode, PlanWrite, or text-delta to IPC in plan mode (dedupe)', async () => {
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'write-dedupe',
              toolName: 'Write',
              input: {
                file_path: '/mock/home/.claude/plans/dedupe-plan.md',
                content: validPlanContent,
              },
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'write-dedupe',
              output: { success: true },
            } satisfies UIMessageChunk,
            {
              type: 'tool-input-available',
              toolCallId: 'exit-dedupe',
              toolName: 'ExitPlanMode',
              input: {},
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'exit-dedupe',
              output: { success: true },
            } satisfies UIMessageChunk,
            {
              type: 'tool-input-available',
              toolCallId: 'pw-dedupe',
              toolName: 'PlanWrite',
              input: { planPath: '/tmp/plan.md' },
            } satisfies UIMessageChunk,
            {
              type: 'text-delta',
              id: 'trail-dedupe',
              delta: 'Trailing summary',
            } satisfies UIMessageChunk,
          ],
        };
        yield {
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-dedupe-plan' },
            } satisfies UIMessageChunk,
          ],
        };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'plan ipc dedupe test' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const clientModule = await import('./client');
      const streamCalls = vi.mocked(clientModule.sendStreamChunkDirect).mock.calls;
      const streamedChunks = streamCalls.map((c) => (c[0] as { chunk: UIMessageChunk }).chunk);

      expect(
        streamedChunks.some(
          (c) =>
            c.type === 'tool-input-available' &&
            'toolName' in c &&
            (c as { toolName: string }).toolName === 'ExitPlanMode',
        ),
      ).toBe(false);
      expect(
        streamedChunks.some(
          (c) =>
            c.type === 'tool-input-available' &&
            'toolName' in c &&
            (c as { toolName: string }).toolName === 'PlanWrite',
        ),
      ).toBe(false);
      expect(streamedChunks.some((c) => c.type === 'text-delta')).toBe(false);
      // Native Write (plan .md) is suppressed from IPC; frink-plan is the canonical surface.
      expect(
        streamedChunks.some(
          (c) =>
            c.type === 'tool-input-available' &&
            'toolName' in c &&
            (c as { toolName: string }).toolName === 'Write',
        ),
      ).toBe(false);
      expect(
        streamedChunks.some(
          (c) =>
            c.type === 'tool-input-available' &&
            'toolName' in c &&
            (c as { toolName: string }).toolName === 'frink-plan',
        ),
      ).toBe(true);
    });

    it('falls back to post-stream emission when inline readFile throws', async () => {
      let planRead = 0;
      vi.spyOn(fs.promises, 'readFile').mockImplementation(async (target) => {
        const isPlan = String(target).endsWith('.md');
        if (isPlan && planRead++ === 0) throw new Error('Simulated inline read failure');
        return validPlanContent;
      });

      claudeQueryMock.mockImplementationOnce(async function* () {
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'write-fallback-1',
              toolName: 'Write',
              input: {
                file_path: '/mock/home/.claude/plans/fallback-plan.md',
                content: validPlanContent,
              },
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'write-fallback-1',
              output: { success: true },
            } satisfies UIMessageChunk,
            {
              type: 'tool-input-available',
              toolCallId: 'exit-fallback-1',
              toolName: 'ExitPlanMode',
              input: {},
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'exit-fallback-1',
              output: { success: true },
            } satisfies UIMessageChunk,
          ],
        };
        yield {
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-fallback-plan' },
            } satisfies UIMessageChunk,
          ],
        };
        yield { type: 'result' };
      });

      await handleRemoteExecute({ ...basePayload, message: 'inline fallback test' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Post-stream fallback must have emitted frink-plan
      const clientModule = await import('./client');
      const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
      expect(completeCalls.length).toBeGreaterThan(0);
      const payload = completeCalls[completeCalls.length - 1]?.[0] as {
        finalParts?: Array<{ type?: string }>;
      };
      expect(payload.finalParts).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'tool-frink-plan' })]),
      );
      // Two plan reads: the inline one (failed) and the post-stream one (succeeded)
      expect(planFileReads()).toHaveLength(2);
    });
  });
});

describe('Plan-mode exit reminder (plan→agent transition)', () => {
  const machineId = 'machine-plan-exit';
  const subChatId = '88888888-8888-4888-8888-888888888888';
  const project = {
    id: 'project-plan-exit',
    user_id: 'user-1',
    name: 'Plan Exit Project',
    path: '/tmp/project-plan-exit',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-plan-exit',
    subChatId,
    projectId: project.id,
    assistantMessageId: 'assistant-plan-exit',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    // Reset the module-level lastExecutedModeBySubChat map so test order doesn't matter.
    _resetExecutorStateForTests();
    applyExecutorMockDefaults(machineId, project);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    // Each plan-mode/agent turn just yields a finish chunk — we only care about
    // what prompt was sent.
    claudeQueryMock.mockImplementation(async function* (input: object) {
      await firePromptSubmit(input);
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-plan-exit' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects the plan-mode exit reminder via the UserPromptSubmit hook when the previous turn was plan and now resuming in agent mode', async () => {
    // Turn 1: plan mode (records lastExecutedMode = "plan")
    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'plan something',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2: agent mode, resuming the same session (sessionId present)
    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      sessionId: 'sess-plan-exit',
      message: 'now do it',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0];
    const reminder = firedReminders.get(secondCall);
    expect(reminder).toContain('Plan mode is not active');
    expect(reminder).toContain('no longer apply');
    // Delivered via the SDK hook, not prepended to the user prompt.
    expect(await claudePromptText((secondCall as { prompt?: unknown }).prompt)).not.toContain(
      'Plan mode is not active',
    );
  });

  it('does NOT prepend the exit reminder when there is no resumed session (first-message-ever in agent mode)', async () => {
    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      message: 'fresh agent chat',
      // no sessionId — first message
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = claudeQueryMock.mock.calls[0]?.[0] as { prompt?: string };
    expect(await claudePromptText(call.prompt)).not.toContain('Plan mode is not active');
  });

  it('does NOT prepend the exit reminder for back-to-back agent turns', async () => {
    // Turn 1 agent
    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      message: 'first agent turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2 agent (resuming)
    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      sessionId: 'sess-plan-exit',
      message: 'second agent turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as { prompt?: string };
    expect(await claudePromptText(secondCall.prompt)).not.toContain('Plan mode is not active');
  });

  it('does NOT prepend the exit reminder when the new turn is also plan mode', async () => {
    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'first plan turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      sessionId: 'sess-plan-exit',
      message: 'second plan turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as { prompt?: string };
    expect(await claudePromptText(secondCall.prompt)).not.toContain('Plan mode is not active');
  });

  it('skips the exit reminder when the previous turn for THIS subChat was not plan mode (different subChat scoping)', async () => {
    // The lastExecutedMode map is keyed by subChatId. Turn 1 on subChatA in plan mode
    // must NOT cause turn 1 on subChatB (a different chat) to receive an exit reminder
    // when starting fresh — even though the map already has an entry for subChatA.
    const otherSubChatId = '77777777-7777-4777-8777-777777777777';

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'plan in chat A',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // First-ever turn on a different sub-chat, in agent mode, with a session
    // (simulating resumed history).
    await handleRemoteExecute({
      ...basePayload,
      subChatId: otherSubChatId,
      mode: 'agent',
      sessionId: 'sess-other',
      message: 'fresh agent in chat B',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as { prompt?: string };
    expect(await claudePromptText(secondCall.prompt)).not.toContain('Plan mode is not active');
  });
});

describe('active execution abort (window-scoped)', () => {
  beforeEach(() => {
    _clearActiveExecutionsForTests();
  });

  afterEach(() => {
    _clearActiveExecutionsForTests();
  });

  it('does not abort executions belonging to a different window on renderer reload', () => {
    const windowAController = new AbortController();
    const windowBController = new AbortController();
    _registerExecutionForTests('window-A:sub-1', windowAController, 101);
    _registerExecutionForTests('window-B:sub-2', windowBController, 202);

    abortActiveExecutionsForWebContents(101, 'renderer-reload');

    expect(windowAController.signal.aborted).toBe(true);
    expect(windowBController.signal.aborted).toBe(false);
  });

  it('does not abort any execution when the webContents id does not match', () => {
    const a = new AbortController();
    const b = new AbortController();
    _registerExecutionForTests('sub-a', a, 100);
    _registerExecutionForTests('sub-b', b, 200);

    abortActiveExecutionsForWebContents(999, 'renderer-reload');

    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
    expect(_getActiveExecutionCountForTests()).toBe(2);
  });

  it('aborts every execution bound to the same webContents id (multi sub-chat, one window)', () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    _registerExecutionForTests('chat-1-sub', c1, 42);
    _registerExecutionForTests('chat-2-sub', c2, 42);

    abortActiveExecutionsForWebContents(42, 'renderer-reload');

    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(_getActiveExecutionCountForTests()).toBe(0);
  });

  // Executor runs for another machine have no local webContents binding — scoped
  // abort must not stop them when a local window reloads.
  it('preserves remote-sourced executions on renderer-reload', () => {
    const localController = new AbortController();
    const remoteController = new AbortController();
    _registerExecutionForTests('local-sub', localController, 5);
    _registerExecutionForTests('remote-sub', remoteController, undefined);

    abortActiveExecutionsForWebContents(5, 'renderer-reload');

    expect(localController.signal.aborted).toBe(true);
    expect(remoteController.signal.aborted).toBe(false);
  });

  // The `interrupted` flag is load-bearing: reload/crash must offer Re-run (marker stamped), a
  // deliberate Stop must not. A future refactor swapping these would silently break recovery — guard it.
  it('renderer reload terminalizes the flow task as INTERRUPTED (re-run offered)', async () => {
    _registerExecutionForTests('reload-sub', new AbortController(), 7);

    abortActiveExecutionsForWebContents(7, 'renderer-reload');

    await vi.waitFor(() =>
      expect(cancelFlowTaskForSubChat).toHaveBeenCalledWith(expect.anything(), 'reload-sub', {
        interrupted: true,
      }),
    );
  });

  it('manual Stop terminalizes the flow task as NOT interrupted (no re-run)', async () => {
    _registerExecutionForTests('stop-sub', new AbortController());

    handleRemoteStop({ chatId: 'c1', subChatId: 'stop-sub' });

    await vi.waitFor(() =>
      expect(cancelFlowTaskForSubChat).toHaveBeenCalledWith(expect.anything(), 'stop-sub', {
        interrupted: false,
      }),
    );
  });

  // Pause is abort-WITHOUT-reconcile (decision flow-run-chat-surface): the caller parks the
  // driving task (needs_attention ∈ FLOW_DRIVING_STATUSES) FIRST, so the teardown reconcile of
  // the Stop paths would CAS that fresh park to cancelled and kill the resumability pause exists
  // for. A refactor routing pause through handleRemoteStop would silently break Resume — guard it.
  it('pause aborts the turn but NEVER reconcile-cancels the flow task', async () => {
    const controller = new AbortController();
    _registerExecutionForTests('pause-sub', controller);

    expect(pauseActiveExecutionForSubChat('pause-sub')).toBe(true);

    expect(controller.signal.aborted).toBe(true);
    expect(_hasActiveExecutionForTests('pause-sub')).toBe(false);
    // Give the fire-and-forget reconcile (if one were wrongly wired) a tick to fire.
    await new Promise((r) => setImmediate(r));
    expect(cancelFlowTaskForSubChat).not.toHaveBeenCalledWith(
      expect.anything(),
      'pause-sub',
      expect.anything(),
    );
  });

  it('pause is a no-op (false) when no execution is active for the sub-chat', () => {
    expect(pauseActiveExecutionForSubChat('pause-none')).toBe(false);
  });

  // Multi-pane: reloading window A must reconcile ONLY A's flow run, never window B's (which keeps
  // running in its own pane). Guards a concurrency regression where the reconcile leaks across windows.
  it('reconciles only the reloaded window`s flow task, leaving another pane`s untouched', async () => {
    _registerExecutionForTests('mp-win-a', new AbortController(), 111);
    _registerExecutionForTests('mp-win-b', new AbortController(), 222);

    abortActiveExecutionsForWebContents(111, 'renderer-reload');

    await vi.waitFor(() =>
      expect(cancelFlowTaskForSubChat).toHaveBeenCalledWith(expect.anything(), 'mp-win-a', {
        interrupted: true,
      }),
    );
    expect(cancelFlowTaskForSubChat).not.toHaveBeenCalledWith(
      expect.anything(),
      'mp-win-b',
      expect.anything(),
    );
  });
});

describe('extractImagePartsFromMessage', () => {
  it('returns inline base64 for file parts with data', () => {
    const parts = [{ type: 'file', mimeType: 'image/png', data: 'abc123' }];
    expect(_extractImagePartsFromMessageForTests(parts)).toEqual([
      { base64Data: 'abc123', mediaType: 'image/png' },
    ]);
  });

  it('returns data-image parts unchanged', () => {
    const parts = [
      {
        type: 'data-image',
        data: { base64Data: 'inline-data', mediaType: 'image/jpeg' },
      },
    ] as unknown as Parameters<typeof _extractImagePartsFromMessageForTests>[0];
    expect(_extractImagePartsFromMessageForTests(parts)).toEqual([
      { base64Data: 'inline-data', mediaType: 'image/jpeg' },
    ]);
  });

  it('returns empty array for undefined or empty parts', () => {
    expect(_extractImagePartsFromMessageForTests(undefined)).toEqual([]);
    expect(_extractImagePartsFromMessageForTests([])).toEqual([]);
  });

  it('ignores file parts with no image data', () => {
    const parts = [{ type: 'file', mimeType: 'image/png' }];
    expect(_extractImagePartsFromMessageForTests(parts)).toHaveLength(0);
  });

  it('ignores file parts with empty-string data instead of emitting an empty image block', () => {
    const parts = [{ type: 'file', mimeType: 'image/png', data: '' }];
    expect(_extractImagePartsFromMessageForTests(parts)).toHaveLength(0);
  });
});

// ============================================================================
// Debug mode (exit reminders, session stability, cleanup)
// ============================================================================

describe('Debug-mode exit reminder (debug→agent transition)', () => {
  const machineId = 'machine-debug-exit';
  const subChatId = '99999999-9999-4999-9999-999999999999';
  const project = {
    id: 'project-debug-exit',
    user_id: 'user-1',
    name: 'Debug Exit Project',
    path: '/tmp/project-debug-exit',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-debug-exit',
    subChatId,
    projectId: project.id,
    assistantMessageId: 'assistant-debug-exit',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    _resetExecutorStateForTests();
    debugIngestMocks.startIngestServer.mockResolvedValue(9876);
    debugIngestMocks.registerDebugSession.mockImplementation((sessionId: string) => ({
      endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
      logFilePath: `/tmp/project/.frink/debug/${sessionId}.ndjson`,
    }));
    debugIngestMocks.unregisterDebugSession.mockReset();
    applyExecutorMockDefaults(machineId, project);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    claudeQueryMock.mockImplementation(async function* (input: object) {
      await firePromptSubmit(input);
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-debug-exit' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects the debug-mode exit reminder via the UserPromptSubmit hook when previous turn was debug and now resuming in agent mode', async () => {
    // Turn 1: debug mode
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'debug the login bug',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2: agent mode, resuming session
    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      sessionId: 'sess-debug-exit',
      message: 'now implement the fix',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0];
    const reminder = firedReminders.get(secondCall);
    expect(reminder).toContain('You have exited debug mode');
    expect(reminder).toContain('no longer apply');
    // Delivered via the SDK hook, not prepended to the user prompt.
    expect(await claudePromptText((secondCall as { prompt?: unknown }).prompt)).not.toContain(
      'You have exited debug mode',
    );
  });

  it('does NOT prepend debug exit reminder for back-to-back debug turns', async () => {
    // Turn 1: debug
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'debug turn 1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2: still debug, resuming
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      sessionId: 'sess-debug-exit',
      message: 'debug turn 2',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0] as { prompt?: string };
    expect(await claudePromptText(secondCall.prompt)).not.toContain('You have exited debug mode');
  });

  it('does NOT prepend debug exit reminder on first-ever debug turn (no previous mode)', async () => {
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'first debug turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = claudeQueryMock.mock.calls[0]?.[0] as { prompt?: string };
    expect(await claudePromptText(call.prompt)).not.toContain('You have exited debug mode');
  });

  it('injects the plan exit reminder via the UserPromptSubmit hook when switching plan→debug', async () => {
    // Turn 1: plan
    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan',
      message: 'plan something',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2: debug (resuming)
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      sessionId: 'sess-debug-exit',
      message: 'now debug it',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondCall = claudeQueryMock.mock.calls[1]?.[0];
    const reminder = firedReminders.get(secondCall);
    expect(reminder).toContain('Plan mode is not active');
    expect(await claudePromptText((secondCall as { prompt?: unknown }).prompt)).not.toContain(
      'Plan mode is not active',
    );
  });

  it('unregisters debug session when exiting debug mode', async () => {
    // Turn 1: debug
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'debug turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2: agent (exit debug)
    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      sessionId: 'sess-debug-exit',
      message: 'agent turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(debugIngestMocks.unregisterDebugSession).toHaveBeenCalled();
  });
});

describe('Debug-mode session stability across turns (edge case #1)', () => {
  const machineId = 'machine-debug-session';
  const subChatId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const project = {
    id: 'project-debug-session',
    user_id: 'user-1',
    name: 'Debug Session Project',
    path: '/tmp/project-debug-session',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-debug-session',
    subChatId,
    projectId: project.id,
    assistantMessageId: 'assistant-debug-session',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    _resetExecutorStateForTests();
    debugIngestMocks.startIngestServer.mockResolvedValue(9876);
    debugIngestMocks.registerDebugSession.mockImplementation((sessionId: string) => ({
      endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
      logFilePath: `/tmp/project/.frink/debug/${sessionId}.ndjson`,
    }));
    debugIngestMocks.unregisterDebugSession.mockReset();
    applyExecutorMockDefaults(machineId, project);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    claudeQueryMock.mockImplementation(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-debug-stable' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses the same session ID across consecutive debug turns for the same subChat', async () => {
    // Turn 1: debug mode — should create a new session
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'debug turn 1 — instrument code',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstSessionId = debugIngestMocks.registerDebugSession.mock.calls[0]?.[0] as string;
    expect(firstSessionId).toBeTruthy();

    // Turn 2: still debug mode, resuming — should reuse same session
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      sessionId: 'sess-debug-stable',
      message: 'debug turn 2 — read logs',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // CRITICAL: If bug #1 exists, registerDebugSession will be called twice with
    // different session IDs. The second turn's prompt will reference a NEW log file
    // while the instrumented code still POSTs to the OLD session's endpoint.
    //
    // Expected: registerDebugSession called only once (session reused on turn 2)
    // Bug behavior: registerDebugSession called twice (new session per turn)
    const registerCalls = debugIngestMocks.registerDebugSession.mock.calls;
    expect(registerCalls).toHaveLength(1);

    // Both turns should reference the SAME session ID in their prompts
    const secondPrompt = await claudePromptText(claudeQueryMock.mock.calls[1]?.[0]?.prompt);

    // The session ID from turn 1 should appear in turn 2's prompt too
    if (secondPrompt.includes('DEBUG MODE')) {
      // If turn 2 has debug prompt, it should contain the same session ID
      expect(secondPrompt).toContain(firstSessionId);
    }
  });

  it('uses the same session ID after a simulated app restart for the same subChat', async () => {
    // Turn 1: pre-restart debug message
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'pre-restart debug',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const preRestartSessionId = debugIngestMocks.registerDebugSession.mock.calls[0]?.[0] as string;
    expect(preRestartSessionId).toBeTruthy();

    // Simulate an app restart: clear in-memory executor state and ingest mock history.
    // The Set-based `activeDebugSessions` is wiped (matches Electron crash → reopen).
    _resetExecutorStateForTests();
    debugIngestMocks.registerDebugSession.mockClear();

    // Turn 2: post-restart debug message in the SAME subChat
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      sessionId: 'sess-debug-resumed',
      message: 'post-restart debug',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Critical: post-restart we MUST re-register (process state is empty) AND the ID must
    // match what we used pre-restart so the agent reads the same `.ndjson` log file.
    const postRestartCalls = debugIngestMocks.registerDebugSession.mock.calls;
    expect(postRestartCalls).toHaveLength(1);
    const postRestartSessionId = postRestartCalls[0]?.[0] as string;
    expect(postRestartSessionId).toBe(preRestartSessionId);
    expect(postRestartSessionId).toBe(subChatId.slice(0, 6));
  });

  it('creates a new session for a different subChat even in the same chatId', async () => {
    const otherSubChatId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

    // Turn 1: debug in subChat A
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'debug in pane A',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2: debug in subChat B (different pane)
    await handleRemoteExecute({
      ...basePayload,
      subChatId: otherSubChatId,
      mode: 'debug',
      message: 'debug in pane B',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Should have registered TWO different sessions (one per pane)
    const registerCalls = debugIngestMocks.registerDebugSession.mock.calls;
    expect(registerCalls.length).toBeGreaterThanOrEqual(2);
    const sessionA = registerCalls[0]?.[0] as string;
    const sessionB = registerCalls[1]?.[0] as string;
    expect(sessionA).not.toBe(sessionB);
  });
});

describe('Debug-mode port change reminder after app restart', () => {
  const machineId = 'machine-debug-port';
  const subChatId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
  const project = {
    id: 'project-debug-port',
    user_id: 'user-1',
    name: 'Debug Port Project',
    path: '/tmp/project-debug-port',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-debug-port',
    subChatId,
    projectId: project.id,
    assistantMessageId: 'assistant-debug-port',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    _resetExecutorStateForTests();
    debugIngestMocks.startIngestServer.mockResolvedValue(9876);
    debugIngestMocks.registerDebugSession.mockImplementation((sessionId: string) => ({
      endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
      logFilePath: `/tmp/project/.frink/debug/${sessionId}.ndjson`,
    }));
    debugIngestMocks.unregisterDebugSession.mockReset();
    applyExecutorMockDefaults(machineId, project);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    claudeQueryMock.mockImplementation(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-debug-port' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not inject any port-change reminder regardless of session state', async () => {
    // The ingest server pins port 49237 across restarts and per-session log isolation
    // is keyed on sessionId, not port. Even on the rare fallback branch, agents self-
    // correct from missing log lines — so the reminder was removed. This test guards
    // against re-introducing it.
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      sessionId: 'sess-debug-port',
      message: 'resume after restart',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const call = claudeQueryMock.mock.calls[0]?.[0] as { prompt?: string };
    const promptText = await claudePromptText(call.prompt);
    expect(promptText).not.toContain('debug server has restarted');
    expect(promptText).not.toContain('STALE port');
  });
});

describe('Debug-mode session ID format', () => {
  const machineId = 'machine-debug-id';
  const subChatId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
  const project = {
    id: 'project-debug-id',
    user_id: 'user-1',
    name: 'Debug ID Project',
    path: '/tmp/project-debug-id',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-debug-id',
    subChatId,
    projectId: project.id,
    assistantMessageId: 'assistant-debug-id',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    _resetExecutorStateForTests();
    debugIngestMocks.startIngestServer.mockResolvedValue(9876);
    debugIngestMocks.registerDebugSession.mockImplementation((sessionId: string) => ({
      endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
      logFilePath: `/tmp/project/.frink/debug/${sessionId}.ndjson`,
    }));
    applyExecutorMockDefaults(machineId, project);
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    claudeQueryMock.mockImplementation(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-debug-id' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the first 6 chars of subChatId as the debug session ID (stable + short)', async () => {
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'start debug',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sessionId = debugIngestMocks.registerDebugSession.mock.calls[0]?.[0] as string;
    expect(sessionId).toBe(subChatId.slice(0, 6));
    expect(sessionId).toHaveLength(6);
  });
});

/**
 * Locks in worktree-aware log path semantics: when a chat has a `worktree_path` that exists
 * on disk, projectPath is set to the worktree (executor.ts:1972-1988) BEFORE the SDK debug
 * block runs. The debug log file therefore lives inside the worktree and is recovered when
 * the worktree is reopened. If the worktree is pruned, the log goes with it — by design.
 */
describe('Debug-mode + worktree-backed chat (log path follows worktree)', () => {
  const machineId = 'machine-debug-worktree';
  const subChatId = 'ffffffff-ffff-4fff-ffff-ffffffffffff';
  const worktreePath = '/tmp/worktrees/chat-debug-worktree';
  const project = {
    id: 'project-debug-worktree',
    user_id: 'user-1',
    name: 'Debug Worktree Project',
    path: '/tmp/project-debug-worktree',
    git_remote: null,
    shortcut_project_id: null,
    is_primary: false,
    machine_id: machineId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: null,
    rules: [],
  };

  const claudeCredential = {
    token: 'claude-token',
    isApiKey: true,
    type: 'claude-code' as const,
    label: 'claude-test',
  };

  const basePayload = {
    chatId: 'chat-debug-worktree',
    subChatId,
    projectId: project.id,
    assistantMessageId: 'assistant-debug-worktree',
    history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claudeQueryMock.mockReset();
    stubPermissionsStoreDefault();
    _resetExecutorStateForTests();
    debugIngestMocks.startIngestServer.mockResolvedValue(9876);
    debugIngestMocks.registerDebugSession.mockImplementation((sessionId: string) => ({
      endpointUrl: `http://127.0.0.1:9876/ingest/${sessionId}`,
      logFilePath: `${worktreePath}/.frink/debug/${sessionId}.ndjson`,
    }));
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { worktreePath: worktreePath, taskId: null },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: null,
    });
    vi.mocked(getBundledClaudeBinaryPath).mockReturnValue('/mock/bin/claude');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValue(claudeCredential);
    // existsSync(worktreePath) must return true so the executor adopts it as projectPath.
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(createTransformer).mockReturnValue(function* (sdkMessage: unknown) {
      const chunks = (sdkMessage as { chunks?: UIMessageChunk[] }).chunks ?? [];
      for (const chunk of chunks) {
        yield chunk;
      }
    });
    claudeQueryMock.mockImplementation(async function* () {
      yield {
        chunks: [
          {
            type: 'finish',
            messageMetadata: { sessionId: 'sess-debug-worktree' },
          } satisfies UIMessageChunk,
        ],
      };
      yield { type: 'result' };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the debug session against the worktree path, not project.path', async () => {
    await handleRemoteExecute({
      ...basePayload,
      mode: 'debug',
      message: 'debug inside worktree',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // registerDebugSession(sessionId, projectPath) — second arg must be the worktree path.
    const registerCall = debugIngestMocks.registerDebugSession.mock.calls[0];
    expect(registerCall).toBeDefined();
    const [, registeredProjectPath] = registerCall as unknown as [string, string];
    expect(registeredProjectPath).toBe(worktreePath);
    expect(registeredProjectPath).not.toBe(project.path);
  });
});

describe('validateToolPermission (v2 wrapper)', () => {
  beforeEach(async () => {
    _clearActiveExecutionsForTests();
    vi.mocked(socketClient.sendPermissionRequest).mockClear();
    const { getProjectByPath } = await import('../db/repos/projects');
    vi.mocked(getProjectByPath).mockResolvedValue({
      id: 'project-1',
      name: 'Project One',
      path: '/proj',
    } as unknown as Awaited<ReturnType<typeof getProjectByPath>>);
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValue({ decision: 'allow' });
  });

  function validateWithNativeReview(tool: string, input: Record<string, unknown>) {
    return validateToolPermission(
      tool,
      input,
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );
  }

  registerPermissionDbUnavailableTests({ clientPermissionBridge, validateWithNativeReview });

  it('returns allow when projectPath is undefined (boot-window contract)', async () => {
    const r = await validateToolPermission('Bash', { command: 'ls' }, undefined, 'c1', 's1');
    expect(r).toEqual({ allowed: true });
  });

  it('takes the decision from the dispatcher', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'db:unavailable' },
    });
    const r = await validateToolPermission('Bash', { command: 'ls' }, '/proj', 'c1', 's1');
    expect(vi.mocked(checkPermission)).toHaveBeenCalled();
    expect(r).toMatchObject({ allowed: false });
  });

  it('returns allow when dispatcher returns allow', async () => {
    const r = await validateToolPermission('Bash', { command: 'npm test' }, '/proj', 'c1', 's1');
    expect(r).toEqual({ allowed: true });
  });

  it('returns deny with formatDenyReason message when dispatcher returns deny', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'user' },
    });
    const r = await validateToolPermission('Bash', { command: 'rm -rf /' }, '/proj', 'c1', 's1');
    expect(r).toEqual({
      allowed: false,
      message: expect.stringMatching(/user.*Bash\(rm:\*\)/),
    });
  });

  it('delegates only the ask residual to a provider-native reviewer', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const r = await validateToolPermission(
      'Bash',
      { command: 'npm test' },
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );

    expect(r).toEqual({ allowed: null });
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
    const allowed = await validateWithNativeReview('Bash', { command: 'npm test' });
    expect(allowed).toEqual({ allowed: true });
  });

  it('routes a Flow MCP ask through Frink with the complete permission context', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    const { persistApprovedRule } = await import('../permissions/v2/persist-approved-rule');
    vi.mocked(persistApprovedRule).mockClear();
    const tool = 'mcp__frink_dynamic_chat__frink_flows_patch';
    const input = { flowId: 'flow-1720', operations: [{ op: 'update_settings' }] };
    const prompt = {
      tool,
      input,
      reason: 'no-matching-rule' as const,
      suggestedRules: [tool, 'mcp__frink_dynamic_chat__*'],
    };
    vi.mocked(checkPermission).mockResolvedValueOnce({ decision: 'ask', prompt });
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      expect(payload).toMatchObject({
        chatId: 'flow-chat-1720',
        subChatId: '11111111-1111-4111-8111-111111111111',
        type: 'mcp_tool',
        operation: 'mcp_tool',
        toolName: tool,
        projectName: 'Project One',
        projectPath: '/proj',
        path: 'flow tool: frink_flows_patch',
        reason: 'Flow tool: frink_flows_patch',
        prompt,
      });
      clientPermissionBridge.lastResponseHandler?.({
        ...payload,
        approved: true,
        duration: 'once',
      });
    });

    const result = await validateToolPermission(
      tool,
      input,
      '/proj',
      'flow-chat-1720',
      '11111111-1111-4111-8111-111111111111',
      'Flow tool: frink_flows_patch',
      'flow tool: frink_flows_patch',
      false,
      false,
    );

    expect(result).toEqual({ allowed: true });
    expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
    expect(persistApprovedRule).toHaveBeenCalledWith(
      expect.objectContaining({ promptResult: expect.objectContaining({ duration: 'once' }) }),
    );
  });

  it('cancels a pending Flow permission from its captured execution, not a successor', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    const { persistApprovedRule } = await import('../permissions/v2/persist-approved-rule');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    vi.mocked(persistApprovedRule).mockClear();
    vi.mocked(socketClient.sendPermissionRequest).mockImplementation(() => {});
    const oldController = new AbortController();
    const successorController = new AbortController();
    _registerExecutionForTests('flow-abort-sub', successorController);

    const pending = validateToolPermission(
      'mcp__frink_dynamic_chat__frink_flows_patch',
      { flowId: 'flow-abort' },
      '/proj',
      'flow-abort-chat',
      'flow-abort-sub',
      'Flow tool: frink_flows_patch',
      'flow tool: frink_flows_patch',
      false,
      false,
      oldController.signal,
    );
    await vi.waitFor(() => expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce());
    expect(hasPendingPermissionRequest('flow-abort-sub')).toBe(true);

    oldController.abort();

    await expect(pending).resolves.toMatchObject({ allowed: false });
    expect(hasPendingPermissionRequest('flow-abort-sub')).toBe(false);
    expect(successorController.signal.aborted).toBe(false);
    expect(socketClient.sendPermissionDismiss).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'flow-abort-chat',
        subChatId: 'flow-abort-sub',
      }),
    );
    const requestId = vi.mocked(socketClient.sendPermissionRequest).mock.calls[0]?.[0].requestId;
    if (!requestId) throw new Error('Expected a pending permission request');
    clientPermissionBridge.lastResponseHandler?.({
      chatId: 'flow-abort-chat',
      subChatId: 'flow-abort-sub',
      requestId,
      approved: true,
      duration: 'always',
    });
    expect(persistApprovedRule).not.toHaveBeenCalled();
  });

  it('returns deny with safety:path message for SYSTEM_DENIED_PATTERNS hits', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'safety:path', path: '/proj/.env' },
    });
    const r = await validateWithNativeReview('Read', { file_path: '/proj/.env' });
    expect(r.allowed).toBe(false);
    expect((r as { message: string }).message).toContain('/proj/.env');
  });

  it('passes projectPath (NOT permissionPathOverride) to getProjectByPath', async () => {
    const { getProjectByPath } = await import('../db/repos/projects');
    vi.mocked(getProjectByPath).mockClear();
    await validateToolPermission(
      'Edit',
      { file_path: '/worktree/abc/src/foo.ts' },
      '/proj',
      'c1',
      's1',
      undefined,
      '/proj/src/foo.ts', // permissionPathOverride is a FILE path, not project
    );
    expect(getProjectByPath).toHaveBeenCalledWith(expect.anything(), '/proj');
  });

  it('passes projectId+projectPath to checkPermission', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockClear();
    await validateToolPermission('Bash', { command: 'pwd' }, '/proj', 'c1', 's1');
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'Bash',
        projectId: 'project-1',
        projectPath: '/proj',
      }),
    );
  });

  it('routes a general-chat Write to an ask whose payload has no projectPath', async () => {
    const h = os.homedir();
    const { getProjectByPath } = await import('../db/repos/projects');
    vi.mocked(getProjectByPath).mockResolvedValueOnce(null);
    const { checkPermission } = await import('../permissions/v2/check');
    const ask = { decision: 'ask', prompt: { reason: 'no-matching-rule' } };
    vi.mocked(checkPermission).mockResolvedValueOnce(
      ask as Awaited<ReturnType<typeof checkPermission>>,
    );
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      expect(payload).not.toHaveProperty('projectPath');
      clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: false });
    });
    const r = await validateToolPermission('Write', { file_path: `${h}/n.md` }, h, 'c1', 's1');
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'Write', projectId: '', projectPath: h }),
    );
    expect(r).toEqual({ allowed: false, message: 'User denied permission' });
  });

  function respondTimedOut(): void {
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      clientPermissionBridge.lastResponseHandler?.({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        requestId: payload.requestId,
        approved: false,
        timedOut: true,
      });
    });
  }

  it('prompt wait stays under the CLI 600s per-hook abort (else the deny reason is discarded)', async () => {
    const { PERMISSION_PROMPT_TIMEOUT_MS } = await import('../permissions/constants');
    expect(PERMISSION_PROMPT_TIMEOUT_MS).toBeLessThan(600_000);
  });

  it('timeout deny tells the model the user did NOT deny (no flow steer outside flows)', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    respondTimedOut();
    const r = await validateToolPermission(
      'Bash',
      { command: 'devkit help ship' },
      '/proj',
      'c1',
      's1',
    );
    expect(r.allowed).toBe(false);
    const msg = (r as { message: string }).message;
    expect(msg).toContain('timed out');
    expect(msg).toContain('did NOT deny');
    expect(msg).not.toContain('frink_task_signal');
  });

  it('flow-driven timeout steers the agent to park via frink_task_signal awaiting_input', async () => {
    const { checkPermission } = await import('../permissions/v2/check');
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    respondTimedOut();
    const r = await validateToolPermission(
      'Bash',
      { command: 'devkit help ship' },
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      true,
    );
    expect(r.allowed).toBe(false);
    const msg = (r as { message: string }).message;
    expect(msg).toContain('did NOT deny');
    expect(msg).toContain('frink_task_signal');
    expect(msg).toContain('awaiting_input');
  });
});
