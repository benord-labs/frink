// Split from executor.test.ts (file-size budget): integration tests for Claude plan-mode control
// and failure-boundary behavior. The vi.mock preamble mirrors executor.test.ts because Vitest
// hoists module mocks per test file, so they cannot be shared.

import fs from 'node:fs';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Captures the client permission-response handler so prompt round-trips resolve. */
const permissionBridge = vi.hoisted(() => ({
  // SAFETY: null seeds the slot; the socket-client mock below assigns the real
  // handler before any test resolves a prompt, matching the annotated union.
  lastResponseHandler: null as
    | ((response: {
        chatId: string;
        subChatId: string;
        requestId: string;
        approved: boolean;
        duration?: 'once' | 'always' | 'time-bound';
        timedOut?: boolean;
        scope?: 'project' | 'user';
        ruleString?: string;
        ruleType?: 'allow' | 'deny' | 'ask';
      }) => void)
    | null,
}));

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

const dbProjectState = vi.hoisted(() => ({
  projectRow: null as { id: string; name: string; path: string } | null,
}));

const dynamicChatServerMocks = vi.hoisted(() => ({
  bindChannelExecution: vi.fn(),
  setCurrentExecutionChat: vi.fn(() => 'exec-context-1'),
  clearCurrentExecutionChat: vi.fn(),
  getOrStartDynamicChatMcpUrl: vi.fn(async () => 'http://127.0.0.1:9999'),
  getLatestTaskSignal: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeQueryMock,
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
  // Default null → the restart-interrupted resume branch is skipped (no throw on the active:false path).
  getLatestFlowTaskForSubChat: vi.fn(async () => null),
  cancelFlowTaskForSubChat: vi.fn(async () => 'flow-task-1'),
  parkFlowTaskForSubChatOnUsageLimit: vi.fn(async () => 'parked-task-1'),
}));

vi.mock('../db/repos/task-parking', () => ({
  parkFlowTaskOnClaudeInterruption: vi.fn(async () => undefined),
}));

vi.mock('../db/repos/sub-chats', () => ({
  // Must return a promise: every call site chains `.catch()` on it (fire-and-forget persist).
  updateSubChatMode: vi.fn(async () => undefined),
}));

vi.mock('../flows/resume', () => ({
  isRunRestartInterrupted: vi.fn(async () => false),
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
  onPermissionResponse: vi.fn((cb: NonNullable<typeof permissionBridge.lastResponseHandler>) => {
    permissionBridge.lastResponseHandler = cb;
    return () => {};
  }),
  sendErrorDirect: vi.fn(),
  sendExecuteCompleteDirect: vi.fn(),
  sendPermissionRequest: vi.fn(),
  sendPermissionDismiss: vi.fn(),
  sendStreamSettledDirect: vi.fn(),
  sendStreamChunkDirect: vi.fn(),
  sendSubChatModeChange: vi.fn(),
}));

import { createTransformer, getBundledClaudeBinaryPath } from '../claude';
import type { UIMessageChunk } from '../claude/types';
import { getDefaultClaudeCodeToken } from '../credentials';
import { getChatWithProjectAccount } from '../db/repos/chats';
import { parkFlowTaskOnClaudeInterruption } from '../db/repos/task-parking';
import { getMultiProjectContext } from '../multi-project-prompt';
import { checkPermission } from '../permissions/v2/check';
import {
  submittedPlanFromExitPlanModeInput,
  resolveLatestSessionPlanFile,
} from '../claude/session-plan-paths';
import {
  extractCanonicalPlanTextForFilter,
  filterCanonicalPlanParts,
} from '../../../shared/plan-parts-filter';
import { findUnapprovedPlanPart } from '../../../shared/types/plan';
import { buildPartsFromChunks } from './claude-turn-context';
import type { MessagePart } from './client';
import { handleRemoteExecute } from './executor';
import { emitBurstPlanCard } from './streaming/burst-chunks';
import { validateToolPermission } from './streaming/pending-permission/validate-tool-permission';
import { PLAN_SUBMITTED_FOR_REVIEW } from './streaming/plan-auto-approve';
import { claudePromptText } from './test-utils';

function stubPermissionsStoreDefault() {
  vi.mocked(checkPermission).mockResolvedValue({ decision: 'allow' });
}

describe('Claude plan-mode submission halt', () => {
  const machineId = 'machine-plan-halt';
  const project = {
    id: 'project-plan-halt',
    user_id: 'user-1',
    name: 'Plan Halt Project',
    path: '/tmp/project-plan-halt',
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

  /** Arguments these tests hand canUseTool: a file-op path, or nothing for an MCP call. */
  type ToolInputFixture = { file_path?: string };
  type CanUseToolFn = (
    toolName: string,
    toolInput: ToolInputFixture,
    options: { toolUseID: string },
  ) => Promise<{ behavior: string; message?: string }>;
  type PreToolUseHookFn = (
    input: { hook_event_name: string; tool_name: string; tool_input: unknown },
    toolUseId: string,
  ) => Promise<{
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  }>;
  type PlanQueryCall = {
    options: {
      canUseTool: CanUseToolFn;
      hooks: { PreToolUse: Array<{ hooks: PreToolUseHookFn[] }> };
    };
  };

  /** Plays the CLI's side of a plan submission: the ExitPlanMode call, its PreToolUse hook, then the
   * denied call's error result. Returns the hook's decision. */
  async function* submitPlan(call: PlanQueryCall, id: string, hookInput: unknown = {}) {
    yield {
      chunks: [
        { type: 'tool-input-available', toolCallId: id, toolName: 'ExitPlanMode', input: {} },
      ] satisfies UIMessageChunk[],
    };
    const decision = await call.options.hooks.PreToolUse[0].hooks[0](
      { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: hookInput },
      id,
    );
    const reason = decision.hookSpecificOutput?.permissionDecisionReason ?? '';
    yield {
      chunks: [
        { type: 'tool-output-error', toolCallId: id, errorText: reason },
      ] satisfies UIMessageChunk[],
    };
    return decision.hookSpecificOutput;
  }

  const writePlanChunk = (id: string): UIMessageChunk => ({
    type: 'tool-input-available',
    toolCallId: id,
    toolName: 'Write',
    input: { file_path: '/mock/home/.claude/plans/test-plan.md', content: validPlanContent },
  });

  const basePayload = {
    chatId: 'chat-plan-halt',
    subChatId: '88888888-8888-4888-8888-888888888888',
    projectId: project.id,
    mode: 'plan' as const,
    assistantMessageId: 'assistant-plan-halt',
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
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
    vi.spyOn(fs.promises, 'chmod').mockResolvedValue();
    vi.spyOn(fs.promises, 'rm').mockResolvedValue();
    // sc-953: a live turn requires a resolved userId (entry guard fails closed
    // otherwise); these plan-halt tests exercise authed turns, not the boot window.
    dbProjectState.projectRow = project;
    vi.mocked(getChatWithProjectAccount).mockResolvedValue(null);
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

  it('keeps remote MCP credentials out of Claude SDK failure sinks', async () => {
    const credentialSentinel = 'Bearer story-1625-regression-sentinel';
    const diagnostic = `Remote MCP request failed; Authorization: ${credentialSentinel}`;
    claudeQueryMock.mockImplementationOnce((queryInput: unknown) => {
      const stderr = (queryInput as { options?: { stderr?: (data: string) => void } }).options
        ?.stderr;
      stderr?.(diagnostic);
      throw new Error(`Claude Code exited with code 1: ${diagnostic}`);
    });

    await handleRemoteExecute({ ...basePayload, message: 'MCP request that fails' });

    const loggedText = vi
      .mocked(log.error)
      .mock.calls.map((args) =>
        args.map((value) => (value instanceof Error ? value.message : String(value))).join(' '),
      )
      .join('\n');
    expect(loggedText).not.toContain(credentialSentinel);
    expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
      basePayload.subChatId,
      { kind: 'api-error', status: null, message: 'Claude execution failed. Please try again.' },
    );
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Claude execution failed. Please try again.' }),
    );
    expect(JSON.stringify(vi.mocked(parkFlowTaskOnClaudeInterruption).mock.calls)).not.toContain(
      credentialSentinel,
    );
    expect(JSON.stringify(vi.mocked(clientModule.sendErrorDirect).mock.calls)).not.toContain(
      credentialSentinel,
    );
  });

  it('ends the turn at plan submission by denying ExitPlanMode, keeping the overrun out of history', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    const interrupt = vi.fn().mockResolvedValue(undefined);
    let decision: { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
    claudeQueryMock.mockImplementationOnce((call: PlanQueryCall) => {
      const gen = (async function* () {
        yield { chunks: [writePlanChunk('write-plan-i1')] };
        decision = yield* submitPlan(call, 'exit-plan-i1');
        // A model that ignores the deny's stop — hidden live AND from history.
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'bash-race-1',
              toolName: 'Bash',
              input: { command: 'echo overrun' },
            } satisfies UIMessageChunk,
            {
              type: 'text-delta',
              id: 'race-text',
              delta: 'implementing...',
            } satisfies UIMessageChunk,
          ],
        };
        yield {
          type: 'result',
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-plan-deny-1', resultSubtype: 'success' },
            } satisfies UIMessageChunk,
          ],
        };
      })();
      return Object.assign(gen, { interrupt });
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'create a plan',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(decision?.permissionDecision).toBe('deny');
    expect(decision?.permissionDecisionReason).toBe(PLAN_SUBMITTED_FOR_REVIEW);
    expect(interrupt).not.toHaveBeenCalled();

    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      sessionId?: string;
      finalParts?: Array<{ type?: string; text?: string }>;
    };
    expect(payload.sessionId).toBe('sess-plan-deny-1');
    expect(payload.finalParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-frink-plan' })]),
    );
    expect(payload.finalParts?.some((p) => p.type === 'tool-Bash')).toBe(false);
    expect(payload.finalParts?.some((p) => p.text === 'implementing...')).toBe(false);
  });

  it('denies every tool from plan submission onward (canUseTool AND the PreToolUse hook)', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    const decisions: Array<{ behavior: string } | undefined> = [];
    const hookDecisions: string[] = [];
    claudeQueryMock.mockImplementationOnce((call: PlanQueryCall) => {
      const canUse = call.options.canUseTool;
      const hook = call.options.hooks.PreToolUse[0].hooks[0];
      const gen = (async function* () {
        // Pre-submission: research tools flow normally.
        decisions.push(await canUse('Read', { file_path: '/a.ts' }, { toolUseID: 'pre-1' }));
        yield { chunks: [writePlanChunk('write-plan-g1')] };
        yield* submitPlan(call, 'exit-plan-g1');
        // Post-submission: the model was told to stop; frink's gate holds if it does not.
        decisions.push(await canUse('Write', { file_path: '/b.ts' }, { toolUseID: 'post-1' }));
        decisions.push(await canUse('mcp__shortcut__stories-create', {}, { toolUseID: 'post-2' }));
        const hookRes = await hook(
          { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
          'post-3',
        );
        hookDecisions.push(hookRes.hookSpecificOutput?.permissionDecision ?? 'none');
        yield {
          type: 'result',
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-gate-1' },
            } satisfies UIMessageChunk,
          ],
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn().mockResolvedValue(undefined) });
    });

    await handleRemoteExecute({ ...basePayload, message: 'create a plan' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(decisions[0]?.behavior).toBe('allow');
    expect(decisions[1]?.behavior).toBe('deny');
    expect(decisions[2]?.behavior).toBe('deny');
    expect(hookDecisions[0]).toBe('deny');
  });

  it('keeps the submission halt scoped to its own execution (multi-pane isolation)', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    type CanUseToolFn = (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: { toolUseID: string },
    ) => Promise<{ behavior: string }>;

    // Execution A: submits a plan and halts.
    claudeQueryMock.mockImplementationOnce(() => {
      const gen = (async function* () {
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'write-plan-iso',
              toolName: 'Write',
              input: {
                file_path: '/mock/home/.claude/plans/test-plan.md',
                content: validPlanContent,
              },
            } satisfies UIMessageChunk,
            {
              type: 'tool-input-available',
              toolCallId: 'exit-plan-iso',
              toolName: 'ExitPlanMode',
              input: {},
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'exit-plan-iso',
              output: { success: true },
            } satisfies UIMessageChunk,
            { type: 'finish', messageMetadata: {} } satisfies UIMessageChunk,
          ],
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn().mockResolvedValue(undefined) });
    });
    await handleRemoteExecute({ ...basePayload, message: 'plan in pane A' });

    // Execution B (another pane / sub-chat turn): its gate must start open — a halt that leaked
    // across executions would dead-lock every other pane's tools.
    const decisionsB: Array<{ behavior: string } | undefined> = [];
    claudeQueryMock.mockImplementationOnce((call: { options: Record<string, unknown> }) => {
      const canUse = call.options.canUseTool as CanUseToolFn;
      const gen = (async function* () {
        decisionsB.push(await canUse('Write', { file_path: '/c.ts' }, { toolUseID: 'b-1' }));
        yield {
          chunks: [{ type: 'finish', messageMetadata: {} } satisfies UIMessageChunk],
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn().mockResolvedValue(undefined) });
    });
    await handleRemoteExecute({
      ...basePayload,
      subChatId: 'sub-chat-pane-b',
      assistantMessageId: 'assistant-pane-b',
      message: 'work in pane B',
    });

    expect(decisionsB[0]?.behavior).toBe('allow');
  });

  it('mid-turn EnterPlanMode: halts at ExitPlanMode and keeps the overrun out of view', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);

    let decision: { permissionDecision?: string } | undefined;
    claudeQueryMock.mockImplementationOnce((call: PlanQueryCall) => {
      const gen = (async function* () {
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'enter-plan-m1',
              toolName: 'EnterPlanMode',
              input: {},
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'enter-plan-m1',
              output: { success: true },
            } satisfies UIMessageChunk,
            writePlanChunk('write-plan-m1'),
          ],
        };
        decision = yield* submitPlan(call, 'exit-plan-m1');
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'edit-race-m1',
              toolName: 'Edit',
              input: { file_path: '/src/x.ts' },
            } satisfies UIMessageChunk,
            {
              type: 'text-delta',
              id: 'race-m1',
              delta: 'implementing...',
            } satisfies UIMessageChunk,
          ],
        };
        yield {
          type: 'result',
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-midturn-1' },
            } satisfies UIMessageChunk,
          ],
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn() });
    });

    await handleRemoteExecute({ ...basePayload, mode: 'agent', message: 'fix the bug' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(decision?.permissionDecision).toBe('deny');
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      sessionId?: string;
      finalParts?: Array<{ type?: string; text?: string }>;
    };
    expect(payload.sessionId).toBe('sess-midturn-1');
    expect(payload.finalParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-frink-plan' })]),
    );
    expect(payload.finalParts?.some((p) => p.type === 'tool-Edit')).toBe(false);
    expect(payload.finalParts?.some((p) => p.text === 'implementing...')).toBe(false);
  });

  it('auto-approve flow plan node: never interrupted, in-turn implementation persists', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const { getFlowDriveInfoForSubChat } = await import('../db/repos/tasks');
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: true,
      taskId: 'flow-task-auto-1',
    } as never);

    const interrupt = vi.fn().mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(() => {
      const gen = (async function* () {
        yield {
          chunks: [
            {
              type: 'tool-input-available',
              toolCallId: 'write-plan-a1',
              toolName: 'Write',
              input: {
                file_path: '/mock/home/.claude/plans/test-plan.md',
                content: validPlanContent,
              },
            } satisfies UIMessageChunk,
            {
              type: 'tool-input-available',
              toolCallId: 'exit-plan-a1',
              toolName: 'ExitPlanMode',
              input: {},
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'exit-plan-a1',
              output: { success: true },
            } satisfies UIMessageChunk,
            // In-turn implementation: must stream AND persist (flow-node-advance-timing target).
            {
              type: 'tool-input-available',
              toolCallId: 'impl-write-a1',
              toolName: 'Write',
              input: { file_path: '/src/impl.ts', content: 'export const x = 1;' },
            } satisfies UIMessageChunk,
            {
              type: 'tool-output-available',
              toolCallId: 'impl-write-a1',
              output: { success: true },
            } satisfies UIMessageChunk,
          ],
        };
        yield {
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-auto-1' },
            } satisfies UIMessageChunk,
          ],
        };
        yield { type: 'result' };
      })();
      return Object.assign(gen, { interrupt });
    });

    await handleRemoteExecute({ ...basePayload, message: 'flow plan node' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(interrupt).not.toHaveBeenCalled();
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string; input?: { file_path?: string } }>;
    };
    expect(
      payload.finalParts?.some(
        (p) => p.type === 'tool-Write' && p.input?.file_path === '/src/impl.ts',
      ),
    ).toBe(true);

    // Parts-state re-fold guard: the inline plan card appends chunks to collectedChunks OUTSIDE
    // the SDK loop, so the loop's incremental parts state must re-fold — a snapshot streamed
    // after the card that lacks the frink-plan part means the injected chunks were lost.
    const clientMock = vi.mocked(clientModule.sendStreamChunkDirect);
    const implInputCall = clientMock.mock.calls.find(
      ([p]) =>
        (p as { chunk?: { toolCallId?: string; type?: string } }).chunk?.toolCallId ===
          'impl-write-a1' &&
        (p as { chunk?: { type?: string } }).chunk?.type === 'tool-input-available',
    );
    const implParts = (implInputCall?.[0] as { parts?: Array<{ type?: string }> }).parts;
    expect(implParts?.some((p) => p.type === 'tool-frink-plan')).toBe(true);
    expect(implParts?.some((p) => p.type === 'tool-Write')).toBe(true);
  });

  /**
   * An auto-approved plan node plans AND implements in one turn. Auto covers the whole turn: it arms
   * the during-plan reviewer while planning (plan→default→plan flip, opt-in applied first — the query
   * never touches 'auto') and, at plan approval, switches the implementation half to 'auto'.
   * `armAutoReview` is forced there because planning already set the abstain flag.
   */
  const planExitStream = (
    setPermissionMode: ReturnType<typeof vi.fn>,
    applyFlagSettings: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  ) => {
    const gen = (async function* () {
      yield {
        chunks: [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-auto',
            toolName: 'Write',
            input: {
              file_path: '/mock/home/.claude/plans/test-plan.md',
              content: validPlanContent,
            },
          } satisfies UIMessageChunk,
          {
            type: 'tool-input-available',
            toolCallId: 'exit-plan-auto',
            toolName: 'ExitPlanMode',
            input: {},
          } satisfies UIMessageChunk,
          {
            type: 'tool-output-available',
            toolCallId: 'exit-plan-auto',
            output: { success: true },
          } satisfies UIMessageChunk,
        ],
      };
      yield { chunks: [{ type: 'finish' } satisfies UIMessageChunk] };
      yield { type: 'result' };
    })();
    return Object.assign(gen, {
      interrupt: vi.fn().mockResolvedValue(undefined),
      setPermissionMode,
      applyFlagSettings,
    });
  };

  it('auto-approve plan node: arms Auto during planning, then switches to auto for the implementation half', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const { getFlowDriveInfoForSubChat } = await import('../db/repos/tasks');
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: true,
      taskId: 'flow-task-auto-arm',
    } as never);

    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    let spawnOptions: { permissionMode?: string; env?: Record<string, string> } | undefined;
    claudeQueryMock.mockImplementationOnce((queryInput: unknown) => {
      spawnOptions = (queryInput as { options?: typeof spawnOptions }).options;
      return planExitStream(setPermissionMode, applyFlagSettings);
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'flow plan node with auto',
      settings: { model: 'sonnet', autoReviewTools: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Planning is armed via the plan→default→plan flip (opt-in first; never touches 'auto'), and at
    // plan approval the implementation half is switched to 'auto' so its tools are reviewed too.
    expect(applyFlagSettings).toHaveBeenCalledWith({ skipAutoPermissionPrompt: true });
    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(setPermissionMode).toHaveBeenCalledWith('plan');
    expect(setPermissionMode).toHaveBeenCalledWith('auto');
    // The spawn opens in 'plan' so the read-only restriction is in effect from t=0, with the gate env.
    expect(spawnOptions?.permissionMode).toBe('plan');
    expect(spawnOptions?.env?.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe('1');
  });

  it('plan node NOT flow-auto-approved: still auto-reviews the PLANNING phase, then halts at the plan', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const { getFlowDriveInfoForSubChat } = await import('../db/repos/tasks');
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'flow-task-nonauto-arm',
    } as never);

    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    claudeQueryMock.mockImplementationOnce(() =>
      planExitStream(setPermissionMode, applyFlagSettings),
    );

    await handleRemoteExecute({
      ...basePayload,
      message: 'flow plan node awaiting approval',
      settings: { model: 'sonnet', autoReviewTools: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Auto covers planning independently of plan approval ("auto mode !== auto accept/approve"): the
    // planning phase is armed (plan→default→plan flip), but with no auto-approve the plan still halts,
    // so 'auto' is never sent.
    expect(applyFlagSettings).toHaveBeenCalledWith({ skipAutoPermissionPrompt: true });
    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(setPermissionMode).toHaveBeenCalledWith('plan');
    expect(setPermissionMode).not.toHaveBeenCalledWith('auto');
  });

  it('plan-auto arm FAILS during planning: armAutoReview is the implementation-half fallback', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const { getFlowDriveInfoForSubChat } = await import('../db/repos/tasks');
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: true,
      taskId: 'flow-task-arm-fallback',
    } as never);

    const setPermissionMode = vi.fn().mockResolvedValue(undefined);
    // The during-plan opt-in rejects (closed gate / tier miss), so the abstain flag stays off — and
    // `armAutoReview` at plan exit must still arm the implementation half for the auto-approved node.
    const applyFlagSettings = vi.fn().mockRejectedValue(new Error('gate closed'));
    claudeQueryMock.mockImplementationOnce(() =>
      planExitStream(setPermissionMode, applyFlagSettings),
    );

    await handleRemoteExecute({
      ...basePayload,
      message: 'flow plan node, during-plan arm fails',
      settings: { model: 'sonnet', autoReviewTools: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
  });

  it('planning phase: a plugin MCP residual is denied by the plan floor, not carded', async () => {
    // Plugin tools now reach the canUseTool MCP branch like every other MCP tool, so during
    // planning an undecided residual hits the fail-safe deny instead of raising an approval card.
    const { checkPermission } = await import('../permissions/v2/check');
    // SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
    vi.mocked(checkPermission).mockResolvedValue({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    type CanUseToolFn = (
      toolName: string,
      toolInput: ToolInputFixture,
      options: { toolUseID: string },
    ) => Promise<{ behavior: string; message?: string }>;

    const decisions: Array<{ behavior: string; message?: string } | undefined> = [];
    claudeQueryMock.mockImplementationOnce((call: { options: { canUseTool: CanUseToolFn } }) => {
      const canUse = call.options.canUseTool;
      const gen = (async function* () {
        // The during-plan arming runs on the first live frame, so emit one and let it settle
        // before the tool call — otherwise the turn is still un-armed and falls to the card.
        yield { chunks: [] };
        await new Promise((resolve) => setTimeout(resolve, 0));
        decisions.push(
          await canUse(
            'mcp__plugin_slack_slack__chat_post_message',
            {},
            {
              toolUseID: 'plugin-plan-1',
            },
          ),
        );
        yield {
          chunks: [{ type: 'finish', messageMetadata: {} } satisfies UIMessageChunk],
        };
      })();
      // The during-plan flip goes through these two, exactly as planExitStream stages it;
      // without them arming throws and the turn stays un-armed.
      return Object.assign(gen, {
        interrupt: vi.fn().mockResolvedValue(undefined),
        setPermissionMode: vi.fn().mockResolvedValue(undefined),
        applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      });
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'plan turn calling a plugin tool',
      settings: { model: 'sonnet', autoReviewTools: true },
    });

    expect(decisions[0]).toEqual({
      behavior: 'deny',
      message: 'Provider review was not available',
    });
  });

  it('planning phase, arm FAILED: an MCP ask the hook already prompted for is allowed, not floored or re-carded', async () => {
    // sc-1357: un-armed, the hook already prompted, so canUseTool must neither re-card nor floor —
    // the planning floor applies only once Auto is actually armed.
    const clientModule = await import('./client');
    vi.mocked(checkPermission).mockResolvedValue({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    // Approve any card, so a regression surfaces as an extra request rather than a 9.5-min hang.
    vi.mocked(clientModule.sendPermissionRequest).mockClear();
    vi.mocked(clientModule.sendPermissionRequest).mockImplementation((request) => {
      permissionBridge.lastResponseHandler?.({ ...request, approved: true });
    });

    const decisions: Array<{ behavior: string; message?: string } | undefined> = [];
    claudeQueryMock.mockImplementationOnce(
      (call: {
        options: {
          canUseTool: (
            toolName: string,
            toolInput: ToolInputFixture,
            options: { toolUseID: string },
          ) => Promise<{ behavior: string; message?: string }>;
        };
      }) => {
        const gen = (async function* () {
          yield { chunks: [] };
          await new Promise((resolve) => setTimeout(resolve, 0));
          decisions.push(
            await call.options.canUseTool('mcp__deploy__ship', {}, { toolUseID: 'unarmed-1' }),
          );
          yield {
            chunks: [{ type: 'finish', messageMetadata: {} } satisfies UIMessageChunk],
          };
        })();
        // The opt-in rejects (closed gate / tier miss), so the turn stays un-armed.
        return Object.assign(gen, {
          interrupt: vi.fn().mockResolvedValue(undefined),
          setPermissionMode: vi.fn().mockResolvedValue(undefined),
          applyFlagSettings: vi.fn().mockRejectedValue(new Error('gate closed')),
        });
      },
    );

    try {
      await handleRemoteExecute({
        ...basePayload,
        message: 'plan turn, arm fails, MCP call',
        settings: { model: 'sonnet', autoReviewTools: true },
      });
      expect(clientModule.sendPermissionRequest).not.toHaveBeenCalled();
    } finally {
      vi.mocked(clientModule.sendPermissionRequest).mockReset();
    }

    expect(decisions[0]).toEqual({ behavior: 'allow', updatedInput: {} });
  });

  it('flow-driven non-auto plan node: halts resumable, never marks the flow task failed', async () => {
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
    const { getFlowDriveInfoForSubChat, updateTaskStatus } = await import('../db/repos/tasks');
    vi.mocked(getFlowDriveInfoForSubChat).mockResolvedValueOnce({
      active: true,
      autoApprovePlan: false,
      taskId: 'flow-task-nonauto-1',
    } as never);

    claudeQueryMock.mockImplementationOnce((call: PlanQueryCall) => {
      const gen = (async function* () {
        yield { chunks: [writePlanChunk('write-plan-f1')] };
        yield* submitPlan(call, 'exit-plan-f1');
        yield {
          type: 'result',
          chunks: [
            {
              type: 'finish',
              messageMetadata: { sessionId: 'sess-flow-nonauto-1', resultSubtype: 'success' },
            } satisfies UIMessageChunk,
          ],
        };
      })();
      return Object.assign(gen, { interrupt: vi.fn() });
    });

    await handleRemoteExecute({ ...basePayload, message: 'flow plan node without skipReview' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
    // The node parks for approval (flow-agent-node-mode resume surface): the halt must never
    // terminalize the driving flow task as failed.
    const failedCalls = vi
      .mocked(updateTaskStatus)
      .mock.calls.filter((call) => call.includes('failed'));
    expect(failedCalls).toHaveLength(0);
    const completeCalls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
    const payload = completeCalls[completeCalls.length - 1]?.[0] as {
      finalParts?: Array<{ type?: string; input?: { status?: string } }>;
    };
    const planPart = payload.finalParts?.find((p) => p.type === 'tool-frink-plan');
    expect(planPart?.input?.status).toBe('awaiting_approval');
  });

  it('approval turn resumes the halted session with the approved-plan context injected', async () => {
    // The turn after a halt: user approved, mode flipped to agent, transport passes the
    // persisted sessionId + approved-plan context. The SDK call must resume that session.
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
    claudeQueryMock.mockImplementationOnce(
      (call: { prompt: unknown; options: Record<string, unknown> }) => {
        calls.push(call);
        const gen = (async function* () {
          yield {
            chunks: [
              {
                type: 'finish',
                messageMetadata: { sessionId: 'sess-halt-resume-1' },
              } satisfies UIMessageChunk,
            ],
          };
          yield { type: 'result' };
        })();
        return Object.assign(gen, { interrupt: vi.fn().mockResolvedValue(undefined) });
      },
    );

    await handleRemoteExecute({
      ...basePayload,
      mode: 'agent',
      sessionId: 'sess-halt-resume-1',
      approvedPlanContext: {
        planText: 'Test plan overview',
        planId: 'plan-1',
      },
      message: 'Implement the approved plan from the approved_plan context.',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    const options = calls[0].options as { resume?: string; continue?: boolean };
    expect(options.resume).toBe('sess-halt-resume-1');
    expect(options.continue).toBeUndefined();
    // The prompt is now a streaming input queue (kept open all turn so the CLI's permission control
    // channel stays live); read the initial user message's text out of it.
    const prompt = await claudePromptText(calls[0].prompt);
    expect(prompt).toContain('<approved_plan>\nTest plan overview\n</approved_plan>');
    expect(prompt).toContain('already approved');
    const clientModule = await import('./client');
    expect(vi.mocked(clientModule.sendErrorDirect)).not.toHaveBeenCalled();
  });

  const sessionPlansDir = `/mock/userData/claude-sessions/${basePayload.subChatId}/plans`;
  type PlanDirListing = Awaited<ReturnType<typeof fs.promises.readdir>>;

  /** Mocks the session plans dir listing: file name -> mtimeMs. */
  const mockPlansDir = (files: Record<string, number>) => {
    const entries: unknown = Object.keys(files).map((name) => ({ name, isFile: () => true }));
    // SAFETY: resolveLatestSessionPlanFile reads only `.name` and `.isFile()` from each entry.
    vi.spyOn(fs.promises, 'readdir').mockResolvedValue(entries as PlanDirListing);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (statPath) =>
      // A real Stats instance with only mtimeMs overridden — the resolver reads nothing else.
      Object.assign(fs.statSync('.'), {
        mtimeMs: files[String(statPath).split('/').pop() ?? ''] ?? 0,
      }),
    );
  };

  describe('plan-card refresh from the session plans dir', () => {
    const finalPartsOfLastComplete = async () => {
      const clientModule = await import('./client');
      const calls = vi.mocked(clientModule.sendExecuteCompleteDirect).mock.calls;
      // SAFETY: sendExecuteCompleteDirect receives the executor's completion payload shape.
      const payload = calls[calls.length - 1]?.[0] as {
        finalParts?: Array<{ type?: string; text?: string; input?: { planPath?: string } }>;
      };
      return payload?.finalParts ?? [];
    };

    // A bare result terminal (no finish metadata) ends the stream without arming the wake pump,
    // whose stop-hook surface these tests do not mock. `submission` submits a plan after `chunks`.
    const queueTurn = (
      chunks: UIMessageChunk[],
      end: 'finish' | 'result' = 'finish',
      submission?: { id: string; hookInput?: unknown },
    ) => {
      claudeQueryMock.mockImplementationOnce((call: PlanQueryCall) => {
        const gen = (async function* () {
          yield { chunks };
          if (submission) yield* submitPlan(call, submission.id, submission.hookInput);
          yield end === 'finish'
            ? {
                type: 'result',
                chunks: [
                  {
                    type: 'finish',
                    messageMetadata: { sessionId: 'sess-plan-refresh-1', resultSubtype: 'success' },
                  } satisfies UIMessageChunk,
                ],
              }
            : { type: 'result' };
        })();
        return Object.assign(gen, { interrupt: vi.fn() });
      });
    };

    const proseChunks = (id: string): UIMessageChunk[] => [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: 'the drafted plan as text' },
      { type: 'text-end', id },
    ];

    it('emits the card from the session plans dir when the CLI names no plan file (wake-burst edits)', async () => {
      mockPlansDir({ 'stale.md': 1000, 'plan.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      queueTurn([], 'finish', { id: 'exit-plan-refresh-1' });

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/plan.md`);
      expect(fs.promises.readFile).toHaveBeenCalledWith(`${sessionPlansDir}/plan.md`, 'utf8');
    });

    it('renders the plan file the CLI names and never scans the dir, even with a newer decoy', async () => {
      mockPlansDir({ 'newer-decoy.md': 9000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      queueTurn([], 'finish', {
        id: 'exit-plan-sdk-1',
        hookInput: { plan: '# The plan', planFilePath: `${sessionPlansDir}/from-sdk.md` },
      });

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/from-sdk.md`);
      // The only signal separating "the named file won" from "the scan happened to agree".
      expect(fs.promises.readdir).not.toHaveBeenCalled();
    });

    it('vetoes a named file whose plan text is empty and falls back to the scan', async () => {
      mockPlansDir({ 'sibling.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      queueTurn([], 'finish', {
        id: 'exit-plan-null-1',
        hookInput: { plan: '', planFilePath: `${sessionPlansDir}/missing.md` },
      });

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/sibling.md`);
      expect(fs.promises.readFile).not.toHaveBeenCalledWith(
        `${sessionPlansDir}/missing.md`,
        'utf8',
      );
    });

    it('emits no card and replays prose when no plan file is named and the plans dir is empty', async () => {
      mockPlansDir({});
      queueTurn(proseChunks('plan-prose-1'), 'finish', { id: 'exit-plan-null-2' });

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      expect(finalParts.some((part) => part.type === 'tool-frink-plan')).toBe(false);
      expect(finalParts.some((part) => part.text === 'the drafted plan as text')).toBe(true);
    });

    it('replays prose when the written plan file vanishes before emission — never a blank turn', async () => {
      mockPlansDir({});
      vi.spyOn(fs.promises, 'readFile').mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
      const write: UIMessageChunk = {
        type: 'tool-input-available',
        toolCallId: 'write-gone-1',
        toolName: 'Write',
        input: { file_path: `${sessionPlansDir}/vanished.md`, content: validPlanContent },
      };
      // No submitted text to snapshot: the CLI could not read the plan file either.
      queueTurn([...proseChunks('plan-prose-2'), write], 'finish', { id: 'exit-plan-gone-1' });

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      expect(finalParts.some((part) => part.type === 'tool-frink-plan')).toBe(false);
      // Persistence folds collectedChunks either way; the replay is what reaches the LIVE stream
      // (plan-mode suppression withheld the text during streaming), so assert the send itself.
      const clientModule = await import('./client');
      const replayed = vi
        .mocked(clientModule.sendStreamChunkDirect)
        .mock.calls.some(([payload]) => {
          // SAFETY: the mocked sender receives the executor's StreamChunkPayload shape.
          const chunk = (payload as { chunk: UIMessageChunk }).chunk;
          return chunk.type === 'text-delta' && chunk.delta === 'the drafted plan as text';
        });
      expect(replayed).toBe(true);
    });

    it('renders the submitted plan over an earlier in-stream Write', async () => {
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      queueTurn(
        [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-a',
            toolName: 'Write',
            input: { file_path: `${sessionPlansDir}/plan-a.md`, content: validPlanContent },
          },
          { type: 'tool-output-available', toolCallId: 'write-plan-a', output: { success: true } },
        ],
        'finish',
        {
          id: 'exit-plan-prec-1',
          hookInput: { plan: '# The plan', planFilePath: `${sessionPlansDir}/plan-b.md` },
        },
      );

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/plan-b.md`);
    });

    it('builds the card from the submitted text even when its file cannot be read', async () => {
      vi.spyOn(fs.promises, 'readFile').mockImplementation(async (path) => {
        if (String(path).endsWith('plan-b.md'))
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return validPlanContent;
      });
      queueTurn(
        [
          {
            type: 'tool-input-available',
            toolCallId: 'write-plan-a',
            toolName: 'Write',
            input: { file_path: `${sessionPlansDir}/plan-a.md`, content: validPlanContent },
          },
          { type: 'tool-output-available', toolCallId: 'write-plan-a', output: { success: true } },
        ],
        'finish',
        {
          id: 'exit-plan-prec-2',
          hookInput: { plan: '# The plan', planFilePath: `${sessionPlansDir}/plan-b.md` },
        },
      );

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/plan-b.md`);
      expect(fs.promises.readFile).not.toHaveBeenCalledWith(`${sessionPlansDir}/plan-b.md`, 'utf8');
    });

    it('both sites resolve the named file: a failed inline emit does not fall back to the scan', async () => {
      mockPlansDir({ 'newer-decoy.md': 9000 });
      vi.spyOn(fs.promises, 'readFile')
        .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
        .mockResolvedValue(validPlanContent);
      queueTurn([], 'finish', {
        id: 'exit-plan-sdk-2',
        hookInput: { plan: '# The plan', planFilePath: `${sessionPlansDir}/from-sdk.md` },
      });

      await handleRemoteExecute({ ...basePayload, message: 'carry on' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/from-sdk.md`);
      expect(fs.promises.readdir).not.toHaveBeenCalled();
    });

    it('re-emits the card when a follow-up turn amends the plan with Edit only and never re-calls ExitPlanMode', async () => {
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      queueTurn(
        [
          {
            type: 'tool-input-available',
            toolCallId: 'edit-plan-refresh-1',
            toolName: 'Edit',
            input: {
              file_path: `${sessionPlansDir}/plan.md`,
              old_string: 'Step one',
              new_string: 'Step one (amended)',
            },
          },
          {
            type: 'tool-output-available',
            toolCallId: 'edit-plan-refresh-1',
            output: { success: true },
          },
        ],
        'result',
      );

      await handleRemoteExecute({ ...basePayload, message: 'amend the plan' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      const card = finalParts.find((part) => part.type === 'tool-frink-plan');
      expect(card?.input?.planPath).toBe(`${sessionPlansDir}/plan.md`);
    });

    it('does not scavenge the plans dir on a prose-only plan turn (no ExitPlanMode, no mutation)', async () => {
      mockPlansDir({ 'plan.md': 2000 });
      queueTurn(
        [
          { type: 'text-start', id: 'prose-1' },
          { type: 'text-delta', id: 'prose-1', delta: 'just an answer' },
          { type: 'text-end', id: 'prose-1' },
        ],
        'result',
      );

      await handleRemoteExecute({ ...basePayload, message: 'a question' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const finalParts = await finalPartsOfLastComplete();
      expect(finalParts.some((part) => part.type === 'tool-frink-plan')).toBe(false);
      expect(finalParts.some((part) => part.text === 'just an answer')).toBe(true);
    });
  });

  describe('emitBurstPlanCard (wake-burst plan submission)', () => {
    const exitPlanAttempt = (): UIMessageChunk[] => [
      {
        type: 'tool-input-available',
        toolCallId: 'burst-exit-1',
        toolName: 'ExitPlanMode',
        input: {},
      },
    ];
    type BurstStreamChunk = (
      msgId: string,
      chunk: UIMessageChunk,
      parts: MessagePart[],
      index: number,
    ) => void;
    const burstArgs = (
      chunks: UIMessageChunk[],
      streamChunk: BurstStreamChunk,
      onSubmitted: () => void,
      waitStartedMs = 0,
    ) => ({
      chatId: basePayload.chatId,
      subChatId: basePayload.subChatId,
      msgId: 'msg-burst',
      chunks,
      startIndex: 0,
      deniedToolIdsWithMessages: new Map([['burst-exit-1', 'denied']]),
      flowDriven: false,
      planAutoApprove: false,
      // The burst owns the index; a card must continue its counter, never restart at 0.
      nextMessageIndex: (() => {
        let i = 41;
        return () => ++i;
      })(),
      streamChunk,
      onSubmitted,
      planAlreadySubmitted: false,
      waitStartedMs,
    });

    it('renders the plan file as an awaiting-approval card, continuing the burst index', async () => {
      mockPlansDir({ 'stale.md': 1000, 'plan.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      const streamChunk = vi.fn<BurstStreamChunk>();
      const onSubmitted = vi.fn();
      const chunks = exitPlanAttempt();

      await emitBurstPlanCard(burstArgs(chunks, streamChunk, onSubmitted));

      expect(fs.promises.readFile).toHaveBeenCalledWith(`${sessionPlansDir}/plan.md`, 'utf8');
      const card = chunks.find(
        (chunk) => chunk.type === 'tool-input-available' && chunk.toolName === 'frink-plan',
      );
      // The acceptance criterion: a live Approve, with no user message sent.
      expect(card && 'input' in card ? card.input : undefined).toMatchObject({
        status: 'awaiting_approval',
      });
      expect(onSubmitted).toHaveBeenCalledTimes(1);
      const indices = streamChunk.mock.calls.map((call) => call[3]);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(indices[0]).toBeGreaterThan(41);
    });

    it('ignores a plan left by an earlier turn — the plans dir outlives the wait', async () => {
      mockPlansDir({ 'plan.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      const streamChunk = vi.fn<BurstStreamChunk>();
      const onSubmitted = vi.fn();

      // The only plan on disk predates this wait, so it is a previous turn's, not this one's.
      await emitBurstPlanCard(burstArgs(exitPlanAttempt(), streamChunk, onSubmitted, 3000));

      expect(streamChunk).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('cards a plan written in the same millisecond the wait began', async () => {
      // The guard excludes EARLIER turns, so the wait's own first millisecond must still qualify.
      mockPlansDir({ 'plan.md': 5000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      const onSubmitted = vi.fn();

      await emitBurstPlanCard(
        burstArgs(exitPlanAttempt(), vi.fn<BurstStreamChunk>(), onSubmitted, 5000),
      );

      expect(onSubmitted).toHaveBeenCalledTimes(1);
    });

    it('raises no halt when the plan file is empty — the model is not stopped for a card nobody saw', async () => {
      mockPlansDir({ 'plan.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue('   ');
      const streamChunk = vi.fn<BurstStreamChunk>();
      const onSubmitted = vi.fn();

      await emitBurstPlanCard(burstArgs(exitPlanAttempt(), streamChunk, onSubmitted));

      expect(streamChunk).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('raises no halt when the plan file cannot be read', async () => {
      mockPlansDir({ 'plan.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockRejectedValue(
        Object.assign(new Error('EACCES'), { code: 'EACCES' }),
      );
      const onSubmitted = vi.fn();

      await emitBurstPlanCard(burstArgs(exitPlanAttempt(), vi.fn<BurstStreamChunk>(), onSubmitted));

      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('emits nothing when the plan file disappears between resolve and stat', async () => {
      mockPlansDir({ 'plan.md': 2000 });
      // resolveLatestSessionPlanFile stats first and must succeed; only the ownership stat that
      // follows it fails, which is the sole path into isPlanFromThisWait's catch.
      let statCalls = 0;
      vi.spyOn(fs.promises, 'stat').mockImplementation(async () => {
        statCalls += 1;
        if (statCalls > 1) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return Object.assign(fs.statSync('.'), { mtimeMs: 2000 });
      });
      const streamChunk = vi.fn<BurstStreamChunk>();
      const onSubmitted = vi.fn();

      await emitBurstPlanCard(burstArgs(exitPlanAttempt(), streamChunk, onSubmitted));

      // Two stats: the resolver's, then the ownership check that threw. Pins that this exercises
      // isPlanFromThisWait rather than exiting early on a null path like the no-plan-file case.
      expect(statCalls).toBe(2);
      expect(streamChunk).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it('produces a card the approval surface accepts — Approve is live with no user message', async () => {
      mockPlansDir({ 'plan.md': 2000 });
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(validPlanContent);
      const chunks = exitPlanAttempt();

      await emitBurstPlanCard(burstArgs(chunks, vi.fn<BurstStreamChunk>(), vi.fn()));

      // The wiring that makes this the acceptance criterion: the renderer resolves Approve from
      // the persisted parts, so a card the selector cannot read is a card the user cannot action.
      const raw = buildPartsFromChunks(chunks);
      const persisted = filterCanonicalPlanParts(raw, extractCanonicalPlanTextForFilter(raw));
      const found = findUnapprovedPlanPart(persisted);
      expect(found?.planContext?.planText).toBeTruthy();
      expect(found?.flowDriven).toBe(false);
    });

    it('emits nothing, and raises no halt, when the burst wrote no plan file to submit', async () => {
      mockPlansDir({});
      const streamChunk = vi.fn<BurstStreamChunk>();
      const onSubmitted = vi.fn();
      await emitBurstPlanCard(burstArgs(exitPlanAttempt(), streamChunk, onSubmitted));
      expect(streamChunk).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });
  });

  describe('submittedPlanFromExitPlanModeInput', () => {
    const valid = (planFilePath: string) => ({ plan: '# P', planFilePath });
    const sub = basePayload.subChatId;

    it('returns a contained session-plans path', () => {
      const fp = `${sessionPlansDir}/plan.md`;
      expect(submittedPlanFromExitPlanModeInput(valid(fp), sub)).toEqual({ path: fp, text: '# P' });
    });

    it('returns a machine-global ~/.claude/plans path — the input carries the attribution the scan lacks', () => {
      const fp = '/mock/home/.claude/plans/plan.md';
      expect(submittedPlanFromExitPlanModeInput(valid(fp), sub)).toEqual({ path: fp, text: '# P' });
    });

    it('rejects a foreign sub-chat path, a relative path, an unread plan, and raw model input', () => {
      const foreign = '/mock/userData/claude-sessions/other-sub-chat-id/plans/plan.md';
      expect(submittedPlanFromExitPlanModeInput(valid(foreign), sub)).toBeNull();
      expect(submittedPlanFromExitPlanModeInput(valid('plan.md'), sub)).toBeNull();
      expect(
        submittedPlanFromExitPlanModeInput(
          { plan: '', planFilePath: `${sessionPlansDir}/p.md` },
          sub,
        ),
      ).toBeNull();
      expect(submittedPlanFromExitPlanModeInput({ allowedPrompts: [] }, sub)).toBeNull();
    });
  });

  describe('resolveLatestSessionPlanFile', () => {
    it('picks the newest-mtime .md and ignores other extensions', async () => {
      mockPlansDir({ 'old.md': 1000, 'new.md': 2000, 'notes.txt': 3000 });
      expect(await resolveLatestSessionPlanFile(basePayload.subChatId)).toBe(
        `${sessionPlansDir}/new.md`,
      );
    });

    it('returns null when the plans dir is unreadable', async () => {
      vi.spyOn(fs.promises, 'readdir').mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );
      expect(await resolveLatestSessionPlanFile(basePayload.subChatId)).toBeNull();
    });

    it('returns null when no .md files exist', async () => {
      mockPlansDir({ 'notes.txt': 1000 });
      expect(await resolveLatestSessionPlanFile(basePayload.subChatId)).toBeNull();
    });

    it('returns null for a path-unsafe subChatId without touching the filesystem', async () => {
      const readdir = vi.spyOn(fs.promises, 'readdir');
      expect(await resolveLatestSessionPlanFile('../escape')).toBeNull();
      expect(readdir).not.toHaveBeenCalled();
    });
  });
});

describe('validateToolPermission vendor plugin routing [sc-2068 -> 2026-09-03 uniform rule]', () => {
  const PLUGIN_TOOL = 'mcp__plugin_slack_slack__chat_post_message';

  beforeEach(async () => {
    const clientModule = await import('./client');
    vi.mocked(clientModule.sendPermissionRequest).mockClear();
    const { getProjectByPath } = await import('../db/repos/projects');
    // SAFETY: validateToolPermission reads only id/name/path off the project row;
    // the partial fixture holds exactly the consumed fields.
    vi.mocked(getProjectByPath).mockResolvedValue({
      id: 'project-1',
      name: 'Project One',
      path: '/proj',
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    // SAFETY: the seam consumes only decision/prompt; the fixture is the exact
    // ask-shape the dispatcher returns for a no-matching-rule residual.
    vi.mocked(checkPermission).mockResolvedValue({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
  });

  it('delegates a vendor plugin tool to the provider reviewer like any other MCP tool', async () => {
    const clientModule = await import('./client');

    const r = await validateToolPermission(
      PLUGIN_TOOL,
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );

    expect(r).toEqual({ allowed: null });
    expect(clientModule.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('delegates on a flow-driven turn too — no plugin-shaped deny survives', async () => {
    const clientModule = await import('./client');

    const r = await validateToolPermission(
      PLUGIN_TOOL,
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      true,
      true,
    );

    expect(r).toEqual({ allowed: null });
    expect(JSON.stringify(r)).not.toContain('one-time approval');
    expect(clientModule.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('flow turn with Auto OFF falls to the card and times out with the park steer, not a plugin message', async () => {
    const clientModule = await import('./client');
    vi.mocked(clientModule.sendPermissionRequest).mockImplementationOnce((payload) => {
      permissionBridge.lastResponseHandler?.({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        requestId: payload.requestId,
        approved: false,
        timedOut: true,
      });
    });

    const r = await validateToolPermission(
      PLUGIN_TOOL,
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      true,
      false,
    );

    expect(r).toMatchObject({ allowed: false });
    // SAFETY: the toMatchObject above pins allowed:false, the arm that always carries `message`.
    const message = (r as { message: string }).message;
    expect(message).toContain('did NOT deny');
    expect(message).toContain('frink_task_signal');
    expect(message).not.toContain('one-time approval');
  });

  it('Auto OFF still raises the card and persists the approved rule — the change is scoped to the defer seam', async () => {
    const clientModule = await import('./client');
    const { persistApprovedRule } = await import('../permissions/v2/persist-approved-rule');
    vi.mocked(persistApprovedRule).mockClear();
    vi.mocked(clientModule.sendPermissionRequest).mockImplementationOnce((payload) => {
      permissionBridge.lastResponseHandler?.({
        chatId: payload.chatId,
        subChatId: payload.subChatId,
        requestId: payload.requestId,
        approved: true,
        duration: 'always',
        scope: 'user',
        ruleString: PLUGIN_TOOL,
        ruleType: 'allow',
      });
    });

    const r = await validateToolPermission(
      PLUGIN_TOOL,
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      false,
    );

    expect(r).toEqual({ allowed: true });
    expect(clientModule.sendPermissionRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistApprovedRule).mock.calls[0]?.[0]).toMatchObject({
      promptResult: expect.objectContaining({ ruleString: PLUGIN_TOOL, scope: 'user' }),
    });
  });

  it('an exact rule minted under the old behaviour still resolves above the seam', async () => {
    const clientModule = await import('./client');
    // SAFETY: an allow decision carries no other field; this is the dispatcher's full allow shape.
    vi.mocked(checkPermission).mockResolvedValueOnce({ decision: 'allow' } as Awaited<
      ReturnType<typeof checkPermission>
    >);

    const r = await validateToolPermission(
      PLUGIN_TOOL,
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      true,
      false,
    );

    expect(r).toEqual({ allowed: true });
    expect(clientModule.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('an explicit DENY rule still beats Auto — a deny must never be laundered into a defer', async () => {
    // The seam sits BELOW the allow/deny return. If it were ever hoisted above it, an Auto-armed
    // turn would hand a tool the user explicitly denied to the provider reviewer instead.
    const clientModule = await import('./client');
    // SAFETY: a deny decision carries only decision + reason; this is that full shape.
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: PLUGIN_TOOL, tier: 'user' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const r = await validateToolPermission(
      PLUGIN_TOOL,
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );

    expect(r).toMatchObject({ allowed: false });
    expect(r).not.toEqual({ allowed: null });
    expect(clientModule.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('a tier-1c path deny still beats Auto — the last Bash hard-deny must not become a defer', async () => {
    // Syntax denies are gone, so the system-denied PATH check is the only tier-1c
    // deny a Bash call can still hit; the seam must stay below it.
    const clientModule = await import('./client');
    // SAFETY: a deny decision carries only decision + reason; this is that full shape.
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'safety:path', path: '/home/u/.ssh/id_rsa' },
    } as Awaited<ReturnType<typeof checkPermission>>);

    const r = await validateToolPermission(
      'Bash',
      { command: 'cat ~/.ssh/id_rsa' },
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );

    expect(r).toMatchObject({ allowed: false, message: expect.stringMatching(/id_rsa/) });
    expect(clientModule.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('still delegates non-vendor MCP residuals to the provider reviewer', async () => {
    const r = await validateToolPermission(
      'mcp__shortcut__stories-create',
      {},
      '/proj',
      'c1',
      's1',
      undefined,
      undefined,
      false,
      true,
    );
    expect(r).toEqual({ allowed: null });
  });
});
