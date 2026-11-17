import { describe, expect, it, vi } from 'vitest';

const holds = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../claude-wake-hold', () => ({ readWakeHolds: () => holds }));
vi.mock('../claude-session-registry', () => ({ getSession: vi.fn() }));
const pending = vi.hoisted(() => ({
  waitingOn: [{ id: 'm1', label: 'Monitor', description: 'Watch deploys', stoppable: false }],
}));
vi.mock('./wake-hold-signal', () => ({ summarizePendingWork: () => pending }));

import { listWakeHolds, listWakeHoldSubChatIdsForChat } from './wake-hold-registry-view';

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
    expect(listWakeHolds()).toEqual([
      { subChatId: 'chat-hold', chatId: 'c1', pending },
      { subChatId: 'flow-hold', chatId: 'c1', pending, flow: true },
    ]);
  });
});

describe('listWakeHoldSubChatIdsForChat', () => {
  it("includes a chat's stopped and settling holds — their pumps are still live", () => {
    holds.clear();
    holds.set('live', liveHold(false));
    holds.set('stopped', { ...liveHold(false), retracted: true });
    holds.set('settling', { ...liveHold(false), settling: true });
    holds.set('other-chat', { ...liveHold(false), chatId: 'c2' });

    expect(listWakeHoldSubChatIdsForChat('c1')).toEqual(['live', 'stopped', 'settling']);
  });
});
