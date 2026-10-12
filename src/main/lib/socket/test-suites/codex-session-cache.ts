import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runCodexAgent } from '../../agent-runner';
import type { UIMessageChunk } from '../../claude/types';
import { getDefaultClaudeCodeToken } from '../../credentials';
import { disposeTrailingStreamErrorChunk } from '../../tasks';
import { clearCodexSubChatSession } from '../codex-session';
import { clearCodexSession, handleRemoteExecute, handleRemoteStop } from '../executor';

/** Registers the Codex resume-cache cases against the parent executor test harness (its mocks). */

const project = {
  id: 'project-1',
  user_id: 'user-1',
  name: 'Project One',
  path: '/tmp/project',
  git_remote: null,
  shortcut_project_id: null,
  is_primary: false,
  machine_id: 'machine-1',
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
const history = [
  { role: 'user' as const, content: 'earlier question' },
  { role: 'assistant' as const, content: 'earlier answer' },
];

type ExecutePayload = Parameters<typeof handleRemoteExecute>[0];

async function runExecute(
  chatId: string,
  subChatId: string,
  sessionIdFromStream: string,
  overrides: Partial<ExecutePayload> = {},
): Promise<void> {
  vi.mocked(runCodexAgent).mockImplementation(async function* (input) {
    // SAFETY: a 'finish' chunk's messageMetadata is an open record; the executor reads only its
    // sessionId, and resumedFrom is test-only provenance it ignores.
    yield {
      type: 'finish',
      messageMetadata: { sessionId: sessionIdFromStream, resumedFrom: input.resumeThreadId },
    } as UIMessageChunk;
  });
  await handleRemoteExecute({
    chatId,
    subChatId,
    projectId: project.id,
    message: 'hello',
    mode: 'agent',
    assistantMessageId: `assistant-${subChatId}-${sessionIdFromStream}`,
    history: [],
    ...overrides,
  });
}

/** `resetHarness` re-arms the parent file's shared mock defaults for this project. */
export function registerCodexSessionCacheTests(
  resetHarness: (machineId: string, projectRow: typeof project) => void,
): void {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCodexAgent).mockReset();
    resetHarness(project.machine_id, project);
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

  it('does not re-cache a thread when its chat is deleted while the turn is finishing', async () => {
    // Delete aborts the turn and clears the cache while the executor awaits stream disposal.
    vi.mocked(disposeTrailingStreamErrorChunk).mockImplementationOnce(async () => {
      handleRemoteStop({ chatId: 'chat-a', subChatId: 'sub-1' });
      clearCodexSession('chat-a');
      return false;
    });
    await runExecute('chat-a', 'sub-1', 'sess-1');
    await runExecute('chat-a', 'sub-1', 'sess-1-new');

    expect(vi.mocked(runCodexAgent).mock.calls[1]?.[0]?.resumeThreadId).toBeUndefined();
  }, 25_000);

  it('does not re-cache a thread when a delete clears the chat but cannot abort the turn', async () => {
    // Delete's sub-chat lookup failed, so it cleared the cache without aborting the live turn.
    vi.mocked(disposeTrailingStreamErrorChunk).mockImplementationOnce(async () => {
      clearCodexSession('chat-a');
      return false;
    });
    await runExecute('chat-a', 'sub-1', 'sess-1');
    await runExecute('chat-a', 'sub-1', 'sess-1-new');

    expect(vi.mocked(runCodexAgent).mock.calls[1]?.[0]?.resumeThreadId).toBeUndefined();
  }, 25_000);

  it('does not re-cache a thread when the chat is cleared during turn setup', async () => {
    // The clear lands in an await before the executor reads the cache, not during the stream.
    vi.mocked(getDefaultClaudeCodeToken).mockImplementationOnce(async () => {
      clearCodexSession('chat-a');
      return codexCredential;
    });
    await runExecute('chat-a', 'sub-1', 'sess-1');
    await runExecute('chat-a', 'sub-1', 'sess-1-new');

    expect(vi.mocked(runCodexAgent).mock.calls[1]?.[0]?.resumeThreadId).toBeUndefined();
  }, 25_000);

  it('starts a fresh Codex thread with history after a rollback discards the cached one', async () => {
    await runExecute('chat-a', 'sub-1', 'sess-pre-rollback', { history });

    // What a rollback leaves behind: the cache entry dropped and '' persisted as the session.
    clearCodexSubChatSession('sub-1');
    await runExecute('chat-a', 'sub-1', 'sess-post-rollback', {
      sessionId: '',
      message: 'after rollback',
      history,
    });

    const afterRollback = vi.mocked(runCodexAgent).mock.calls[1]?.[0];
    expect(afterRollback?.resumeThreadId).toBeFalsy();
    expect(afterRollback?.prompt).toContain('<conversation_history>');
    expect(afterRollback?.prompt).toContain('after rollback');
  }, 25_000);
}
