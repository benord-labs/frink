import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingToolApprovals } from '../../claude/ask-user-question-approval';
import { createPendingPermissionRequestBroker } from '../../socket/streaming/pending-permission/request';
import type { Context } from '../index';
import { socketRouter } from './socket';

const { sendMessageMock, listPendingMoveChatRequestsMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  listPendingMoveChatRequestsMock: vi.fn((): unknown[] => []),
}));

/** Minimal stub — `socket.ts` only imports these symbols from `../../socket`. */
vi.mock('../../socket', () => ({
  sendMessage: sendMessageMock,
  sendStop: vi.fn(),
}));

// Spread the real module: `socket.ts` also reaches this barrel for the real permission-request
// list (exercised below through the real broker), and a bare object mock would strip that export.
// Only the move-chat side is stubbed — its real implementation is Electron-coupled.
vi.mock('../../socket/streaming/pending-permission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../socket/streaming/pending-permission')>()),
  listPendingMoveChatRequests: listPendingMoveChatRequestsMock,
}));

function minimalSendMessageInput() {
  return {
    chatId: 'chat-1',
    subChatId: 'sub-1',
    projectId: 'proj-1',
    userMessage: {
      id: 'um-1',
      role: 'user' as const,
      parts: [{ type: 'text', text: 'hi' }],
    },
    mode: 'agent' as const,
  };
}

describe('socketRouter renderer recovery projections', () => {
  const permissionBroker = createPendingPermissionRequestBroker({
    getExecutionSignal: () => undefined,
    onResponse: vi.fn(),
    sendDismiss: vi.fn(),
    sendRequest: vi.fn(),
  });

  afterEach(() => {
    permissionBroker.drain();
    pendingToolApprovals.clear();
    listPendingMoveChatRequestsMock.mockReset().mockReturnValue([]);
  });

  it('returns only the pending permission UI projection', async () => {
    permissionBroker.request({
      chatId: 'chat-1',
      subChatId: 'sub-1',
      requestId: 'permission-1',
      type: 'bash',
      path: 'bun test',
      operation: 'bash',
      reason: 'Approval required',
    });
    const caller = socketRouter.createCaller({ getWindow: () => null } satisfies Context);

    await expect(caller.listPendingPermissionRequests()).resolves.toEqual([
      {
        chatId: 'chat-1',
        subChatId: 'sub-1',
        requestId: 'permission-1',
        type: 'bash',
        path: 'bun test',
        operation: 'bash',
        reason: 'Approval required',
      },
    ]);
  });

  it('returns a pending move-chat wait through the same recovery projection', async () => {
    listPendingMoveChatRequestsMock.mockReturnValue([
      {
        requestId: 'move-1',
        chatId: 'chat-1',
        subChatId: 'sub-1',
        operation: 'move_chat',
        projectId: 'project-2',
        projectName: 'Project two',
        targetChatId: 'chat-1',
        targetSubChatId: 'sub-1',
        projectPath: '/project-two',
        requestedWorktreePath: null,
        targetBranch: 'main',
      },
    ]);
    const caller = socketRouter.createCaller({ getWindow: () => null } satisfies Context);

    await expect(caller.listPendingPermissionRequests()).resolves.toEqual([
      expect.objectContaining({
        requestId: 'move-1',
        operation: 'move_chat',
        projectName: 'Project two',
      }),
    ]);
  });

  it('augments the live seed with only this sub-chat pending questions', async () => {
    pendingToolApprovals.set('tool-1', {
      subChatId: 'sub-1',
      chatId: 'chat-1',
      questions: [
        {
          question: 'Continue?',
          header: 'Direction',
          multiSelect: false,
          options: [{ label: 'Yes', description: 'Continue the run' }],
        },
      ],
      resolve: () => true,
    });
    pendingToolApprovals.set('tool-other', {
      subChatId: 'sub-other',
      chatId: 'chat-other',
      questions: [
        {
          question: 'Other?',
          header: 'Other',
          multiSelect: false,
          options: [{ label: 'No', description: '' }],
        },
      ],
      resolve: () => true,
    });
    const caller = socketRouter.createCaller({ getWindow: () => null } satisfies Context);

    await expect(caller.listPendingQuestionSubChatIds()).resolves.toEqual(['sub-1', 'sub-other']);

    await expect(caller.getLiveStreamSeed({ subChatId: 'sub-1' })).resolves.toMatchObject({
      pendingQuestions: [
        {
          chatId: 'chat-1',
          subChatId: 'sub-1',
          toolUseId: 'tool-1',
          questions: [{ question: 'Continue?' }],
        },
      ],
    });
  });
});

describe('socketRouter.sendMessage sourceWebContentsId', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
  });

  // Exercises the REAL zod input parse: an unlisted key would be stripped in silence (the
  // answeredQuestions-reached-DB-as-{} class), shipping an inert mode binding.
  it('dispatchTaskId survives the input schema and reaches sendMessage', async () => {
    const caller = socketRouter.createCaller({
      getWindow: () => null,
      senderWebContentsId: 7,
    } satisfies Context);

    await caller.sendMessage({ ...minimalSendMessageInput(), dispatchTaskId: 'task-d1' });

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toMatchObject({ dispatchTaskId: 'task-d1' });
  });

  it('settings.ultra survives the input schema and reaches sendMessage', async () => {
    const caller = socketRouter.createCaller({ getWindow: () => null } satisfies Context);

    await caller.sendMessage({
      ...minimalSendMessageInput(),
      settings: { effort: 'xhigh', ultra: true },
    });

    expect(sendMessageMock.mock.calls[0]?.[0]).toMatchObject({
      settings: { effort: 'xhigh', ultra: true },
    });
  });

  it('forwards sourceWebContentsId when ctx.senderWebContentsId is an integer', async () => {
    const caller = socketRouter.createCaller({
      getWindow: () => null,
      senderWebContentsId: 7,
    } satisfies Context);

    await caller.sendMessage(minimalSendMessageInput());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const firstPayload = sendMessageMock.mock.calls[0]?.[0];
    expect(firstPayload).toBeDefined();
    expect(firstPayload).toMatchObject({
      ...minimalSendMessageInput(),
      sourceWebContentsId: 7,
    });
  });

  it('omits sourceWebContentsId when ctx.senderWebContentsId is not an integer (fractional)', async () => {
    const caller = socketRouter.createCaller({
      getWindow: () => null,
      senderWebContentsId: 7.5,
    } satisfies Context);

    await caller.sendMessage(minimalSendMessageInput());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const payload = sendMessageMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.sourceWebContentsId).toBeUndefined();
    expect(payload).toMatchObject(minimalSendMessageInput());
  });

  it('omits sourceWebContentsId when ctx.senderWebContentsId is undefined', async () => {
    const caller = socketRouter.createCaller({
      getWindow: () => null,
    } satisfies Context);

    await caller.sendMessage(minimalSendMessageInput());

    const payload = sendMessageMock.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('sourceWebContentsId');
  });
});

/**
 * `messageSchema.metadata` is a STRICT zod object, so any key it does not list is dropped in
 * silence. `answeredQuestions` — the display provenance that renders a picked answer as a card
 * rather than a bare bubble — was one of them, and reached the database as `{}`.
 */
describe('socketRouter.sendMessage answer provenance', () => {
  const answered = [{ label: 'Direction', answer: 'Split it' }];

  beforeEach(() => {
    sendMessageMock.mockReset();
  });

  const send = async (metadata: Record<string, unknown>) => {
    const caller = socketRouter.createCaller({
      getWindow: () => null,
      senderWebContentsId: 1,
    } satisfies Context);
    const input = minimalSendMessageInput();
    await caller.sendMessage({ ...input, userMessage: { ...input.userMessage, metadata } });
    return sendMessageMock.mock.calls[0]?.[0]?.userMessage?.metadata;
  };

  it('carries answeredQuestions through to the socket payload', async () => {
    expect(await send({ answeredQuestions: answered })).toEqual({ answeredQuestions: answered });
  });

  it('still drops a mis-shaped payload rather than persisting a card that cannot render', async () => {
    await expect(send({ answeredQuestions: [{ label: 1, answer: 'x' }] })).rejects.toThrow();
  });
});
