import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../../db';
import { freshDb } from '../../db/test-utils/fresh-db';
import * as persist from '../../trpc/routers/frink-task-signal-persist';
import * as taskSignalTool from '../task-signal-tool';
import { toolResult } from '../tool-result';
import { clearLiveSecretRequest, getLiveSecretRequest } from './store';
import { handleRequestSecretToolCall, type RequestSecretToolContext } from './index';

let dir: string;

const ARGS = { name: 'STRIPE_KEY', reason: 'Charge test cards' };

function plainChat(): RequestSecretToolContext {
  return { chatId: 'chat-1', subChatId: 'sub-1', projectPath: dir, taskSignalEnabled: false };
}

function taskTurn(): RequestSecretToolContext {
  return {
    chatId: 'chat-1',
    subChatId: 'sub-1',
    projectPath: dir,
    taskSignalEnabled: true,
    signalTaskId: 'task-1',
  };
}

const localDb = freshDb();

beforeEach(async () => {
  vi.spyOn(database, 'getDatabase').mockReturnValue(localDb);
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'secret-tool-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  const live = getLiveSecretRequest('sub-1');
  if (live) clearLiveSecretRequest('sub-1', live.id);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('frink_request_secret', () => {
  it('holds the request for a chat with no task and tells the agent to end its turn', async () => {
    const result = await handleRequestSecretToolCall(plainChat(), ARGS);

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('End your turn now');
    expect(getLiveSecretRequest('sub-1')).toMatchObject({
      name: 'STRIPE_KEY',
      chatId: 'chat-1',
      file: '.env',
      cwd: dir,
      reason: 'Charge test cards',
      replaces: false,
    });
  });

  it('parks a task-linked turn on the request instead of holding it live', async () => {
    vi.spyOn(persist, 'recordLinkedTaskSignal').mockResolvedValue(true);
    const accept = vi
      .spyOn(taskSignalTool, 'handleTaskSignalToolCall')
      .mockImplementation(async (ctx, args, secretRequest) => {
        const summary = String(args.summary);
        ctx.latestTaskSignal = { state: 'awaiting_input', summary, at: 'now', secretRequest };
        return toolResult('ok');
      });
    const ctx = taskTurn();

    await handleRequestSecretToolCall(ctx, { ...ARGS, file: '.env.local' });

    expect(accept).toHaveBeenCalledWith(
      ctx,
      { state: 'awaiting_input', summary: 'Needs STRIPE_KEY' },
      expect.objectContaining({ name: 'STRIPE_KEY', file: '.env.local' }),
    );
    expect(ctx.latestTaskSignal?.secretRequest).toMatchObject({
      name: 'STRIPE_KEY',
      chatId: 'chat-1',
      file: '.env.local',
    });
    expect(getLiveSecretRequest('sub-1')).toBeNull();
  });

  // Claude records a same-message frink_task_signal on the task row as it streams; the park must
  // reach the row too, so it replaces that and the row never shows a finished task mid-turn.
  it('writes the park to the task row as soon as it is recorded', async () => {
    vi.spyOn(taskSignalTool, 'handleTaskSignalToolCall').mockImplementation(
      async (ctx, _args, secretRequest) => {
        ctx.latestTaskSignal = { state: 'awaiting_input', summary: 'x', at: 'now', secretRequest };
        return toolResult('ok');
      },
    );
    const record = vi.spyOn(persist, 'recordLinkedTaskSignal').mockResolvedValue(true);

    await handleRequestSecretToolCall(taskTurn(), ARGS);

    expect(record).toHaveBeenCalledWith({
      taskIdForExecution: 'task-1',
      signal: expect.objectContaining({ secretRequest: expect.objectContaining({ name: 'STRIPE_KEY' }) }),
    });
  });

  // A row that is not running refuses the park now and would drop it at turn end too, so the agent
  // must not be told a form is showing that never will: the request goes live instead.
  it('holds the request live and keeps the earlier signal when the task row refuses the park', async () => {
    vi.spyOn(taskSignalTool, 'handleTaskSignalToolCall').mockImplementation(
      async (ctx, _args, secretRequest) => {
        ctx.latestTaskSignal = { state: 'awaiting_input', summary: 'x', at: 'now', secretRequest };
        return toolResult('ok');
      },
    );
    vi.spyOn(persist, 'recordLinkedTaskSignal').mockResolvedValue(false);
    const ctx = taskTurn();
    const earlier: taskSignalTool.RecordedTaskSignal = { state: 'partial', summary: 'Half done', at: 'earlier' };
    ctx.latestTaskSignal = earlier;

    const result = await handleRequestSecretToolCall(ctx, ARGS);

    expect(result.isError).toBe(false);
    expect(ctx.latestTaskSignal).toBe(earlier);
    expect(getLiveSecretRequest('sub-1')?.name).toBe('STRIPE_KEY');
    // The agent was told not to signal: the stop guards must not then demand one.
    expect(ctx.taskSignalEnabled).toBe(false);
  });

  it('falls back to a live request when the task can no longer take a signal', async () => {
    vi.spyOn(taskSignalTool, 'handleTaskSignalToolCall').mockResolvedValue(
      toolResult('Signal not accepted', true),
    );

    await handleRequestSecretToolCall(taskTurn(), ARGS);

    expect(getLiveSecretRequest('sub-1')?.name).toBe('STRIPE_KEY');
  });

  it('asks for one secret per turn on a task-linked turn, keeping the park', async () => {
    vi.spyOn(persist, 'recordLinkedTaskSignal').mockResolvedValue(true);
    vi.spyOn(taskSignalTool, 'handleTaskSignalToolCall').mockImplementation(
      async (ctx, _args, secretRequest) => {
        ctx.latestTaskSignal = { state: 'awaiting_input', summary: 'Needs A', at: 'now', secretRequest };
        return toolResult('ok');
      },
    );
    const ctx = taskTurn();
    await handleRequestSecretToolCall(ctx, { ...ARGS, name: 'A' });

    const result = await handleRequestSecretToolCall(ctx, ARGS);

    expect(result).toMatchObject({ isError: true });
    expect(ctx.latestTaskSignal?.secretRequest?.name).toBe('A');
  });

  // The agent was promised "A saved"; a second ask in the same turn must not silently replace it.
  it('keeps the first request when a chat with no task asks twice in one turn', async () => {
    const ctx = plainChat();
    await handleRequestSecretToolCall(ctx, { ...ARGS, name: 'FIRST_KEY' });

    const second = await handleRequestSecretToolCall(ctx, ARGS);

    expect(second).toMatchObject({ isError: true });
    expect(getLiveSecretRequest('sub-1')?.name).toBe('FIRST_KEY');
  });

  // Both calls of one assistant message run together; the claim must not wait behind their awaits.
  it('keeps the first of two requests made in parallel in one turn', async () => {
    const ctx = plainChat();

    const [first, second] = await Promise.all([
      handleRequestSecretToolCall(ctx, { ...ARGS, name: 'FIRST_KEY' }),
      handleRequestSecretToolCall(ctx, ARGS),
    ]);

    expect([first.isError, second.isError]).toEqual([false, true]);
    expect(getLiveSecretRequest('sub-1')?.name).toBe('FIRST_KEY');
  });

  it('lets the agent ask again in the same turn after a refused target', async () => {
    const ctx = plainChat();
    await handleRequestSecretToolCall(ctx, { ...ARGS, file: '../.env' });

    const retry = await handleRequestSecretToolCall(ctx, ARGS);

    expect(retry.isError).toBe(false);
  });

  it('refuses bad arguments and unsafe targets with a reason the agent can act on', async () => {
    const badName = await handleRequestSecretToolCall(plainChat(), { ...ARGS, name: 'MY-KEY' });
    const noReason = await handleRequestSecretToolCall(plainChat(), { name: 'STRIPE_KEY' });
    const unsafe = await handleRequestSecretToolCall(plainChat(), { ...ARGS, file: '../.env' });

    expect(badName.isError).toBe(true);
    expect(noReason.isError).toBe(true);
    expect(unsafe).toMatchObject({ isError: true });
    expect(unsafe.content[0]?.text).toContain('must be a path inside the project');
    expect(getLiveSecretRequest('sub-1')).toBeNull();
  });
});
