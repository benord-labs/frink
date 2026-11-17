import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretRequest } from '../../../../shared/types/task-signal';
import { parse as parseDotenv } from 'dotenv';
import * as database from '../../db';
import { createChat } from '../../db/repos/chats';
import { createProject } from '../../db/repos/projects';
import { createTask, getTaskById, updateTaskStatus } from '../../db/repos/tasks';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb } from '../../db/test-utils/fresh-db';
import { copyWorktreeIncludes } from '../../git/worktree/include';
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
import * as flowSignal from '../../socket/flow-signal';
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

  // One run for the file: every test shares one database, and the seed's project path is fixed.
  let flowRunId: string | undefined;

  /** A Flow step parked on the request, with the chat's live driving step reported as `driving`. */
  async function parkFlowStep(driving: (taskId: string) => string) {
    flowRunId ??= (await seedFlowRun(localDb, { nodes: [], edges: [] })).flowRunId;
    const task = await createTask(localDb, { description: 'step', source: 'flow', flowRunId });
    const agentSignal = { state: 'awaiting_input', summary: 'Needs KEY', secretRequest: request() };
    updateTaskStatus(localDb, task.id, 'needs_attention', { result: { agentSignal } });
    const arming = await flowSignal.resolveFlowSignalArming(undefined, null);
    vi.spyOn(flowSignal, 'resolveFlowSignalArming').mockResolvedValue({
      ...arming,
      effectiveSignalTaskId: driving(task.id),
    });
    return task;
  }

  it('resumes a paused Flow step only as the step it parked on', async () => {
    const task = await parkFlowStep((id) => id);

    await caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: task.id, value: SECRET });

    expect(sent.map((payload) => payload.expectedFlowTaskId)).toEqual([task.id]);
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toBe(`STRIPE_KEY=${SECRET}\n`);
  });

  // The executor declines a reply to a step that is no longer driving; the value must not be saved
  // first, or the file would hold a key the agent never hears about.
  it('writes nothing when the Flow step changed before the send', async () => {
    const task = await parkFlowStep(() => 'next-step');

    await expect(
      caller.submit({ subChatId: 'sub-1', requestId: 'req-1', taskId: task.id, value: SECRET }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This Flow step changed. Refresh before replying.',
    });

    expect(await fs.readdir(dir)).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('secretRequests router in a worktree chat', { timeout: 60_000 }, () => {
  let main: string;
  let worktree: string;

  function git(cwd: string, ...args: string[]) {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  }

  let chatId: string;

  /** A project whose main checkout ignores `.env` (unless `ignored` is false) and one linked worktree. */
  async function setUpProject({ ignored = true } = {}) {
    main = path.join(dir, 'main');
    worktree = path.join(dir, 'wt');
    await fs.mkdir(main);
    await fs.writeFile(path.join(main, '.gitignore'), ignored ? '.env\n' : 'node_modules\n');
    git(main, 'init', '-q');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', worktree);
    const project = await createProject(localDb, { name: 'P', path: main });
    chatId = (await createChat(localDb, { name: 'C', projectId: project.id })).id;
  }

  /** The request the tool holds after an agent in `cwd` asks for `name`. */
  async function ask(
    cwd: string,
    { subChatId = 'sub-1', name = 'STRIPE_KEY', file = '.env' } = {},
  ) {
    const ctx: RequestSecretToolContext = {
      chatId,
      subChatId,
      projectPath: cwd,
      taskSignalEnabled: false,
    };
    await handleRequestSecretToolCall(ctx, { name, file, reason: 'Charge test cards' });
    const asked = getLiveSecretRequest(subChatId);
    if (!asked) throw new Error('the tool held no request');
    return asked;
  }

  async function askInWorktree(): Promise<SecretRequest> {
    await setUpProject();
    return ask(worktree);
  }

  const submit = (asked: SecretRequest) =>
    caller.submit({ subChatId: 'sub-1', requestId: asked.id, taskId: null, value: SECRET });

  const keyIn = async (file: string) =>
    parseDotenv(await fs.readFile(file, 'utf8').catch(() => '')).STRIPE_KEY;

  afterEach(() => {
    for (const subChatId of ['sub-1', 'sub-2', 'sub-3']) {
      const live = getLiveSecretRequest(subChatId);
      if (live) clearLiveSecretRequest(subChatId, live.id);
    }
  });

  it('saves to the worktree and the main checkout, naming both, and later worktrees get it', async () => {
    const asked = await askInWorktree();

    await submit(asked);

    const mainEnv = path.join(main, '.env');
    expect(asked.mainCheckout).toEqual({ path: mainEnv, replaces: false, git: 'ignored' });
    expect(sentTexts()).toEqual([`STRIPE_KEY saved to .env and to ${mainEnv}`]);
    expect(await keyIn(path.join(worktree, '.env'))).toBe(SECRET);
    expect(await keyIn(mainEnv)).toBe(SECRET);
    const later = path.join(dir, 'later');
    git(main, 'worktree', 'add', '-q', later);
    await copyWorktreeIncludes(main, later);
    expect(await keyIn(path.join(later, '.env'))).toBe(SECRET);
  });

  it("writes neither file when the main checkout's file refuses the edit", async () => {
    const asked = await askInWorktree();
    await fs.writeFile(path.join(main, '.env'), 'STRIPE_KEY="two\nlines"\n');
    const before = await fs.readFile(path.join(main, '.env'), 'utf8');

    await expect(submit(asked)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await fs.readFile(path.join(main, '.env'), 'utf8')).toBe(before);
    expect(await keyIn(path.join(worktree, '.env'))).toBeUndefined();
    expect(sent).toEqual([]);
    expect(getLiveSecretRequest('sub-1')?.id).toBe(asked.id);
  });

  it('writes neither file when the main checkout is no longer where the form said', async () => {
    const asked = await askInWorktree();
    await fs.rm(main, { recursive: true });

    await expect(submit(asked)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `${path.join(main, '.env')} changed since this form opened. Choose Don't save and ask the agent again.`,
    });

    expect(await keyIn(path.join(worktree, '.env'))).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('keeps the main checkout file on a request parked on a task', async () => {
    const asked = await askInWorktree();
    const task = await createTask(localDb, { description: 'step', source: 'flow' });
    const agentSignal = { state: 'awaiting_input', summary: 'Needs KEY', secretRequest: asked };
    updateTaskStatus(localDb, task.id, 'needs_attention', { result: { agentSignal } });
    clearLiveSecretRequest('sub-1', asked.id);

    await caller.submit({
      subChatId: 'sub-1',
      requestId: asked.id,
      taskId: task.id,
      value: SECRET,
    });

    expect(await keyIn(path.join(main, '.env'))).toBe(SECRET);
  });

  // A Flow fans out to parallel worktrees: every save also edits the one main file at once.
  it('keeps every key when two worktree chats and a main checkout chat save at once', async () => {
    await setUpProject();
    const second = path.join(dir, 'wt2');
    git(main, 'worktree', 'add', '-q', second);
    const asks = [
      await ask(worktree, { subChatId: 'sub-1', name: 'KEY_A' }),
      await ask(second, { subChatId: 'sub-2', name: 'KEY_B' }),
      await ask(main, { subChatId: 'sub-3', name: 'KEY_C' }),
    ];
    // Slow writes, so every save has read the main file before any wrote it unless they queue.
    const write = envFile.writeEnvFileAtomic;
    vi.spyOn(envFile, 'writeEnvFileAtomic').mockImplementation(async (target, content) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return write(target, content);
    });

    await Promise.all(
      asks.map((asked, index) =>
        caller.submit({
          subChatId: `sub-${index + 1}`,
          requestId: asked.id,
          taskId: null,
          value: `v${index}`,
        }),
      ),
    );

    const read = async (folder: string) =>
      parseDotenv(await fs.readFile(path.join(folder, '.env'), 'utf8'));
    expect(asks[2]?.mainCheckout).toBeUndefined();
    expect(await read(main)).toEqual({ KEY_A: 'v0', KEY_B: 'v1', KEY_C: 'v2' });
    expect(await read(worktree)).toEqual({ KEY_A: 'v0' });
    expect(await read(second)).toEqual({ KEY_B: 'v1' });
  });

  // New worktrees copy only ignored files: an untracked main file must become ignored to travel.
  it('keeps an untracked main checkout file out of git, so later worktrees still get it', async () => {
    await setUpProject({ ignored: false });
    const asked = await ask(worktree);

    await submit(asked);

    expect(asked.mainCheckout).toMatchObject({ git: 'untracked' });
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: main, encoding: 'utf8' })).toBe(
      '',
    );
    const later = path.join(dir, 'later');
    git(main, 'worktree', 'add', '-q', later);
    await copyWorktreeIncludes(main, later);
    expect(await keyIn(path.join(later, '.env'))).toBe(SECRET);
  });

  // The save writes only what the form named; a tracked main file would put the key in a commit.
  it('never writes a main checkout file the form said it would skip', async () => {
    await setUpProject();
    await fs.writeFile(path.join(main, '.env.local'), 'OTHER=1\n');
    git(main, 'add', '.env.local');
    git(main, 'commit', '-q', '-m', 'tracked env');
    git(worktree, 'pull', '-q', main, 'HEAD');
    const asked = await ask(worktree, { file: '.env.local' });

    await submit(asked);

    expect(asked.mainCheckout).toEqual({
      skipped: 'Git tracks that file in your main project, so a commit would include it.',
    });
    expect(sentTexts()).toEqual(['STRIPE_KEY saved to .env.local']);
    expect(await fs.readFile(path.join(main, '.env.local'), 'utf8')).toBe('OTHER=1\n');
  });
});
