import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat } from './test-factories';

const { togglePinLocalMock } = vi.hoisted(() => ({ togglePinLocalMock: vi.fn() }));

vi.mock('../../../db', () => ({ getDatabase: () => ({}) }));
vi.mock('../../../db/repos/chats', () => ({ togglePin: togglePinLocalMock }));

import { pinRouter } from './pin';

// Local cuid2 chat id (not a UUID) — exercises the non-UUID input validation.
const CHAT = 'mq7zk90vzeoypywdkpa9xbrn';

describe('pinRouter.togglePin (local-first)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the chat is missing', async () => {
    togglePinLocalMock.mockResolvedValue(null);
    const caller = pinRouter.createCaller({ getWindow: () => null });
    await expect(caller.togglePin({ id: CHAT })).resolves.toBeNull();
  });

  it('returns the mapped chat with pinnedAt set', async () => {
    const pinnedAt = new Date('2026-01-03T00:00:00.000Z');
    togglePinLocalMock.mockResolvedValue(makeLocalChat({ id: CHAT, pinnedAt }));
    const caller = pinRouter.createCaller({ getWindow: () => null });
    const out = await caller.togglePin({ id: CHAT });
    expect(out?.id).toBe(CHAT);
    expect(out?.pinnedAt).toEqual(pinnedAt);
    expect(togglePinLocalMock).toHaveBeenCalledWith(expect.anything(), CHAT);
  });
});
