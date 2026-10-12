import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileApiError } from './errors';
import { ChatBusyError, DuplicateMessageError } from '../../socket/execution/send-admission';
import { SUBAGENT_TEXT_PART_TYPE } from '../../../../shared/subagent-parts';
import {
  createPendingPermissionRequestBroker,
  listPendingPermissionRequests,
} from '../../socket/streaming/pending-permission/request';

const fixture = vi.hoisted(() => ({
  requireChat: vi.fn(),
  questions: vi.fn(),
  held: vi.fn(),
  resolve: vi.fn(),
  permissions: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  permissionResponse: vi.fn(),
  getDriving: vi.fn(),
  projectedPermissions: vi.fn(),
  history: vi.fn(),
  seed: vi.fn(),
  ready: vi.fn(),
  cancelRun: vi.fn(),
  attachments: vi.fn(),
  release: vi.fn(),
  create: vi.fn(),
  project: vi.fn(),
  deleteChat: vi.fn(),
  startExecution: vi.fn(),
  holds: vi.fn(),
}));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireChat: fixture.requireChat,
  requireExecutionReady: fixture.ready,
  mobileCallers: {
    tasks: { getDrivingTaskForSubChat: fixture.getDriving, startExecution: fixture.startExecution },
    chats: {
      getSubChatMessages: fixture.history,
      create: fixture.create,
      delete: fixture.deleteChat,
    },
    flows: { cancelRun: fixture.cancelRun },
  },
  record: (value: unknown) => (value && typeof value === 'object' ? value : {}),
  text: (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback),
}));
vi.mock('./questions', () => ({
  mobileQuestions: fixture.questions,
  mobilePermissions: fixture.projectedPermissions,
}));
vi.mock('../../claude/ask-user-question-approval', () => ({
  listPendingQuestionProjections: fixture.held,
  resolvePendingToolApproval: fixture.resolve,
}));
vi.mock('../../socket/client', () => ({
  sendMessage: fixture.send,
  sendStop: fixture.stop,
  sendPermissionResponse: fixture.permissionResponse,
}));
vi.mock('../../socket/streaming/pending-permission', () => ({
  listPendingPermissionRequests: fixture.permissions,
}));
vi.mock('../../socket/streaming/live-stream', () => ({
  getLiveStreamSeed: fixture.seed,
}));
vi.mock('../../socket/streaming/execution-registry', () => ({
  getActiveExecution: () => undefined,
}));
vi.mock('../../socket/claude-wake-hold', () => ({ readWakeHolds: fixture.holds }));
vi.mock('./attachments', () => ({ resolveMobileAttachments: fixture.attachments }));
vi.mock('../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../db/repos/projects', () => ({ getProjectById: fixture.project }));
import { mobileRequestSchema } from '../../../../shared/types/remote/mobile';
import {
  answerMobileQuestion,
  createMobileChat,
  deleteMobileChat,
  mergeMobileTranscript,
  readMobileChat,
  respondMobilePermission,
  sendMobileMessage,
  stopMobileChat,
  subChatBusy,
} from './chat';

const identity = { chatId: 'chat', subChatId: 'sub' };
const question = { question: 'Which branch?', header: 'Branch', options: [], multiSelect: false };
const answer = {
  type: 'answerQuestion' as const,
  ...identity,
  id: 'question',
  source: 'live' as const,
  requestId: 'request',
  answers: { 'Which branch?': 'main' },
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.requireChat.mockResolvedValue({
    chat: { id: 'chat', projectId: 'project', taskId: null, subChats: [{ id: 'sub' }] },
    subChat: { id: 'sub' },
  });
  fixture.held.mockReturnValue([{ ...identity, toolUseId: 'question', questions: [question] }]);
  fixture.questions.mockResolvedValue([]);
  fixture.resolve.mockReturnValue(true);
  fixture.permissions.mockReturnValue([]);
  fixture.projectedPermissions.mockReturnValue([{ requestId: 'permission', supported: true }]);
  fixture.send.mockResolvedValue(undefined);
  fixture.getDriving.mockResolvedValue({ task: null, run: null });
  fixture.history.mockResolvedValue({ messages: [], hasMore: false });
  fixture.seed.mockReturnValue({ streams: [], terminals: [] });
  fixture.holds.mockReturnValue(new Map());
  fixture.ready.mockReset();
  fixture.cancelRun.mockResolvedValue(undefined);
});

describe('mobile chat actions', () => {
  it('deletes an ordinary chat and leaves task and Flow chats to desktop', async () => {
    const request = { type: 'deleteChat' as const, chatId: 'chat' };
    await expect(deleteMobileChat(request)).resolves.toEqual({ ok: true });
    expect(fixture.deleteChat).toHaveBeenCalledWith({ id: 'chat' });

    fixture.deleteChat.mockClear();
    fixture.getDriving.mockResolvedValueOnce({ task: null, run: { id: 'run' } });
    await expect(deleteMobileChat(request)).rejects.toMatchObject({ status: 409 });
    fixture.requireChat.mockResolvedValueOnce({
      chat: { id: 'chat', projectId: 'project', taskId: 'task', subChats: [{ id: 'sub' }] },
      subChat: { id: 'sub' },
    });
    await expect(deleteMobileChat(request)).rejects.toMatchObject({ status: 409 });
    expect(fixture.deleteChat).not.toHaveBeenCalled();
  });

  it('starts an unnamed chat so the computer names it from the first message', async () => {
    const request = { type: 'createChat' as const, projectId: 'project' };
    expect(mobileRequestSchema.parse(request)).toEqual(request);
    fixture.project.mockResolvedValue({ id: 'project' });
    fixture.create.mockResolvedValue({ id: 'chat', subChats: [{ id: 'sub' }] });
    await expect(createMobileChat(request)).resolves.toEqual({ chatId: 'chat', subChatId: 'sub' });
    expect(fixture.create).toHaveBeenCalledWith(expect.objectContaining({ name: undefined }));
  });

  it('works in the project folder when asked, and in a worktree by default', async () => {
    fixture.project.mockResolvedValue({ id: 'project' });
    fixture.create.mockResolvedValue({ id: 'chat', subChats: [{ id: 'sub' }] });
    const local = mobileRequestSchema.parse({
      type: 'createChat',
      projectId: 'project',
      useWorktree: false,
    });
    await createMobileChat(local as Extract<typeof local, { type: 'createChat' }>);
    expect(fixture.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ useWorktree: false }),
    );
    await createMobileChat({ type: 'createChat', projectId: 'project' });
    expect(fixture.create).toHaveBeenLastCalledWith(expect.objectContaining({ useWorktree: true }));
  });

  it('starts a chat in the chosen mode, and in Agent by default', async () => {
    fixture.project.mockResolvedValue({ id: 'project' });
    fixture.create.mockResolvedValue({ id: 'chat', subChats: [{ id: 'sub' }] });
    const plan = mobileRequestSchema.parse({
      type: 'createChat',
      projectId: 'project',
      mode: 'plan',
    });
    await createMobileChat(plan as Extract<typeof plan, { type: 'createChat' }>);
    expect(fixture.create).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'plan' }));
    await createMobileChat({ type: 'createChat', projectId: 'project' });
    expect(fixture.create).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'agent' }));
    expect(
      mobileRequestSchema.safeParse({ type: 'createChat', projectId: 'project', mode: 'ask' })
        .success,
    ).toBe(false);
  });

  it('marks a conversation driven by a Flow run as a Flow step', async () => {
    fixture.seed.mockReturnValue({ streams: [], terminals: [] });
    const request = { type: 'chat' as const, id: 'chat', subChatId: 'sub' };
    await expect(readMobileChat(request)).resolves.toMatchObject({ kind: 'chat' });
    fixture.getDriving.mockResolvedValueOnce({ task: { id: 'task', flowRunId: 'run' }, run: null });
    await expect(readMobileChat(request)).resolves.toMatchObject({ kind: 'flow' });
    fixture.getDriving.mockResolvedValueOnce({ task: null, run: { id: 'run' } });
    await expect(readMobileChat(request)).resolves.toMatchObject({ kind: 'flow' });
  });

  it('shows a safe failure message only for the latest inactive response', async () => {
    const failure = {
      assistantMessageId: 'failed',
      status: 'error',
      error: 'Provider dump: secret-token',
    };
    fixture.seed.mockReturnValue({ streams: [], terminals: [failure] });
    const request = { type: 'chat' as const, id: 'chat', subChatId: 'sub' };
    await expect(readMobileChat(request)).resolves.toMatchObject({
      error: 'The response failed. Open Frink on your Mac to see why.',
    });
    for (const [status, activity] of [
      ['active', 'running'],
      ['settling', 'running'],
      ['held', 'background'],
    ]) {
      fixture.seed.mockReturnValue({ streams: [{ status, parts: [] }], terminals: [failure] });
      await expect(readMobileChat(request)).resolves.toMatchObject({ activity, error: null });
    }
    fixture.seed.mockReturnValue({
      streams: [],
      terminals: [failure, { assistantMessageId: 'newer', status: 'settled' }],
    });
    await expect(readMobileChat(request)).resolves.toMatchObject({ error: null });
  });

  it('uses server-held question content and rejects a question whose hold expired', async () => {
    fixture.resolve.mockReturnValue(false);
    await expect(answerMobileQuestion(answer)).rejects.toMatchObject({ status: 409 });
    expect(fixture.resolve).toHaveBeenCalledWith('question', {
      approved: true,
      updatedInput: { questions: [question], answers: answer.answers },
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('does not answer a hold from a different chat', async () => {
    fixture.held.mockReturnValue([
      { ...identity, chatId: 'other', toolUseId: 'question', questions: [question] },
    ]);
    await expect(answerMobileQuestion(answer)).rejects.toMatchObject({ status: 409 });
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it('keeps live questions and permissions held if desktop execution is unavailable', async () => {
    fixture.ready.mockImplementation(() => {
      throw new MobileApiError(409, 'Open Frink.');
    });
    await expect(answerMobileQuestion(answer)).rejects.toMatchObject({ status: 409 });
    expect(fixture.resolve).not.toHaveBeenCalled();
    fixture.permissions.mockReturnValue([{ ...identity, requestId: 'permission', type: 'bash' }]);
    const request = {
      type: 'respondPermission' as const,
      ...identity,
      requestId: 'permission',
      approved: true,
    };
    await expect(respondMobilePermission(request)).rejects.toMatchObject({ status: 409 });
    expect(fixture.permissionResponse).not.toHaveBeenCalled();
    await respondMobilePermission({ ...request, approved: false });
    expect(fixture.permissionResponse).toHaveBeenCalledOnce();
  });

  it('rejects stale parked tasks instead of sending a reply to the next agent', async () => {
    fixture.questions.mockResolvedValue([
      { ...identity, id: 'new-task', source: 'parked', questions: [question] },
    ]);
    await expect(answerMobileQuestion({ ...answer, source: 'parked' })).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('sends a parked answer through normal follow-up with exact driver identity', async () => {
    fixture.questions.mockResolvedValue([
      { ...identity, id: 'question', source: 'parked', questions: [question] },
    ]);
    await answerMobileQuestion({ ...answer, source: 'parked' });
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedFlowTaskId: 'question',
        projectId: 'project',
        userMessage: expect.objectContaining({
          id: 'request',
          parts: [{ type: 'text', text: 'Q: Which branch?\nA: main' }],
        }),
      }),
      expect.objectContaining({ rejectIfBusy: true }),
    );
  });

  it('validates chat membership before sending', async () => {
    fixture.requireChat.mockRejectedValue(new MobileApiError(404, 'Chat session not found.'));
    await expect(
      sendMobileMessage({ ...identity, requestId: 'request', text: 'hi' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('returns a conflict for a saved duplicate instead of a successful execution acknowledgement', async () => {
    fixture.send.mockRejectedValueOnce(new DuplicateMessageError());
    await expect(
      sendMobileMessage({ ...identity, requestId: 'request', text: 'hi' }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already saved') });
  });

  it('returns a safe conflict when executor admission detects a changed Flow step', async () => {
    fixture.send.mockRejectedValueOnce(
      Object.assign(new Error('internal task details'), { category: 'FLOW_RUN_ENDED' }),
    );
    await expect(
      sendMobileMessage({ ...identity, requestId: 'request', text: 'hi' }),
    ).rejects.toMatchObject({
      status: 409,
      message: 'This Flow step changed. Refresh the chat before replying.',
    });
  });

  it('rechecks the driving Flow after admission wait and rejects a taskless running interval', async () => {
    fixture.getDriving.mockResolvedValue({
      task: null,
      run: { id: 'flow-run', status: 'running' },
    });
    fixture.send.mockImplementation(async (_payload, options) => {
      await options.beforeSend();
    });
    await expect(
      sendMobileMessage({ ...identity, requestId: 'request', text: 'hello' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fixture.getDriving).toHaveBeenCalledWith({ subChatId: 'sub', fallbackTaskId: null });
  });

  it('refuses all new mobile execution before persistence when the desktop closes', async () => {
    fixture.getDriving.mockResolvedValue({
      task: { id: 'task', flowRunId: 'run', status: 'needs_attention' },
      run: { id: 'run', status: 'paused' },
    });
    fixture.ready.mockImplementation(() => {
      throw new MobileApiError(409, 'Open Frink on your computer to run a Flow.');
    });
    const persist = vi.fn();
    fixture.send.mockImplementation(async (_payload, options) => {
      await options.beforeSend();
      persist();
    });
    const request = { ...identity, requestId: 'request', text: 'continue' };
    await expect(sendMobileMessage(request)).rejects.toMatchObject({ status: 409 });
    expect(persist).not.toHaveBeenCalled();

    fixture.getDriving.mockResolvedValue({ task: null, run: null });
    await expect(sendMobileMessage(request)).rejects.toMatchObject({ status: 409 });
    expect(persist).not.toHaveBeenCalled();
    expect(fixture.ready).toHaveBeenCalledTimes(2);
  });

  it('starts a reviewed task on plan approval only once the send is admitted', async () => {
    fixture.getDriving.mockResolvedValue({ task: { id: 'task', status: 'plan_ready' }, run: null });
    const approval = {
      mode: 'agent' as const,
      approvedPlanContext: { planId: 'p', planText: 'x' },
    };
    const request = { ...identity, requestId: 'request', text: 'build it' };
    fixture.send.mockRejectedValueOnce(new ChatBusyError());
    await expect(sendMobileMessage(request, approval)).rejects.toMatchObject({ status: 409 });
    fixture.send.mockImplementation(async (_payload, options) => options.beforeSend());
    await sendMobileMessage(request);
    expect(fixture.startExecution).not.toHaveBeenCalled();
    await sendMobileMessage(request, approval);
    expect(fixture.startExecution).toHaveBeenCalledWith({ taskId: 'task' });
  });

  it('passes a lost-admission plan approval refusal through unwrapped, for the API to answer 409', async () => {
    fixture.getDriving.mockResolvedValue({ task: { id: 'task', status: 'plan_ready' }, run: null });
    const refusal = new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This Flow run lost its place in the run queue.',
    });
    fixture.startExecution.mockRejectedValueOnce(refusal);
    fixture.send.mockImplementation(async (_payload, options) => options.beforeSend());
    const request = { ...identity, requestId: 'request', text: 'build it' };
    await expect(
      sendMobileMessage(request, {
        mode: 'agent' as const,
        approvedPlanContext: { planId: 'p', planText: 'x' },
      }),
    ).rejects.toBe(refusal);
  });

  it.each([
    '',
    ' \n',
    '<!--FRINK_HIDDEN_WAKE-->',
    ' <!--FRINK_HIDDEN_WAKE-->\n<!--FRINK_HIDDEN_WAKE--> ',
  ])('rejects empty or marker-only input before dispatch: %j', async (message) => {
    await expect(
      sendMobileMessage({ ...identity, requestId: 'request', text: message }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('removes reserved wake markers while preserving visible message content', async () => {
    await sendMobileMessage({
      ...identity,
      requestId: 'request',
      text: '<!--FRINK_HIDDEN_WAKE-->Hello',
    });
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.objectContaining({ parts: [{ type: 'text', text: 'Hello' }] }),
      }),
      expect.anything(),
    );
  });

  it('rejects chat stop when a Flow is paused without an active response', async () => {
    fixture.getDriving.mockResolvedValue({ run: { id: 'paused-run' }, task: null });
    await expect(stopMobileChat({ type: 'stopChat', ...identity })).rejects.toMatchObject({
      status: 409,
    });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.cancelRun).not.toHaveBeenCalled();
  });

  it('stops an active Flow through its cancellation boundary and ordinary chat through the turn stop', async () => {
    const request = { type: 'stopChat' as const, ...identity };
    fixture.seed.mockReturnValue({ streams: [{ streamEpoch: 'flow-response' }], terminals: [] });
    fixture.getDriving.mockResolvedValue({ run: { id: 'run' }, task: null });
    await stopMobileChat(request);
    expect(fixture.cancelRun).toHaveBeenCalledWith({ runId: 'run' });
    expect(fixture.stop).not.toHaveBeenCalled();

    fixture.getDriving.mockResolvedValue({ run: null, task: null });
    fixture.seed.mockReturnValue({ streams: [{ streamEpoch: 'ordinary' }], terminals: [] });
    await stopMobileChat(request);
    expect(fixture.stop).toHaveBeenCalledWith(identity);
    expect(fixture.cancelRun).toHaveBeenCalledOnce();
  });

  it.each([null, { id: 'successor-run' }])(
    'does not stop a successor during the driving-run lookup: %j',
    async (run) => {
      fixture.seed.mockReturnValue({ streams: [{ streamEpoch: 'ordinary' }], terminals: [] });
      fixture.getDriving.mockImplementation(async () => {
        fixture.seed.mockReturnValue({ streams: [{ streamEpoch: 'new-flow' }], terminals: [] });
        return { run, task: null };
      });
      await expect(stopMobileChat({ type: 'stopChat', ...identity })).rejects.toMatchObject({
        status: 409,
      });
      expect(fixture.stop).not.toHaveBeenCalled();
      expect(fixture.cancelRun).not.toHaveBeenCalled();
    },
  );

  it('settles a permission synchronously before a concurrent responder can accept it', async () => {
    const broker = createPendingPermissionRequestBroker({
      getExecutionSignal: () => undefined,
      onResponse: (respond) => {
        fixture.permissionResponse.mockImplementation(respond);
      },
      sendDismiss: vi.fn(),
      sendRequest: vi.fn(),
    });
    fixture.permissions.mockImplementation(listPendingPermissionRequests);
    const pending = broker.request({
      ...identity,
      requestId: 'permission',
      type: 'bash',
      path: 'pwd',
      operation: 'bash',
    });
    const request = {
      type: 'respondPermission' as const,
      ...identity,
      requestId: 'permission',
      approved: true,
    };
    try {
      const results = await Promise.allSettled([
        respondMobilePermission(request),
        respondMobilePermission(request),
      ]);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
      await expect(pending).resolves.toMatchObject({ approved: true });
      expect(fixture.permissionResponse).toHaveBeenCalledOnce();
    } finally {
      broker.drain();
    }
  });

  it('omits system wake turns while keeping the surrounding transcript', () => {
    expect(
      mergeMobileTranscript(
        [
          {
            id: 'hidden',
            role: 'user',
            parts: [{ type: 'text', text: '<!--FRINK_HIDDEN_WAKE-->carry on' }],
          },
          { id: 'visible', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] },
        ],
        { streams: [], terminals: [] },
      ),
    ).toEqual([
      { id: 'visible', role: 'assistant', text: 'Done', parts: [{ type: 'text', text: 'Done' }] },
    ]);
  });

  it('rejects permissions with stale or mismatched identity and supports only one-time responses', async () => {
    const request = {
      type: 'respondPermission' as const,
      ...identity,
      requestId: 'permission',
      approved: true,
    };
    fixture.permissions.mockReturnValue([
      { ...identity, subChatId: 'other', requestId: 'permission' },
    ]);
    await expect(respondMobilePermission(request)).rejects.toMatchObject({ status: 409 });
    expect(fixture.permissionResponse).not.toHaveBeenCalled();
    fixture.permissions.mockReturnValue([{ ...identity, requestId: 'permission', type: 'bash' }]);
    await respondMobilePermission(request);
    expect(fixture.permissionResponse).toHaveBeenCalledWith({
      ...identity,
      requestId: 'permission',
      approved: true,
    });
  });

  it('replaces same-message live text rather than duplicating or concatenating snapshots', () => {
    const history = [{ id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Old' }] }];
    const seed = {
      streams: [
        {
          chatId: 'chat',
          subChatId: 'sub',
          streamEpoch: 'epoch',
          messageIndex: 1,
          textOpen: true,
          observerOwned: true,
          status: 'active' as const,
          assistantMessageId: 'a',
          parts: [{ type: 'text', text: 'Current' }],
        },
      ],
      terminals: [],
    };
    expect(mergeMobileTranscript(history, seed)).toEqual([
      { id: 'a', role: 'assistant', text: 'Current', parts: [{ type: 'text', text: 'Current' }] },
    ]);
  });

  it('preserves prose/tool ordering without exposing tool input, output or error payloads', () => {
    const messages = mergeMobileTranscript(
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [
            { type: 'text', text: '<!--TASK_BUBBLE:{"private":"metadata"}-->Checking' },
            {
              type: 'tool-Bash',
              toolCallId: 'call',
              state: 'output-available',
              input: { command: 'secret command' },
              output: 'secret output',
            },
            { type: SUBAGENT_TEXT_PART_TYPE, input: { text: 'Subagent findings' } },
            {
              type: 'tool-Read',
              toolCallId: 'read',
              state: 'output-error',
              errorText: 'secret error',
            },
            { type: 'text', text: 'Done' },
          ],
        },
      ],
      { streams: [], terminals: [] },
    );
    expect(messages).toEqual([
      {
        id: 'a',
        role: 'assistant',
        text: 'Checking\nSubagent findings\nDone',
        parts: [
          { type: 'text', text: 'Checking' },
          { type: 'tool', id: 'call', name: 'Bash', state: 'completed' },
          { type: 'text', text: 'Subagent findings' },
          { type: 'tool', id: 'read', name: 'Read', state: 'failed' },
          { type: 'text', text: 'Done' },
        ],
      },
    ]);
  });

  it('shows a plan as its markdown once, without its frontmatter or a prose copy', () => {
    const planText = '---\nname: retry\n---\n## Steps\n1. Retry failed webhooks';
    const messages = mergeMobileTranscript(
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [
            { type: 'text', text: planText },
            { type: 'tool-frink-plan', toolCallId: 'p1', input: { planId: 'p1', planText } },
            { type: 'tool-frink-plan', toolCallId: 'p2', input: { planId: 'p2', planText: ' ' } },
          ],
        },
      ],
      { streams: [], terminals: [] },
    );
    expect(messages[0].parts).toEqual([
      { type: 'plan', id: 'p1', text: '## Steps\n1. Retry failed webhooks' },
    ]);
  });

  it('offers the open plan for approval only while the conversation is idle', async () => {
    fixture.requireChat.mockResolvedValue({
      chat: { id: 'chat', projectId: 'project', taskId: null, subChats: [{ id: 'sub' }] },
      subChat: { id: 'sub', mode: 'plan' },
    });
    const plan = {
      type: 'tool-frink-plan',
      input: { planId: 'p1', status: 'awaiting_approval', planText: 'Do it' },
    };
    fixture.history.mockResolvedValue({
      messages: [{ id: 'a', role: 'assistant', parts: [plan] }],
      hasMore: false,
    });
    const request = { type: 'chat' as const, id: 'chat', subChatId: 'sub' };
    await expect(readMobileChat(request)).resolves.toMatchObject({ pendingPlanId: 'p1' });
    fixture.seed.mockReturnValue({ streams: [{ status: 'active', parts: [] }], terminals: [] });
    await expect(readMobileChat(request)).resolves.toMatchObject({ pendingPlanId: null });
  });

  it('shows a steer as the text the user sent, whatever state its marker is in', () => {
    const steer = { type: 'tool-Steer', toolName: 'Steer', input: { text: ' Use pnpm ' } };
    const messages = mergeMobileTranscript(
      [{ id: 'a', role: 'assistant', parts: [steer, { ...steer, input: {} }] }],
      { streams: [], terminals: [] },
    );
    expect(messages[0].parts).toEqual([{ type: 'steer', text: 'Use pnpm' }]);
  });

  it('uses each message owning stream when classifying unfinished tools', () => {
    const parts = [{ type: 'tool-Bash', toolCallId: 'call', state: 'input-available' }];
    const history = ['past', 'settled', 'failed', 'active', 'held'].map((id) => ({
      id,
      role: 'assistant',
      parts,
    }));
    const stream = {
      chatId: 'chat',
      subChatId: 'sub',
      streamEpoch: 'epoch',
      messageIndex: 1,
      textOpen: false,
      observerOwned: true,
      parts,
    };
    const messages = mergeMobileTranscript(history, {
      streams: [
        { ...stream, assistantMessageId: 'active', status: 'active' },
        { ...stream, assistantMessageId: 'held', status: 'held' },
      ],
      terminals: [
        { ...stream, assistantMessageId: 'settled', status: 'settled', durability: 'committed' },
        { ...stream, assistantMessageId: 'failed', status: 'error', durability: 'non-durable' },
      ],
    });
    expect(messages.map((message) => ({ id: message.id, parts: message.parts }))).toEqual([
      { id: 'past', parts: [{ type: 'tool', id: 'call', name: 'Bash', state: 'unknown' }] },
      { id: 'settled', parts: [{ type: 'tool', id: 'call', name: 'Bash', state: 'interrupted' }] },
      { id: 'failed', parts: [{ type: 'tool', id: 'call', name: 'Bash', state: 'interrupted' }] },
      { id: 'active', parts: [{ type: 'tool', id: 'call', name: 'Bash', state: 'running' }] },
      { id: 'held', parts: [{ type: 'tool', id: 'call', name: 'Bash', state: 'unknown' }] },
    ]);
  });

  it.each(['tool-Bash', 'tool-Read', 'tool-mcp__frink__example'])(
    'classifies structured negative results as failed without exposing the output: %s',
    (type) => {
      const messages = mergeMobileTranscript(
        [
          {
            id: 'a',
            role: 'assistant',
            parts: [
              {
                type,
                toolCallId: 'failed',
                state: 'output-available',
                output: { success: false, error: 'private error' },
              },
              { type, toolCallId: 'passed', state: 'output-available', output: { success: true } },
              {
                type,
                toolCallId: 'malformed',
                state: 'output-available',
                output: { success: 'false' },
              },
              { type, toolCallId: 'array', state: 'output-available', output: [false] },
              {
                type,
                toolCallId: 'explicit-error',
                state: 'output-error',
                output: { success: true },
              },
            ],
          },
        ],
        { streams: [], terminals: [] },
      );
      expect(
        messages[0].parts?.map((part) => (part.type === 'tool' ? part.state : part.type)),
      ).toEqual(['failed', 'completed', 'completed', 'completed', 'failed']);
      expect(JSON.stringify(messages)).not.toContain('private error');
    },
  );

  it('keeps display metadata out of prose when a marker spans adjacent text parts', () => {
    const messages = mergeMobileTranscript(
      [
        {
          id: 'a',
          role: 'assistant',
          parts: [
            { type: 'text', text: '<!--TRIGGER_BUBBLE:{"private":' },
            { type: 'text', text: '"metadata"}-->Visible content' },
          ],
        },
      ],
      { streams: [], terminals: [] },
    );
    expect(messages).toEqual([
      {
        id: 'a',
        role: 'assistant',
        text: 'Visible content',
        parts: [{ type: 'text', text: 'Visible content' }],
      },
    ]);
  });

  it('handles malformed parts and retained interruption metadata without inventing running tools', () => {
    const messages = mergeMobileTranscript(
      [
        null,
        1,
        { id: 1 },
        {
          id: 'a',
          role: 'assistant',
          metadata: { interruptedBy: 'app_quit' },
          parts: [
            null,
            1,
            [],
            { type: 'text', text: {} },
            { type: SUBAGENT_TEXT_PART_TYPE, input: null },
            { type: 'tool-' },
            { type: 'reasoning', text: 'Private reasoning' },
            { type: 'tool-Read', state: 'input-streaming' },
            { type: 'tool-Bash', state: 'unrecognized' },
          ],
        },
      ],
      { streams: [], terminals: [] },
    );
    expect(messages).toEqual([
      {
        id: 'a',
        role: 'assistant',
        text: '',
        parts: [
          { type: 'tool', id: 'a:7', name: 'Read', state: 'interrupted' },
          { type: 'tool', id: 'a:8', name: 'Bash', state: 'unknown' },
        ],
      },
    ]);
  });
});

describe('mobile attachments', () => {
  it('sends images as inline image parts and files as path mentions, like a desktop send', async () => {
    fixture.attachments.mockResolvedValue({
      imageParts: [{ type: 'file', mimeType: 'image/png', data: 'iVBOR' }],
      fileMentions: ['@[pasted:120:notes.pdf|/sessions/sub/pasted/abc-notes.pdf]'],
      release: fixture.release,
    });

    await sendMobileMessage({
      ...identity,
      requestId: 'request',
      text: 'look at these',
      attachments: ['img', 'doc'],
    });

    expect(fixture.attachments).toHaveBeenCalledWith(['img', 'doc'], identity);
    expect(fixture.send.mock.calls[0][0].userMessage.parts).toEqual([
      {
        type: 'text',
        text: '@[pasted:120:notes.pdf|/sessions/sub/pasted/abc-notes.pdf] look at these',
      },
      { type: 'file', mimeType: 'image/png', data: 'iVBOR' },
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('allows a message that is only attachments, but never an empty one', async () => {
    fixture.attachments.mockResolvedValue({
      imageParts: [{ type: 'file', mimeType: 'image/jpeg', data: '/9j/' }],
      fileMentions: [],
      release: fixture.release,
    });
    await sendMobileMessage({ ...identity, requestId: 'request', text: '', attachments: ['img'] });
    expect(fixture.send).toHaveBeenCalledOnce();

    await expect(
      sendMobileMessage({ ...identity, requestId: 'request-2', text: '  ' }),
    ).rejects.toBeInstanceOf(MobileApiError);
  });

  it('keeps uploads claimable when the send is refused, so the phone can retry', async () => {
    fixture.attachments.mockResolvedValue({
      imageParts: [],
      fileMentions: ['@[pasted:1:a.txt|/p/a.txt]'],
      release: fixture.release,
    });
    fixture.send.mockRejectedValueOnce(new DuplicateMessageError());

    await expect(
      sendMobileMessage({ ...identity, requestId: 'request', text: 'hi', attachments: ['doc'] }),
    ).rejects.toBeInstanceOf(MobileApiError);
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it('shows attachments on the phone as chips, never raw tokens or base64', () => {
    const history = [
      {
        id: 'user-1',
        role: 'user',
        parts: [
          { type: 'text', text: '@[pasted:120:notes.pdf|/p/abc-notes.pdf] look at these' },
          { type: 'file', mimeType: 'image/png', data: 'iVBOR' },
        ],
      },
    ];

    expect(mergeMobileTranscript(history, { streams: [], terminals: [] } as never)).toEqual([
      {
        id: 'user-1',
        role: 'user',
        text: 'look at these',
        parts: [
          { type: 'attachment', kind: 'file', name: 'notes.pdf' },
          { type: 'text', text: 'look at these' },
          { type: 'attachment', kind: 'image', name: 'Image' },
        ],
      },
    ]);
  });
});

describe('subChatBusy', () => {
  const hold = (ended: boolean) => new Map([['sub', { pump: { isEnded: () => ended } }]]);
  it.each([
    ['a live response', [{ status: 'active' }], new Map(), true],
    ['a background wait', [{ status: 'held' }], hold(false), true],
    ['a wait that is over while its CLI still writes', [], hold(false), true],
    ['a hold whose pump has ended', [], hold(true), false],
    ['a finished chat', [], new Map(), false],
  ])('reads %s', (_case, streams, holds, busy) => {
    fixture.seed.mockReturnValue({ streams, terminals: [] });
    fixture.holds.mockReturnValue(holds);
    expect(subChatBusy('sub')).toBe(busy);
  });
});
