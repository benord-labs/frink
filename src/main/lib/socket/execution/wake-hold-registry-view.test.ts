import { describe, expect, it, vi } from 'vitest';

const holds = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../claude-wake-hold', () => ({ readWakeHolds: () => holds }));
vi.mock('../claude-session-registry', () => ({ getSession: vi.fn() }));
vi.mock('./wake-hold-signal', () => ({ summarizePendingWork: () => ({ waitingOn: ['Monitor'] }) }));

import { listWakeHolds } from './wake-hold-registry-view';

const liveHold = (isFlowTurn: boolean) => ({
  chatId: 'c1',
  execution: { isFlowTurn },
  session: { stopHook: { lastPendingWork: {} } },
  retracted: false,
  settling: false,
});

// A reloaded window seeds from this list and must not chime for a Flow node's wait.
describe('listWakeHolds — marking Flow-owned holds', () => {
  it('marks only the hold armed by a Flow turn', () => {
    holds.set('chat-hold', liveHold(false));
    holds.set('flow-hold', liveHold(true));
    const pending = { waitingOn: ['Monitor'] };
    expect(listWakeHolds()).toEqual([
      { subChatId: 'chat-hold', chatId: 'c1', pending },
      { subChatId: 'flow-hold', chatId: 'c1', pending, flow: true },
    ]);
  });
});
