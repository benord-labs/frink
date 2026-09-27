import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ permissions: vi.fn(), moves: vi.fn() }));
vi.mock('../../socket/streaming/pending-permission', () => ({
  listPendingPermissionRequests: fixture.permissions,
  listPendingMoveChatRequests: fixture.moves,
}));
vi.mock('../../claude/ask-user-question-approval', () => ({
  listPendingQuestionProjections: vi.fn(),
}));
vi.mock('../../trpc/routers/frink-task-signal', () => ({ agentUserQuestionsSchema: {} }));
vi.mock('./context', () => ({ mobileCallers: {}, record: vi.fn(), text: vi.fn() }));
import { mobilePermissions } from './questions';

beforeEach(() => {
  fixture.moves.mockReturnValue([]);
});
describe('mobile permission review', () => {
  it('includes the exact operation even when a generic reason is present', () => {
    fixture.permissions.mockReturnValue([
      {
        requestId: 'r',
        chatId: 'c',
        subChatId: 's',
        type: 'bash',
        reason: 'Command needs approval',
        path: 'rm scratch.txt',
        prompt: { input: { command: 'rm scratch.txt' } },
      },
    ]);
    expect(mobilePermissions()[0]).toMatchObject({ supported: true });
    expect(mobilePermissions()[0].description).toContain('rm scratch.txt');
  });
  it('withholds approval when full content cannot be reviewed on mobile', () => {
    fixture.permissions.mockReturnValue([
      { requestId: 'r', chatId: 'c', subChatId: 's', type: 'bash', path: 'x'.repeat(12001) },
    ]);
    expect(mobilePermissions()[0]).toMatchObject({ supported: false });
  });
  it('keeps unsupported move requests visible so they do not silently disappear', () => {
    fixture.permissions.mockReturnValue([]);
    fixture.moves.mockReturnValue([
      { requestId: 'move', chatId: 'c', subChatId: 's', projectName: 'Site' },
    ]);
    expect(mobilePermissions()[0]).toMatchObject({ requestId: 'move', supported: false });
  });
});
