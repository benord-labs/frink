// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { armApprovedPlanState, useAgentSubChatStore } from './sub-chat-store';

const { getAtom, setAtom, contextAtom, idsAtom } = vi.hoisted(() => ({
  getAtom: vi.fn(),
  setAtom: vi.fn(),
  contextAtom: Symbol('approved-plan-context'),
  idsAtom: Symbol('approved-plan-ids'),
}));

vi.mock('../../../lib/jotai-store', () => ({
  appStore: { get: getAtom, set: setAtom },
}));

vi.mock('../atoms', () => ({
  approvedPlanContextAtomFamily: () => contextAtom,
  approvedPlanIdsAtomFamily: () => idsAtom,
}));

describe('armApprovedPlanState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAtom.mockReturnValue(new Set(['approved-before']));
    useAgentSubChatStore.getState().reset();
  });

  it('stores context, remembers its plan ID, and settles the sub-chat in agent mode', () => {
    const context = { planId: 'approved-now', planText: 'Build the reviewed plan' };

    armApprovedPlanState('sub-1', context);

    expect(setAtom).toHaveBeenCalledWith(contextAtom, context);
    expect(setAtom).toHaveBeenCalledWith(idsAtom, new Set(['approved-before', 'approved-now']));
    expect(useAgentSubChatStore.getState().subChatsById['sub-1']).toMatchObject({
      id: 'sub-1',
      mode: 'agent',
    });
  });
});
