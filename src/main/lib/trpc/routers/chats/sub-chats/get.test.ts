/** Phase 1 local-first migration: sub-chat reads come from local SQLite. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findApprovablePlan, type PlanMessageLike } from '../../../../../../shared/types/plan';
import { buildFrinkPlanChunks } from '../../../../agent-runner/plan-document';
import { makeLocalChat, makeLocalSubChat } from '../test-factories';

const getSubChatByIdLocalMock = vi.fn();
const getChatByIdLocalMock = vi.fn();

// Mutable project row(s) the mocked `db.select()...limit()` resolves to (per-test).
const dbState = vi.hoisted(() => ({ projectRows: [] as unknown[] }));

vi.mock('../../../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(dbState.projectRows) }) }),
    }),
  }),
}));
vi.mock('../../../../db/repos/sub-chats', () => ({
  getSubChatById: getSubChatByIdLocalMock,
}));
vi.mock('../../../../db/repos/chats', () => ({
  getChatById: getChatByIdLocalMock,
}));

describe('subChatGetRouter (local-first)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    dbState.projectRows = [];
  });

  it('getSubChatMessages returns empty when sub-chat is missing', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(null);
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChatMessages({ subChatId: 'unknown', limit: 20 });
    expect(result).toEqual({
      messages: [],
      hasMore: false,
      sessionId: null,
    });
  });

  it('getSubChatMessages returns hydrated messages + sessionId', async () => {
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', sessionId: 'sess-1' }),
      messages: [{ id: 'm1', role: 'user', parts: [] }],
    });
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });
    expect(result.sessionId).toBe('sess-1');
    expect(result.messages).toHaveLength(1);
  });

  // sc-3829: via createCaller so caseConvertOutput would run; the renderer reads input.file_path.
  it('getSubChatMessages keeps persisted tool-part keys snake_case', async () => {
    const assistant = {
      id: 'a1',
      role: 'assistant',
      metadata: { sdkMessageUuid: 'sdk-1' },
      parts: [
        {
          type: 'tool-Edit',
          state: 'output-available',
          input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y\nz' },
        },
        {
          type: 'tool-Write',
          state: 'output-available',
          input: { file_path: '/repo/src/b.ts', content: 'new' },
        },
        { type: 'tool-Task', state: 'output-available', output: { duration_ms: 1200 } },
      ],
    };
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', sessionId: 'sess-1' }),
      messages: [assistant],
    });
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });

    expect(result).toEqual({ messages: [assistant], hasMore: false, sessionId: 'sess-1' });
    const [edit] = (result.messages[0] as typeof assistant).parts;
    expect(edit.input).not.toHaveProperty('filePath');
  });

  // Inputs Frink does not shape: MCP arguments pass through verbatim (kebab keys too — the
  // plugins.list instance), and Codex's fileChange Edit carries `changes`, not `file_path`.
  it('getSubChatMessages keeps MCP and Codex tool inputs verbatim', async () => {
    const assistant = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-mcp__docs__search',
          state: 'output-available',
          input: { 'max-results': 5, page_token: 'p2' },
          output: { next_page_token: null },
        },
        {
          type: 'tool-Edit',
          state: 'output-available',
          input: { changes: [{ path: '/repo/a.ts', kind: { type: 'update', move_path: null } }] },
        },
      ],
    };
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1' }),
      messages: [assistant],
    });
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });

    const result = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });

    expect(result.messages).toEqual([assistant]);
  });

  // Mobile approval reads planId/planText from this procedure (mobile/domain/plan.ts); its own
  // tests mock the history, so this pins the real producer → procedure → finder wiring.
  it('a persisted frink-plan part is still approvable after the raw read', async () => {
    const [inputChunk, outputChunk] = buildFrinkPlanChunks(
      's1',
      '## Retry webhooks',
      null,
    ) as unknown as [{ toolCallId: string; input: Record<string, unknown> }, { output: unknown }];
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1' }),
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-frink-plan',
              toolCallId: inputChunk.toolCallId,
              state: 'output-available',
              input: inputChunk.input,
              output: outputChunk.output,
            },
          ],
        },
      ],
    });
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });

    const { messages } = await caller.getSubChatMessages({ subChatId: 's1', limit: 20 });

    expect(findApprovablePlan(messages as PlanMessageLike[], true)).toEqual({
      planId: inputChunk.toolCallId,
      planText: '## Retry webhooks',
    });
  });

  it('getSubChat returns sub-chat + parent chat', async () => {
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', chatId: 'c1' }),
      messages: [{ id: 'm1' }],
    });
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', name: 'Parent' }));

    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChat({ id: 's1' });

    expect(result?.id).toBe('s1');
    expect(result?.messages).toBe(JSON.stringify([{ id: 'm1' }]));
    expect(result).not.toHaveProperty('messagesRevision');
    expect(result?.chat?.id).toBe('c1');
  });

  it('getSubChat returns null when sub-chat is missing', async () => {
    getSubChatByIdLocalMock.mockResolvedValue(null);
    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    expect(await caller.getSubChat({ id: 'unknown' })).toBeNull();
  });

  // The chat's project must carry git metadata so the chat icon renders the project avatar.
  it('getSubChat carries the project git metadata', async () => {
    getSubChatByIdLocalMock.mockResolvedValue({
      ...makeLocalSubChat({ id: 's1', chatId: 'c1' }),
      messages: [{ id: 'm1' }],
    });
    getChatByIdLocalMock.mockResolvedValue(makeLocalChat({ id: 'c1', projectId: 'p-1' }));
    dbState.projectRows = [
      {
        id: 'p-1',
        name: 'Frink',
        path: '/repos/frink',
        gitRemoteUrl: 'https://github.com/acme/frink',
        gitProvider: 'github',
        gitOwner: 'acme',
        gitRepo: 'frink',
      },
    ];

    const { subChatGetRouter } = await import('./get');
    const caller = subChatGetRouter.createCaller({ getWindow: () => null });
    const result = await caller.getSubChat({ id: 's1' });

    expect(result?.chat?.project).toEqual({
      id: 'p-1',
      name: 'Frink',
      path: '/repos/frink',
      gitRemoteUrl: 'https://github.com/acme/frink',
      gitProvider: 'github',
      gitOwner: 'acme',
      gitRepo: 'frink',
    });
  });
});
