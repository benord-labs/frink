import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileApiError } from './errors';
import { DuplicateMessageError } from '../../socket/execution/send-admission';
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
}));
vi.mock('./context', async () => ({
  MobileApiError: (await import('./errors')).MobileApiError,
  requireChat: fixture.requireChat,
  requireExecutionReady: fixture.ready,
  mobileCallers: {
    tasks: { getDrivingTaskForSubChat: fixture.getDriving },
    chats: { getSubChatMessages: fixture.history },
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
vi.mock('../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../db/repos/projects', () => ({ getProjectById: vi.fn() }));
import {
  answerMobileQuestion,
  mergeMobileTranscript,
  readMobileChat,
  respondMobilePermission,
  sendMobileMessage,
  stopMobileChat,
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
  fixture.ready.mockReset();
  fixture.cancelRun.mockResolvedValue(undefined);
});

describe('mobile chat actions', () => {
  it('shows a safe failure message only for the latest inactive response', async () => {
    const failure = {
      assistantMessageId: 'failed',
      status: 'error',
      error: 'Provider dump: secret-token',
    };
    fixture.seed.mockReturnValue({ streams: [], terminals: [failure] });
    const request = { type: 'chat' as const, id: 'chat', subChatId: 'sub' };
    await expect(readMobileChat(request)).resolves.toMatchObject({
      error: 'The response failed. Check Frink on your computer for details.',
    });
    for (const status of ['active', 'held']) {
      fixture.seed.mockReturnValue({ streams: [{ status, parts: [] }], terminals: [failure] });
      await expect(readMobileChat(request)).resolves.toMatchObject({ active: true, error: null });
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
    ).toEqual([{ id: 'visible', role: 'assistant', text: 'Done' }]);
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
      { id: 'a', role: 'assistant', text: 'Current' },
    ]);
  });
});
