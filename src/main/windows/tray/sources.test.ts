import { afterEach, describe, expect, it, vi } from 'vitest';
import { pendingToolApprovals } from '../../lib/claude/ask-user-question-approval';
import * as database from '../../lib/db';
import { chats, subChats } from '../../lib/db/schema';
import { freshDb } from '../../lib/db/test-utils/fresh-db';
import {
  _clearActiveExecutionsForTests,
  setActiveExecution,
} from '../../lib/socket/streaming/execution-registry';
import {
  _clearLiveStreamRegistryForTests,
  recordLiveStreamChunk,
  recordLiveStreamStart,
  resolveLiveStreamEpoch,
} from '../../lib/socket/streaming/live-stream/registry';
import { createPendingPermissionRequestBroker } from '../../lib/socket/streaming/pending-permission/request';
import { answerTrayRequest, readTrayLive, readTraySaved } from './sources';

const broker = createPendingPermissionRequestBroker({
  getExecutionSignal: () => undefined,
  onResponse: () => undefined,
  sendDismiss: () => undefined,
  sendRequest: () => undefined,
});

function startStream(chatId: string, subChatId: string, parts: unknown[]) {
  setActiveExecution(subChatId, new AbortController(), 7, { chatId, assistantMessageId: 'm' });
  const streamEpoch = resolveLiveStreamEpoch(subChatId, 'm');
  recordLiveStreamStart({ chatId, subChatId, assistantMessageId: 'm', streamEpoch });
  recordLiveStreamChunk({
    chatId,
    subChatId,
    assistantMessageId: 'm',
    streamEpoch,
    messageIndex: 0,
    parts,
    chunk: { type: 'tool-input-available' },
  });
}

afterEach(() => {
  broker.drain();
  pendingToolApprovals.clear();
  _clearActiveExecutionsForTests();
  _clearLiveStreamRegistryForTests();
  vi.restoreAllMocks();
});

describe('readTrayLive', () => {
  it('reads running chats, pending requests and questions from the live registries', () => {
    startStream('reading', 'reading-1', [
      { type: 'tool-Read', input: { file_path: '/r/README.md' } },
    ]);
    setActiveExecution('starting-1', new AbortController(), 7, {
      chatId: 'starting',
      assistantMessageId: 'm',
    });
    const identity = { chatId: 'asking', subChatId: 'asking-1' };
    void broker.request(
      { ...identity, requestId: 'p1', type: 'bash', path: 'bun test', operation: 'bash' },
      null,
    );
    void broker.request(
      { ...identity, requestId: 'p2', type: 'file', path: '/a.ts', operation: 'write' },
      null,
    );
    pendingToolApprovals.set('tool', {
      chatId: 'question',
      subChatId: 'question-1',
      questions: [],
      resolve: () => true,
    });

    const live = readTrayLive(true);

    expect(live.working).toEqual([
      { chatId: 'reading', subChatId: 'reading-1', held: false, activity: 'Reading README.md' },
      { chatId: 'starting', subChatId: 'starting-1', held: false, activity: 'Working' },
    ]);
    expect(live.permissions).toEqual([
      { ...identity, requestId: 'p1', command: 'bun test' },
      { ...identity, requestId: 'p2' },
    ]);
    expect(live.questions).toEqual([{ chatId: 'question', subChatId: 'question-1' }]);
    expect(live.canApprove).toBe(true);
  });
});

describe('readTraySaved', () => {
  it('names chats, leaving archived and missing ones out', async () => {
    const db = freshDb();
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    db.insert(chats)
      .values([
        { id: 'named', name: 'Fix the checkout bug' },
        { id: 'unnamed', name: null },
        { id: 'archived', name: 'Old work', archivedAt: new Date() },
      ])
      .run();

    const saved = await readTraySaved(['named', 'unnamed', 'archived', 'gone']);

    expect(Object.fromEntries(saved.names)).toEqual({
      named: 'Fix the checkout bug',
      unnamed: 'Untitled chat',
      archived: null,
      gone: null,
    });
    expect(saved.waits).toEqual([]);
    expect(saved.approvals).toEqual([]);
  });
});

describe('answerTrayRequest', () => {
  const approval = { chatId: 'chat', subChatId: 'chat-1', requestId: 'p1', command: 'bun test' };
  const ask = () =>
    broker.request(
      {
        chatId: 'chat',
        subChatId: 'chat-1',
        requestId: 'p1',
        type: 'bash',
        path: 'bun test',
        operation: 'bash',
      },
      null,
    );

  function seedChat() {
    const db = freshDb();
    vi.spyOn(database, 'getDatabase').mockReturnValue(db);
    db.insert(chats).values({ id: 'chat', name: 'Fix the checkout bug' }).run();
    db.insert(subChats).values({ id: 'chat-1', chatId: 'chat' }).run();
  }

  it('answers a request that is still waiting', async () => {
    seedChat();
    const pending = ask();

    await answerTrayRequest(approval, false);

    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('leaves alone a request already answered, before or while the menu answers it', async () => {
    seedChat();
    await expect(answerTrayRequest(approval, false)).resolves.toBeUndefined();

    void ask();
    const answering = answerTrayRequest(approval, false);
    broker.drain();
    await expect(answering).resolves.toBeUndefined();
  });

  it('reports a request it could not answer while it is still waiting', async () => {
    vi.spyOn(database, 'getDatabase').mockReturnValue(freshDb());
    void ask();

    await expect(answerTrayRequest(approval, false)).rejects.toMatchObject({ status: 404 });
  });
});
