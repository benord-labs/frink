import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, guardMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  guardMock: vi.fn(),
}));

vi.mock('node-pty', () => ({ spawn: spawnMock }));
vi.mock('./node-pty-spawn-helper', () => ({ ensureSpawnHelperExecutable: guardMock }));

import { FALLBACK_SHELL } from './env';
import { createSession } from './session';

function fakePty() {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    pid: 1,
  };
}

describe('createSession spawn wiring', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    guardMock.mockReset();
  });

  it('repairs the spawn-helper exec bit before the pty spawn', async () => {
    spawnMock.mockReturnValue(fakePty());

    await createSession({ paneId: 'p1', cwd: os.homedir() }, () => {});

    expect(guardMock).toHaveBeenCalledTimes(1);
    expect(guardMock.mock.invocationCallOrder[0]).toBeLessThan(
      spawnMock.mock.invocationCallOrder[0],
    );
  });

  it('falls back to the fallback shell when the primary shell fails to spawn', async () => {
    const survivor = fakePty();
    spawnMock
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValue(survivor);

    const session = await createSession({ paneId: 'p1', cwd: os.homedir() }, () => {});

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][0]).toBe(FALLBACK_SHELL);
    expect(session.pty).toBe(survivor);
  });
});
