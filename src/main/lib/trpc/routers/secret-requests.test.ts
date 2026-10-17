import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretRequest } from '../../../../shared/types/task-signal';
import * as database from '../../db';
import { createTask, getTaskById, updateTaskStatus } from '../../db/repos/tasks';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb } from '../../db/test-utils/fresh-db';
import {
  handleRequestSecretToolCall,
  type RequestSecretToolContext,
} from '../../mcp/secret-request';
import * as envFile from '../../mcp/secret-request/env-file';
import * as gitState from '../../mcp/secret-request/git-state';
import {
  clearLiveSecretRequest,
  getLiveSecretRequest,
  setLiveSecretRequest,
} from '../../mcp/secret-request/store';
import * as socketClient from '../../socket/client';
import { ChatBusyError } from '../../socket/execution/send-admission';
import { recordLinkedTaskSignal } from './frink-task-signal-persist';
import { secretRequestsRouter } from './secret-requests';

const localDb = freshDb();
vi.spyOn(database, 'getDatabase').mockReturnValue(localDb);

const caller = secretRequestsRouter.createCaller({ getWindow: () => null });
const SECRET = 'sk_live_TOPSECRET';
let dir: string;

function request(overrides: Partial<SecretRequest> = {}): SecretRequest {
  return {
    id: 'req-1',
    name: 'STRIPE_KEY',
    chatId: 'chat-1',
    file: '.env',
    cwd: dir,
    reason: 'Charge test cards',
    replaces: false,
    git: 'none',
    ...overrides,
  };
}

const logSpies = () => [
  vi.spyOn(log, 'info'),
  vi.spyOn(log, 'warn'),
  vi.spyOn(log, 'error'),
  vi.spyOn(log, 'debug'),
];

type SendPayload = Parameters<typeof socketClient.sendMessage>[0];
/** What reached the agent: every send whose admission check (beforeSend) passed. */
let sent: SendPayload[] = [];

/** The chat's send admission: beforeSend runs inside it, and a throw there sends nothing. */
function stubSend() {
  return vi.spyOn(socketClient, 'sendMessage').mockImplementation(async (payload, options) => {
    await options?.beforeSend?.();
    sent.push(payload);
  });
}

const sentTexts = () =>
  sent.map((payload) => payload.userMessage.parts?.find((part) => part.type === 'text')?.text);

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'secret-router-')));
  sent = [];
  stubSend();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(database, 'getDatabase').mockReturnValue(localDb);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('secretRequests router', () => {
  it('writes a live request to the file and tells the agent only the fixed text', async () => {
    const spies = logSpies();
    await fs.writeFile(path.join(dir, '.env'), '# keys\nOTHER=1\n');
    setLiveSecretRequest('sub-1', request());

    const pending = await caller.pending({ subChatId: 'sub-1' });
    const result = await caller.submit({
      subChatId: 'sub-1',
      requestId: 'req-1',
      taskId: null,
      value: SECRET,
    });

    expect(pending?.name).toBe('STRIPE_KEY');
    expect(result).toEqual({ ok: true });
    expect(sentTexts()).toEqual(['STRIPE_KEY saved to .env']);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(
      `# keys\nOTHER=1\nSTRIPE_KEY=${SECRET}\n`,
    );
    expect(getLiveSecretRequest('sub-1')).toBeNull();
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    await expect(
      caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: null, value: SECRET }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers the request parking a task, and only while the task is parked', async () => {
    const task = await createTask(localDb, { description: 'step', source: 'flow' });
    const agentSignal = {
      state: 'awaiting_input',
      summary: 'Needs STRIPE_KEY',
      secretRequest: request(),
    };
    updateTaskStatus(localDb, task.id, 'needs_attention', { result: { agentSignal } });
    const ref = { subChatId: 'sub-1', requestId: 'req-1', taskId: task.id };

    await caller.submit({ ...ref, value: SECRET });
    updateTaskStatus(localDb, task.id, 'running');

    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(`STRIPE_KEY=${SECRET}\n`);
    await expect(caller.submit({ ...ref, value: 'again' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // Wiring: the tool's own request, persisted as the turn-end write does, must be answerable.
  it('answers the exact request the tool parked on a task', async () => {
    // The real signal handler, so the park is recorded exactly as a live turn records it.
    const task = await createTask(localDb, { description: 'step', source: 'flow' });
    updateTaskStatus(localDb, task.id, 'running');
    const ctx: RequestSecretToolContext = {
      chatId: 'chat-1',
      subChatId: 'sub-1',
      projectPath: dir,
      taskSignalEnabled: true,
      signalTaskId: task.id,
    };
    await handleRequestSecretToolCall(ctx, { name: 'STRIPE_KEY', reason: 'Charge test cards' });
    const agentSignal = ctx.latestTaskSignal;
    expect(agentSignal?.state).toBe('awaiting_input');
    updateTaskStatus(localDb, task.id, 'needs_attention', { result: { agentSignal } });

    const result = await caller.submit({
      subChatId: 'sub-1',
      requestId: agentSignal?.secretRequest?.id ?? 'missing',
      taskId: task.id,
      value: SECRET,
    });

    expect(result).toEqual({ ok: true });
    expect(sentTexts()).toEqual(['STRIPE_KEY saved to .env']);
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(`STRIPE_KEY=${SECRET}\n`);
  });

  // Claude records a same-message frink_task_signal on the row as it streams; once the park is on
  // the row, that write must not replace it, however the two interleave.
  it('keeps the park on the row when a mid-turn signal is recorded after it', async () => {
    const task = await createTask(localDb, { description: 'step', source: 'flow' });
    const agentSignal = { state: 'awaiting_input', summary: 'Needs KEY', secretRequest: request() };
    updateTaskStatus(localDb, task.id, 'running', { result: { agentSignal } });

    const recorded = await recordLinkedTaskSignal({
      taskIdForExecution: task.id,
      signal: { state: 'done', summary: 'Done' },
    });

    expect(recorded).toBe(false);
    expect((await getTaskById(localDb, task.id))?.result).toEqual({ agentSignal });
  });

  it('keeps the file out of git when it is untracked and not ignored', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    setLiveSecretRequest('sub-1', request({ git: 'untracked' }));

    await caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: null, value: SECRET });

    const exclude = await fs.readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.env\n');
  });

  // Keys copied from a dashboard often carry stray spaces; written quoted they break the app's auth.
  it('saves a pasted value without the whitespace around it', async () => {
    setLiveSecretRequest('sub-1', request());

    await caller.submit({
      subChatId: 'sub-1',
      requestId: 'req-1',
      taskId: null,
      value: ` ${SECRET}\t `,
    });

    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(`STRIPE_KEY=${SECRET}\n`);
  });

  it('writes nothing and keeps the request open when the git exclude fails', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    setLiveSecretRequest('sub-1', request({ git: 'untracked' }));
    vi.spyOn(gitState, 'excludeFromGit').mockRejectedValueOnce(new Error('EACCES'));
    const ref = { subChatId: 'sub-1', requestId: 'req-1', taskId: null };

    await expect(caller.submit({ ...ref, value: SECRET })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });

    expect(await fs.readdir(dir)).toEqual(['.git']);
    expect(sent).toEqual([]);
    expect(getLiveSecretRequest('sub-1')?.id).toBe('req-1');
  });

  // Two chats saving into one project's .env at once: each must re-read the other's write.
  it('keeps both keys when two chats save to the same file at once', async () => {
    setLiveSecretRequest('sub-1', request());
    setLiveSecretRequest('sub-2', request({ id: 'req-2', name: 'OPENAI_KEY' }));

    await Promise.all([
      caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: null, value: 'a1' }),
      caller.submit({ subChatId: 'sub-2', requestId: 'req-2', taskId: null, value: 'b2' }),
    ]);

    const saved = await fs.readFile(path.join(dir, '.env'), 'utf8');
    expect(saved.split('\n').sort()).toEqual(['', 'OPENAI_KEY=b2', 'STRIPE_KEY=a1']);
  });

  it('declines without writing anything', async () => {
    setLiveSecretRequest('sub-1', request());

    const result = await caller.decline({ subChatId: 'sub-1', requestId: 'req-1', taskId: null });

    expect(result).toEqual({ ok: true });
    expect(sentTexts()).toEqual(['I chose not to save STRIPE_KEY.']);
    expect(await fs.readdir(dir)).toEqual([]);
    expect(getLiveSecretRequest('sub-1')).toBeNull();
  });

  it('never echoes the value when saving fails', async () => {
    setLiveSecretRequest('sub-1', request());
    const ref = { subChatId: 'sub-1', requestId: 'req-1', taskId: null };

    const refused = caller.submit({ ...ref, value: `${SECRET}\nX=1` });
    await expect(refused).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The value must fit on one line.',
    });

    vi.spyOn(envFile, 'writeEnvFileAtomic').mockRejectedValueOnce(new Error(`EIO ${SECRET}`));
    const failed = caller.submit({ ...ref, value: SECRET });
    await expect(failed).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Frink could not finish this.',
    });
    expect(sent).toEqual([]);
    expect(getLiveSecretRequest('sub-1')?.id).toBe('req-1');
  });

  // The write happens inside the send admission: a chat that cannot take the message gets no write.
  it('writes nothing and keeps the request open when the chat cannot take the message', async () => {
    setLiveSecretRequest('sub-1', request());
    vi.spyOn(socketClient, 'sendMessage').mockRejectedValueOnce(new ChatBusyError());

    await expect(
      caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: null, value: SECRET }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await fs.readdir(dir)).toEqual([]);
    expect(getLiveSecretRequest('sub-1')?.id).toBe('req-1');
  });

  // Re-checked inside the admission: an answer from another window may have closed it meanwhile.
  it('writes nothing when the request closed while the send was waiting its turn', async () => {
    setLiveSecretRequest('sub-1', request());
    vi.spyOn(socketClient, 'sendMessage').mockImplementationOnce(async (payload, options) => {
      clearLiveSecretRequest('sub-1', 'req-1');
      await options?.beforeSend?.();
      sent.push(payload);
    });

    await expect(
      caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: null, value: SECRET }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'This request has closed.' });

    expect(await fs.readdir(dir)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('resumes a paused Flow step only as the step it parked on', async () => {
    const { flowRunId } = await seedFlowRun(localDb, { nodes: [], edges: [] });
    const task = await createTask(localDb, { description: 'step', source: 'flow', flowRunId });
    const agentSignal = { state: 'awaiting_input', summary: 'Needs KEY', secretRequest: request() };
    updateTaskStatus(localDb, task.id, 'needs_attention', { result: { agentSignal } });

    await caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: task.id, value: SECRET });

    expect(sent.map((payload) => payload.expectedFlowTaskId)).toEqual([task.id]);
  });
});
