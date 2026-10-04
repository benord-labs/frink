import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ run: vi.fn(), request: vi.fn() }));
// Keep render deferred to exercise navigation before React commits state.
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
}));
vi.mock('../../lib/connection', () => ({
  useAction: () => ({ run: harness.run, busy: false, error: null }),
  useConnection: () => ({ connection: { deviceId: 'original-Mac' }, request: harness.request }),
}));
vi.mock('../../lib/api', () => ({
  requestMobile: vi.fn((_connection: unknown, input: unknown) => harness.request(input)),
}));

import { requestMobile } from '../../lib/api';
import { useStartChat } from './use-start-chat';

const choice = { projectId: 'project-1', useWorktree: true, mode: 'agent' as const };
const created = { chatId: 'chat-1', subChatId: 'sub-1' };
const message = { text: 'Hello', requestId: 'request-1', attachments: [] };
function setup() {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Navigation ordering uses deferred state above.
  return useStartChat();
}

beforeEach(() => {
  harness.run.mockReset().mockResolvedValue(created);
  harness.request.mockReset().mockResolvedValue({ ok: true });
  vi.mocked(requestMobile).mockClear();
});
afterEach(() => vi.useRealTimers());

describe('new-chat ownership across navigation', () => {
  it('asks the original Mac once to remove an unused chat and never retries a failure', async () => {
    vi.useFakeTimers();
    harness.request.mockRejectedValue(new Error('Offline'));
    const chat = setup();
    await chat.create(choice);
    chat.leave();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(requestMobile).mock.calls).toEqual([
      [{ deviceId: 'original-Mac' }, { type: 'deleteChat', chatId: created.chatId }],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...choice, mode: 'plan' as const },
    { ...choice, projectId: 'project-2' },
    { ...choice, useWorktree: false },
  ])('retires pending creation when its choice changes to %j', async (next) => {
    let resolve!: (value: typeof created) => void;
    const replacement = { chatId: 'chat-2', subChatId: 'sub-2' };
    harness.run
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce(replacement);
    const chat = setup();
    const first = chat.create(choice);
    const second = chat.create(next);
    resolve(created);
    expect(await first).toBeUndefined();
    expect(await second).toEqual(replacement);
    expect(harness.run).toHaveBeenLastCalledWith({ type: 'createChat', ...next });
    expect(harness.request).toHaveBeenCalledWith({ type: 'deleteChat', chatId: created.chatId });
  });

  it('shares one pending create between concurrent callers', async () => {
    let resolve!: (value: typeof created) => void;
    harness.run.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const chat = setup();
    const first = chat.create(choice);
    const second = chat.create(choice);
    resolve(created);
    expect(await Promise.all([first, second])).toEqual([created, created]);
    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  it('retires pending creation before creating a chat in the changed project', async () => {
    let resolve!: (value: typeof created) => void;
    const replacement = { chatId: 'chat-2', subChatId: 'sub-2' };
    harness.run
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce(replacement);
    const chat = setup();
    const first = chat.create(choice);
    chat.discard();
    const second = chat.create({ ...choice, projectId: 'project-2' });
    resolve(created);
    expect(await first).toBeUndefined();
    expect(await second).toEqual(replacement);
    expect(await chat.create({ ...choice, projectId: 'project-2' })).toEqual(replacement);
    expect(harness.run).toHaveBeenCalledTimes(2);
    expect(harness.request).toHaveBeenCalledExactlyOnceWith({
      type: 'deleteChat',
      chatId: 'chat-1',
    });
  });

  it('removes a pending empty chat when Back wins the creation race', async () => {
    let resolve!: (value: typeof created) => void;
    harness.run.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const chat = setup();
    const pending = chat.create(choice);
    chat.leave();
    resolve(created);
    expect(await pending).toBeUndefined();
    expect(harness.request).toHaveBeenCalledExactlyOnceWith({
      type: 'deleteChat',
      chatId: 'chat-1',
    });
  });

  it('removes an empty chat if Back lands after creation but before the next render', async () => {
    const chat = setup();
    await chat.create(choice);
    chat.leave();
    expect(harness.request).toHaveBeenCalledExactlyOnceWith({
      type: 'deleteChat',
      chatId: 'chat-1',
    });
  });

  it('retires the old empty chat before immediately creating one in a new project', async () => {
    const chat = setup();
    await chat.create(choice);
    chat.discard();
    await chat.create({ ...choice, projectId: 'project-2' });
    expect(harness.request).toHaveBeenCalledExactlyOnceWith({
      type: 'deleteChat',
      chatId: 'chat-1',
    });
    expect(harness.run).toHaveBeenLastCalledWith({
      type: 'createChat',
      ...choice,
      projectId: 'project-2',
    });
  });

  it('does not delete a chat after a first send whose response is uncertain', async () => {
    const chat = setup();
    await chat.create(choice);
    harness.run.mockResolvedValue(undefined);
    await chat.send(created, message);
    chat.leave();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('never sends a first message after its blank page was left', async () => {
    const chat = setup();
    await chat.create(choice);
    chat.leave();
    expect(await chat.send(created, message)).toBe(false);
    expect(harness.run).toHaveBeenCalledTimes(1);
  });
});
