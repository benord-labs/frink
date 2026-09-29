import os from 'node:os';
import { expect, it, vi } from 'vitest';
import type { UIMessageChunk } from '../../claude/types';
import { registerCustomNodePermissionTests } from './executor-custom-node-permissions';

/** Registers Codex permission cases against the parent executor test harness. */

const BASH_DENY_MESSAGE_RE = /user.*Bash\(rm:\*\)/;
const DELETE_MESSAGE_RE = /Delete/;

type ExecutorModule = typeof import('../executor');
type AgentRunnerModule = typeof import('../../agent-runner');
type CredentialModule = typeof import('../../credentials');
type ChatRepoModule = typeof import('../../db/repos/chats');
type SocketClientModule = typeof import('../client');
type ToolValidationModule = typeof import('../../permissions/tool-validation');
type TaskParkingModule = typeof import('../../db/repos/task-parking');
type TasksRepoModule = typeof import('../../db/repos/tasks');

type PermissionResponseHandler = (response: {
  chatId: string;
  subChatId: string;
  requestId: string;
  approved: boolean;
  duration?: 'once' | 'always' | 'time-bound';
  hours?: number;
  timedOut?: boolean;
}) => void;

export type ExecutorPermissionHarness = {
  handleRemoteExecute: ExecutorModule['handleRemoteExecute'];
  runCodexAgent: AgentRunnerModule['runCodexAgent'];
  getDefaultClaudeCodeToken: CredentialModule['getDefaultClaudeCodeToken'];
  getChatWithProjectAccount: ChatRepoModule['getChatWithProjectAccount'];
  getTaskById: TasksRepoModule['getTaskById'];
  socketClient: Pick<SocketClientModule, 'sendPermissionRequest' | 'sendExecuteCompleteDirect'>;
  toolValidation: Pick<ToolValidationModule, 'resolvePermissionProjectPath'>;
  parkFlowTaskOnClaudeInterruption: TaskParkingModule['parkFlowTaskOnClaudeInterruption'];
  clientPermissionBridge: { lastResponseHandler: PermissionResponseHandler | null };
  validateToolPermission: ExecutorModule['validateToolPermission'];
  basePayload: Omit<Parameters<ExecutorModule['handleRemoteExecute']>[0], 'message'>;
  codexCredential: NonNullable<Awaited<ReturnType<CredentialModule['getDefaultClaudeCodeToken']>>>;
  project: { path: string };
};

export function registerExecutorPermissionTests(harness: ExecutorPermissionHarness): void {
  registerCustomNodePermissionTests(harness);
  registerCodexBasicPermissionTests(harness);
  registerCodexBoundaryPermissionTests(harness);
  registerCodexPathAndLifecycleTests(harness);
}

function registerCodexBasicPermissionTests({
  handleRemoteExecute,
  runCodexAgent,
  getDefaultClaudeCodeToken,
  socketClient,
  clientPermissionBridge,
  basePayload,
  codexCredential,
}: ExecutorPermissionHarness): void {
  it('still selects Codex auto-review — arming at plan approval is Claude-only, eligibility is not', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-auto' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex turn with Auto on',
      settings: { autoReviewTools: true, codexFastMode: true, model: 'codex-gpt-5.6-sol-high' },
    });

    expect(vi.mocked(runCodexAgent).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ autoReview: true, serviceTier: 'priority' }),
    );
  });

  it('includes the channel-scoped Flow MCP in Codex canonical replacement config', async () => {
    const { getMultiProjectContext } = await import('../../multi-project-prompt');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(getMultiProjectContext).mockResolvedValue({
      promptPrefix: '',
      dynamicChatMcpUrl: 'http://127.0.0.1:4312/mcp',
    });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield { type: 'finish' };
    });

    await handleRemoteExecute({ ...basePayload, message: 'create a Flow' });

    const codexCall = vi.mocked(runCodexAgent).mock.calls[0]?.[0];
    const dynamicServer = JSON.stringify(codexCall?.canonicalMcpServers?.frink_dynamic_chat);
    expect(codexCall?.configArgs).toBeUndefined();
    expect(dynamicServer).toContain('http://127.0.0.1:4312/mcp');
    expect(dynamicServer).toContain('channel=');
    expect(dynamicServer).toContain('toolset=nosignal');
    expect(dynamicServer).not.toContain('executionId');
  });

  it('routes a Codex host permission ask through Frink when Auto is off', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    // SAFETY: the seam consumes only decision/prompt; this is the dispatcher's ask shape.
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: true });
    });
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({
        toolName: 'Bash',
        input: { command: 'npm test' },
      });
      // SAFETY: a bare finish chunk needs no metadata; the runner reads only `type` here.
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex manual permission' });

    expect(approval).toEqual({ allowed: true });
    expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
  });

  it('hands a vendor plugin MCP call to Codex Guardian under Auto instead of carding it', async () => {
    // Codex reaches the same defer seam through checkApproval, so the uniform routing must hold
    // for a provider whose reviewer is Guardian rather than Claude's classifier.
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({
        toolName: 'mcp__plugin_slack_slack__chat_post_message',
        input: {},
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex plugin tool under Auto',
      settings: { autoReviewTools: true, model: 'codex-gpt-5.6-sol-high' },
    });

    expect(approval).toEqual({ allowed: null });
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('does not trust a user-configured Codex MCP that collides with the frink server name', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: false });
    });
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({
        toolName: 'mcp__frink__read_something',
        input: {},
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex same-name user MCP' });

    expect(vi.mocked(checkPermission).mock.calls[0]?.[0]).toMatchObject({
      tool: 'mcp__frink__read_something',
      trustedFrinkOwnedMcp: false,
    });
    expect(approval).toEqual({ allowed: false, message: expect.any(String) });
    expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
  });
}

function registerCodexBoundaryPermissionTests({
  handleRemoteExecute,
  runCodexAgent,
  getDefaultClaudeCodeToken,
  getChatWithProjectAccount,
  getTaskById,
  socketClient,
  clientPermissionBridge,
  basePayload,
  codexCredential,
}: ExecutorPermissionHarness): void {
  it('enables the native Stop guard for a live task-linked Codex turn', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    // SAFETY: this executor path reads only chat.taskId and account from the repository result.
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { taskId: 'codex-task' },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    // SAFETY: task signal arming reads only id, status, and result from this repository result.
    vi.mocked(getTaskById).mockResolvedValue({
      id: 'codex-task',
      status: 'running',
      result: {},
    } as Awaited<ReturnType<typeof getTaskById>>);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'finish the Codex task' });

    expect(vi.mocked(runCodexAgent).mock.calls[0]?.[0].taskSignalEnabled).toBe(true);
  });

  it('uses exact MCP provenance when a server name contains the Frink prefix', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: false });
    });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      await options.checkApproval({
        toolName: 'mcp__frink_dynamic_chat__evil__x',
        input: {},
        mcp: { server: 'frink_dynamic_chat__evil', tool: 'x' },
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex prefixed user MCP' });

    expect(vi.mocked(checkPermission).mock.calls[0]?.[0]).toMatchObject({
      tool: 'mcp__frink_dynamic_chat__evil__x',
      trustedFrinkOwnedMcp: false,
      mcpIdentity: { server: 'frink_dynamic_chat__evil', tool: 'x' },
    });
    expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
  });

  it('does not trust frink_dynamic_chat when that Codex process received no Frink injection', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { worktreePath: os.homedir() },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    vi.mocked(socketClient.sendPermissionRequest).mockImplementationOnce((payload) => {
      clientPermissionBridge.lastResponseHandler?.({ ...payload, approved: false });
    });
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      await options.checkApproval({
        toolName: 'mcp__frink_dynamic_chat__searchProjects',
        input: {},
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex uninjected same-name MCP' });

    expect(vi.mocked(checkPermission).mock.calls[0]?.[0]).toMatchObject({
      tool: 'mcp__frink_dynamic_chat__searchProjects',
      trustedFrinkOwnedMcp: false,
    });
    expect(vi.mocked(runCodexAgent).mock.calls[0]?.[0].configArgs).toBeUndefined();
    expect(socketClient.sendPermissionRequest).toHaveBeenCalledOnce();
  });

  it('defers only the ask residual to Codex Auto review', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule' },
    } as Awaited<ReturnType<typeof checkPermission>>);
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({
        toolName: 'Bash',
        input: { command: 'npm test' },
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex auto residual',
      settings: { autoReviewTools: true },
    });

    expect(approval).toEqual({ allowed: null });
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });

  it('preserves an explicit Frink deny when Codex Auto is on', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Bash(rm:*)', tier: 'user' },
    });
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex explicit deny',
      settings: { autoReviewTools: true },
    });

    expect(approval).toEqual({
      allowed: false,
      message: expect.stringMatching(BASH_DENY_MESSAGE_RE),
    });
    expect(socketClient.sendPermissionRequest).not.toHaveBeenCalled();
  });
}

function registerCodexPathAndLifecycleTests({
  handleRemoteExecute,
  runCodexAgent,
  getDefaultClaudeCodeToken,
  getChatWithProjectAccount,
  toolValidation,
  parkFlowTaskOnClaudeInterruption,
  socketClient,
  basePayload,
  codexCredential,
  project,
}: ExecutorPermissionHarness): void {
  it('persists every Codex metadata chunk, so token usage survives a reload', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield { type: 'message-metadata', messageMetadata: { sessionId: 'sess-codex-usage' } };
      yield {
        type: 'message-metadata',
        messageMetadata: { totalTokens: 20, contextTokens: 7, contextWindow: 9 },
      };
      yield { type: 'finish', messageMetadata: { sessionId: 'sess-codex-usage' } };
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex turn that reports usage' });

    await vi.waitFor(() =>
      expect(socketClient.sendExecuteCompleteDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-codex-usage',
          metadata: expect.objectContaining({ contextTokens: 7, contextWindow: 9 }),
        }),
      ),
    );
  });

  it('canonicalizes Codex host file paths from a worktree before permission matching', async () => {
    const { checkPermission } = await import('../../permissions/v2/check');
    const worktree = '/tmp/wt/codex-permissions';
    const worktreeFile = `${worktree}/src/a.ts`;
    const canonicalFile = `${project.path}/src/a.ts`;
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(getChatWithProjectAccount).mockResolvedValue({
      chat: { worktreePath: worktree },
      account: null,
    } as Awaited<ReturnType<typeof getChatWithProjectAccount>>);
    vi.spyOn(toolValidation, 'resolvePermissionProjectPath').mockImplementation((candidate) =>
      candidate === worktree ? project.path : candidate,
    );
    vi.mocked(checkPermission).mockResolvedValueOnce({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: `Delete(${canonicalFile})`, tier: 'user' },
    });
    let approval: unknown;
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* (options) {
      approval = await options.checkApproval({
        toolName: 'Delete',
        input: { file_path: worktreeFile },
      });
      yield { type: 'finish' } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      message: 'codex worktree delete',
      settings: { autoReviewTools: true },
    });

    expect(vi.mocked(checkPermission).mock.calls[0]?.[0]).toMatchObject({
      tool: 'Delete',
      input: { file_path: canonicalFile },
      projectPath: project.path,
    });
    expect(approval).toEqual({ allowed: false, message: expect.stringMatching(DELETE_MESSAGE_RE) });
  });

  it('selects Codex auto-review on a PLAN turn too — Codex has no planning-phase carve-out', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-plan-auto' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({
      ...basePayload,
      mode: 'plan' as const,
      message: 'codex plan turn with Auto on',
      settings: { autoReviewTools: true },
    });

    expect(vi.mocked(runCodexAgent).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ autoReview: true }),
    );
  });

  it('parks a Codex turn that ended on an error chunk', async () => {
    vi.mocked(getDefaultClaudeCodeToken).mockResolvedValueOnce(codexCredential);
    vi.mocked(runCodexAgent).mockImplementationOnce(async function* () {
      yield { type: 'error', errorText: 'API Error: 401 unauthorized' } as UIMessageChunk;
      yield {
        type: 'finish',
        messageMetadata: { sessionId: 'sess-codex-401' },
      } as UIMessageChunk;
    });

    await handleRemoteExecute({ ...basePayload, message: 'codex turn with a revoked key' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(parkFlowTaskOnClaudeInterruption)).toHaveBeenCalledWith(
      basePayload.subChatId,
      { kind: 'api-error', status: 401, message: 'API Error: 401 unauthorized' },
    );
  });
}
