// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT } from '../../../../shared/types/plan';
import { appStore } from '../../../lib/jotai-store';
import { approvedPlanIdsAtomFamily } from '../atoms';
import {
  applyRollbackFilter,
  chatHasGitContextAtomFamily,
  clearPrependedForSubChat,
  clearRollbackFilter,
  clearSubChatCaches,
  currentSubChatIdAtom,
  hasUnapprovedPlanAtom,
  hiddenApprovalPlanIdsForSubChatAtomFamily,
  isFirstUserMessageForSubChatAtomFamily,
  isStreamingForSubChatAtomFamily,
  messageAtomFamily,
  messageGroupsForSubChatAtomFamily,
  ORPHAN_ANCHOR_PREFIX,
  perSubChatMainMessageIdsAtomFamily,
  perSubChatMessageIdsAtomFamily,
  perSubChatStatusAtomFamily,
  prependOlderMessagesAtom,
  setRollbackFilter,
  syncMessagesWithStatusAtom,
  userMessageIdsForSubChatAtomFamily,
} from './message-store';

describe('hasUnapprovedPlanAtom', () => {
  beforeEach(() => {
    appStore.set(currentSubChatIdAtom, 'sub-chat-test');
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [],
      status: 'ready',
      subChatId: 'sub-chat-test',
    });
  });

  it('returns false when there are no assistant messages', () => {
    expect(appStore.get(hasUnapprovedPlanAtom)).toBe(false);
  });

  it('returns true for canonical frink-plan awaiting approval', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-frink-plan',
              input: {
                planId: 'plan-1',
                summary: 'Plan summary',
                planPath: '/tmp/plan.md',
                status: 'awaiting_approval',
              },
            },
          ],
        } as unknown as import('ai').UIMessage,
      ],
      status: 'ready',
      subChatId: 'sub-chat-test',
    });

    expect(appStore.get(hasUnapprovedPlanAtom)).toBe(true);
  });

  it('normalizes historical frink-plan part type to tool-frink-plan in stored messages', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        {
          id: 'assistant-frink-raw',
          role: 'assistant',
          parts: [
            {
              type: 'frink-plan',
              toolCallId: 'plan-raw',
              input: {
                planId: 'plan-raw',
                summary: 'Plan summary',
                status: 'awaiting_approval',
              },
            },
          ],
        } as unknown as import('ai').UIMessage,
      ],
      status: 'ready',
      subChatId: 'sub-chat-test',
    });

    const msg = appStore.get(messageAtomFamily('assistant-frink-raw'));
    expect(msg?.parts?.[0]?.type).toBe('tool-frink-plan');
    expect(appStore.get(hasUnapprovedPlanAtom)).toBe(true);
  });

  it('returns false for canonical frink-plan when status is not awaiting approval', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-frink-plan',
              input: {
                planId: 'plan-1',
                summary: 'Plan summary',
                planPath: '/tmp/plan.md',
                status: 'approved',
              },
            },
          ],
        } as unknown as import('ai').UIMessage,
      ],
      status: 'ready',
      subChatId: 'sub-chat-test',
    });

    expect(appStore.get(hasUnapprovedPlanAtom)).toBe(false);
  });

  it('ignores non-canonical legacy tool invocation parts', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'tool-invocation', toolName: 'LegacyPlanTool' }],
        } as unknown as import('ai').UIMessage,
      ],
      status: 'ready',
      subChatId: 'sub-chat-test',
    });

    expect(appStore.get(hasUnapprovedPlanAtom)).toBe(false);
  });
});

describe('orphan assistant message grouping', () => {
  const SUB = 'orphan-test';

  beforeEach(() => {
    appStore.set(currentSubChatIdAtom, SUB);
  });

  it('creates an orphan anchor group for leading assistant-only messages', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Flow notification' }] },
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });

    const userIds = appStore.get(userMessageIdsForSubChatAtomFamily(SUB));
    expect(userIds).toHaveLength(1);
    expect(userIds[0]).toMatch(new RegExp(`^${ORPHAN_ANCHOR_PREFIX}`));

    const groups = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groups).toHaveLength(1);
    expect(groups[0].userMsgId).toMatch(new RegExp(`^${ORPHAN_ANCHOR_PREFIX}`));
    expect(groups[0].assistantMsgIds).toEqual(['a1']);
  });

  it('creates orphan group + normal groups when assistant messages precede first user', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Flow reply' }] },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Agent reply' }] },
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });

    expect(appStore.get(userMessageIdsForSubChatAtomFamily(SUB))).toEqual([
      `${ORPHAN_ANCHOR_PREFIX}${SUB}`,
      'u1',
    ]);

    const groups = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groups).toHaveLength(2);
    expect(groups[0].userMsgId).toMatch(new RegExp(`^${ORPHAN_ANCHOR_PREFIX}`));
    expect(groups[0].assistantMsgIds).toEqual(['a1']);
    expect(groups[1].userMsgId).toBe('u1');
    expect(groups[1].assistantMsgIds).toEqual(['a2']);
  });

  it('aggregates multiple leading assistant messages into one orphan group before first user', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '1' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '2' }] },
        { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: '3' }] },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });

    const groups = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groups).toHaveLength(2);
    expect(groups[0].userMsgId).toMatch(new RegExp(`^${ORPHAN_ANCHOR_PREFIX}`));
    expect(groups[0].assistantMsgIds).toEqual(['a1', 'a2', 'a3']);
    expect(groups[1].userMsgId).toBe('u1');
  });

  it('does NOT create orphan group when first message is user role', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] },
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });

    const userIds = appStore.get(userMessageIdsForSubChatAtomFamily(SUB));
    expect(userIds).toEqual(['u1']);

    const groups = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groups).toHaveLength(1);
    expect(groups[0].userMsgId).toBe('u1');
    expect(groups[0].assistantMsgIds).toEqual(['a1']);
  });

  it('does NOT create orphan when only system messages precede first user (no leading assistant)', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        { id: 's1', role: 'system', parts: [{ type: 'text', text: 'Context' }] },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] },
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });

    const userIds = appStore.get(userMessageIdsForSubChatAtomFamily(SUB));
    expect(userIds).toEqual(['u1']);

    const groups = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groups).toHaveLength(1);
    expect(groups[0].userMsgId).toBe('u1');
    expect(groups[0].assistantMsgIds).toEqual(['a1']);
  });

  it('creates orphan group when system precedes leading assistant before first user', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        { id: 's1', role: 'system', parts: [{ type: 'text', text: 'Context' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Orphan reply' }] },
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'Turn reply' }] },
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });

    const userIds = appStore.get(userMessageIdsForSubChatAtomFamily(SUB));
    expect(userIds).toEqual([`${ORPHAN_ANCHOR_PREFIX}${SUB}`, 'u1']);

    const groups = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groups).toHaveLength(2);
    expect(groups[0].userMsgId).toMatch(new RegExp(`^${ORPHAN_ANCHOR_PREFIX}`));
    expect(groups[0].assistantMsgIds).toEqual(['a1']);
    expect(groups[1].userMsgId).toBe('u1');
    expect(groups[1].assistantMsgIds).toEqual(['a2']);
  });
});

describe('prepend older messages and clearPrepended rollback cleanup', () => {
  const SUB = 'prepend-rollback-test';

  const msg = (id: string, role: 'user' | 'assistant') =>
    ({
      id,
      role,
      parts: [{ type: 'text', text: id }],
    }) as unknown as import('ai').UIMessage;

  beforeEach(() => {
    clearSubChatCaches(SUB);
    appStore.set(currentSubChatIdAtom, SUB);
  });

  it('merges prepended IDs before main IDs so display order is chronological', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user'), msg('m4', 'assistant')],
      status: 'ready',
      subChatId: SUB,
    });

    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    });

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('stacks multiple prepend batches in chronological order (newest batch first in array)', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user')],
      status: 'ready',
      subChatId: SUB,
    });

    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    });
    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m0', 'assistant')],
    });

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('clearPrependedForSubChat removes only prepended messages and invalidates derived caches', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user'), msg('m4', 'assistant')],
      status: 'ready',
      subChatId: SUB,
    });

    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    });

    expect(appStore.get(messageGroupsForSubChatAtomFamily(SUB))).toHaveLength(2);

    clearPrependedForSubChat(SUB);

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m3', 'm4']);
    expect(appStore.get(messageAtomFamily('m1'))).toBeNull();
    expect(appStore.get(messageAtomFamily('m2'))).toBeNull();
    expect(appStore.get(messageAtomFamily('m3'))).not.toBeNull();
    expect(appStore.get(messageAtomFamily('m4'))).not.toBeNull();

    const groupsAfter = appStore.get(messageGroupsForSubChatAtomFamily(SUB));
    expect(groupsAfter).toHaveLength(1);
    expect(groupsAfter[0].userMsgId).toBe('m3');
    expect(groupsAfter[0].assistantMsgIds).toEqual(['m4']);
  });

  it('does not change message order when prepending an empty batch', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user'), msg('m4', 'assistant')],
      status: 'ready',
      subChatId: SUB,
    });

    appStore.set(prependOlderMessagesAtom, { subChatId: SUB, messages: [] });

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m3', 'm4']);
  });

  it('clearPrependedForSubChat leaves main-window messages when nothing was prepended', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user'), msg('m4', 'assistant')],
      status: 'ready',
      subChatId: SUB,
    });

    clearPrependedForSubChat(SUB);

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m3', 'm4']);
    expect(appStore.get(messageAtomFamily('m3'))).not.toBeNull();
    expect(appStore.get(messageAtomFamily('m4'))).not.toBeNull();
  });

  it('skips ids already in main or prepended so display ids stay unique (avoids React key duplicates)', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user'), msg('m4', 'assistant')],
      status: 'ready',
      subChatId: SUB,
    });

    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    });
    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m3', 'assistant')],
    });

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('dedupes duplicate message ids within a single prepend batch (first occurrence wins)', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('m3', 'user')],
      status: 'ready',
      subChatId: SUB,
    });

    appStore.set(prependOlderMessagesAtom, {
      subChatId: SUB,
      messages: [msg('m1', 'user'), msg('m1', 'assistant'), msg('m2', 'assistant')],
    });

    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual(['m1', 'm2', 'm3']);
    expect(appStore.get(messageAtomFamily('m1'))?.role).toBe('user');
  });
});

describe('syncMessagesWithStatusAtom main id list', () => {
  const SUB = 'main-id-skip-test';

  const msg = (id: string, role: 'user' | 'assistant', text: string) =>
    ({
      id,
      role,
      parts: [{ type: 'text', text }],
    }) as unknown as import('ai').UIMessage;

  beforeEach(() => {
    clearSubChatCaches(SUB);
    appStore.set(currentSubChatIdAtom, SUB);
  });

  it('keeps the same perSubChatMainMessageIds array reference when only message content changes', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')],
      status: 'streaming',
      subChatId: SUB,
    });
    const idsAfterFirst = appStore.get(perSubChatMainMessageIdsAtomFamily(SUB));

    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello stream')],
      status: 'streaming',
      subChatId: SUB,
    });
    const idsAfterSecond = appStore.get(perSubChatMainMessageIdsAtomFamily(SUB));

    expect(idsAfterSecond).toBe(idsAfterFirst);
    expect(idsAfterSecond).toEqual(['u1', 'a1']);
  });

  it('replaces main ids when order or membership changes', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'hi')],
      status: 'ready',
      subChatId: SUB,
    });
    const idsOne = appStore.get(perSubChatMainMessageIdsAtomFamily(SUB));

    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'new')],
      status: 'streaming',
      subChatId: SUB,
    });
    const idsTwo = appStore.get(perSubChatMainMessageIdsAtomFamily(SUB));

    expect(idsTwo).not.toBe(idsOne);
    expect(idsTwo).toEqual(['u1', 'a1']);
  });

  it('EC3: after removing then re-adding messages with the same id list, main ids match and assistant atom is restored', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'a'), msg('a1', 'assistant', 'b')],
      status: 'ready',
      subChatId: SUB,
    });
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u1', 'a1']);
    expect(appStore.get(messageAtomFamily('a1'))?.parts?.[0]).toEqual(
      expect.objectContaining({ type: 'text', text: 'b' }),
    );

    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'a')],
      status: 'ready',
      subChatId: SUB,
    });
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u1']);
    expect(appStore.get(messageAtomFamily('a1'))).toBeNull();

    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user', 'a'), msg('a1', 'assistant', 'restored')],
      status: 'ready',
      subChatId: SUB,
    });
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u1', 'a1']);
    expect(appStore.get(messageAtomFamily('a1'))?.parts?.[0]).toEqual(
      expect.objectContaining({ type: 'text', text: 'restored' }),
    );
  });
});

describe('chatHasGitContextAtomFamily — split pane isolation', () => {
  it('each subChat has independent git context state', () => {
    const paneA = chatHasGitContextAtomFamily('sub-git');
    const paneB = chatHasGitContextAtomFamily('sub-general');

    // Pane A: git project chat sets true
    appStore.set(paneA, true);
    // Pane B: general chat sets false
    appStore.set(paneB, false);

    // Each pane retains its own value — no cross-contamination
    expect(appStore.get(paneA)).toBe(true);
    expect(appStore.get(paneB)).toBe(false);
  });

  it('setting one pane does not affect the other', () => {
    const paneA = chatHasGitContextAtomFamily('sub-A');
    const paneB = chatHasGitContextAtomFamily('sub-B');

    appStore.set(paneA, false);
    appStore.set(paneB, true);

    // Pane A stays false even though Pane B set true
    expect(appStore.get(paneA)).toBe(false);
    expect(appStore.get(paneB)).toBe(true);
  });
});

describe('isFirstUserMessageForSubChatAtomFamily', () => {
  const SUB = 'first-user-msg-test';

  const msg = (id: string, role: 'user' | 'assistant') =>
    ({
      id,
      role,
      parts: [{ type: 'text', text: id }],
    }) as unknown as import('ai').UIMessage;

  beforeEach(() => {
    clearSubChatCaches(SUB);
    appStore.set(currentSubChatIdAtom, SUB);
  });

  it('returns true for the first user message in a multi-message chat', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')],
      status: 'ready',
      subChatId: SUB,
    });

    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u1`))).toBe(true);
    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u2`))).toBe(false);
  });

  it('returns true when there is only one user message', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user'), msg('a1', 'assistant')],
      status: 'ready',
      subChatId: SUB,
    });

    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u1`))).toBe(true);
  });

  it('returns false for orphan anchor prefix (no real user message)', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('a1', 'assistant'), msg('u1', 'user')],
      status: 'ready',
      subChatId: SUB,
    });

    const userIds = appStore.get(userMessageIdsForSubChatAtomFamily(SUB));
    expect(userIds[0]).toMatch(new RegExp(`^${ORPHAN_ANCHOR_PREFIX}`));
    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u1`))).toBe(false);
  });

  it('is cleaned up by clearSubChatCaches', () => {
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u1', 'user')],
      status: 'ready',
      subChatId: SUB,
    });

    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u1`))).toBe(true);

    clearSubChatCaches(SUB);

    appStore.set(syncMessagesWithStatusAtom, {
      messages: [msg('u-new', 'user'), msg('u1', 'user')],
      status: 'ready',
      subChatId: SUB,
    });

    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u1`))).toBe(false);
    expect(appStore.get(isFirstUserMessageForSubChatAtomFamily(`${SUB}:u-new`))).toBe(true);
  });
});

describe('rollback filter', () => {
  const SUB = 'rollback-filter-test';
  const OTHER = 'rollback-filter-other';

  const msg = (id: string, role: 'user' | 'assistant') =>
    ({
      id,
      role,
      parts: [{ type: 'text', text: id }],
    }) as unknown as import('ai').UIMessage;

  beforeEach(() => {
    clearRollbackFilter(SUB);
    clearRollbackFilter(OTHER);
    clearSubChatCaches(SUB);
    clearSubChatCaches(OTHER);
    appStore.set(currentSubChatIdAtom, SUB);
  });

  describe('applyRollbackFilter', () => {
    it('returns the same array reference when no filter is set (no allocation cost)', () => {
      const messages = [msg('u1', 'user'), msg('a1', 'assistant')];
      const result = applyRollbackFilter(SUB, messages);
      expect(result).toBe(messages);
    });

    it('strips messages whose ids are in the filter', () => {
      setRollbackFilter(SUB, ['u1', 'a1']);
      const messages = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')];
      const result = applyRollbackFilter(SUB, messages);
      expect(result.map((m) => m.id)).toEqual(['u2']);
    });

    it('returns empty array when every message is filtered', () => {
      setRollbackFilter(SUB, ['u1', 'a1']);
      const result = applyRollbackFilter(SUB, [msg('u1', 'user'), msg('a1', 'assistant')]);
      expect(result).toEqual([]);
    });

    it('is isolated per subChatId — filter on one chat does not affect another (split-pane safety)', () => {
      setRollbackFilter(SUB, ['u1']);
      const result = applyRollbackFilter(OTHER, [msg('u1', 'user'), msg('u2', 'user')]);
      expect(result.map((m) => m.id)).toEqual(['u1', 'u2']);
    });
  });

  describe('setRollbackFilter', () => {
    it('accumulates ids across multiple calls (rapid sequential rollbacks)', () => {
      setRollbackFilter(SUB, ['u5', 'a5']);
      setRollbackFilter(SUB, ['u3', 'a3']);
      const messages = [
        msg('u3', 'user'),
        msg('a3', 'assistant'),
        msg('u5', 'user'),
        msg('a5', 'assistant'),
        msg('u7', 'user'),
      ];
      const result = applyRollbackFilter(SUB, messages);
      expect(result.map((m) => m.id)).toEqual(['u7']);
    });

    it('is a no-op when removedIds is empty (does not create an entry)', () => {
      setRollbackFilter(SUB, []);
      const messages = [msg('u1', 'user')];
      // No filter entry should be created — applyRollbackFilter must return identity
      expect(applyRollbackFilter(SUB, messages)).toBe(messages);
    });
  });

  describe('clearRollbackFilter', () => {
    it('removes the filter entry for a subChatId', () => {
      setRollbackFilter(SUB, ['u1']);
      clearRollbackFilter(SUB);
      const messages = [msg('u1', 'user')];
      expect(applyRollbackFilter(SUB, messages)).toBe(messages);
    });
  });

  describe('clearSubChatCaches', () => {
    it('also removes the rollback filter for the sub-chat', () => {
      setRollbackFilter(SUB, ['u1']);
      clearSubChatCaches(SUB);
      const messages = [msg('u1', 'user')];
      expect(applyRollbackFilter(SUB, messages)).toBe(messages);
    });

    // atomFamily.remove() drops the cached atom, so a fresh instance afterwards is the observable
    // proof of eviction — and catches a family whose .remove() call was dropped but survived.
    it('evicts every per-sub-chat atomFamily entry it is responsible for', () => {
      const families = {
        perSubChatMainMessageIds: perSubChatMainMessageIdsAtomFamily,
        perSubChatMessageIds: perSubChatMessageIdsAtomFamily,
        perSubChatStatus: perSubChatStatusAtomFamily,
        userMessageIdsForSubChat: userMessageIdsForSubChatAtomFamily,
        messageGroupsForSubChat: messageGroupsForSubChatAtomFamily,
        isStreamingForSubChat: isStreamingForSubChatAtomFamily,
        chatHasGitContext: chatHasGitContextAtomFamily,
      };

      const before = Object.fromEntries(
        Object.entries(families).map(([name, family]) => [name, family(SUB)]),
      );

      clearSubChatCaches(SUB);

      for (const [name, family] of Object.entries(families)) {
        expect(family(SUB), `${name} was not evicted`).not.toBe(before[name]);
      }
    });
  });

  describe('syncMessagesWithStatusAtom — filter integration', () => {
    it('strips filtered ids from the synced main id list', () => {
      // Pretend a rollback removed u1 and a1
      setRollbackFilter(SUB, ['u1', 'a1']);

      // useChat re-provides the rolled-back messages
      appStore.set(syncMessagesWithStatusAtom, {
        messages: [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')],
        status: 'ready',
        subChatId: SUB,
      });

      expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u2']);
    });

    it('does NOT clear the filter on an empty sync (regression: empty syncs would prematurely clear, then a stale non-empty sync would slip through)', () => {
      setRollbackFilter(SUB, ['u1']);

      // Empty sync (e.g. setMessages([]) call)
      appStore.set(syncMessagesWithStatusAtom, {
        messages: [],
        status: 'ready',
        subChatId: SUB,
      });

      // Stale re-sync arrives later from useChat with the rolled-back id
      appStore.set(syncMessagesWithStatusAtom, {
        messages: [msg('u1', 'user')],
        status: 'ready',
        subChatId: SUB,
      });

      // Filter must still be active — u1 stripped from the synced state
      expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual([]);
    });

    it('clears the filter when useChat catches up with a non-empty list that does not contain filtered ids', () => {
      setRollbackFilter(SUB, ['u1']);

      // useChat provides a fresh list without the rolled-back id — filter auto-clears
      appStore.set(syncMessagesWithStatusAtom, {
        messages: [msg('u2', 'user')],
        status: 'ready',
        subChatId: SUB,
      });

      // Now if u1 ever reappears (e.g. user re-creates a message with the same id),
      // it should NOT be filtered — the filter was cleared.
      appStore.set(syncMessagesWithStatusAtom, {
        messages: [msg('u1', 'user'), msg('u2', 'user')],
        status: 'ready',
        subChatId: SUB,
      });

      expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u1', 'u2']);
    });

    it('filter on one sub-chat does not strip ids from another sub-chat (split pane independence)', () => {
      setRollbackFilter(SUB, ['shared-id']);

      appStore.set(syncMessagesWithStatusAtom, {
        messages: [msg('shared-id', 'user'), msg('a1', 'assistant')],
        status: 'ready',
        subChatId: OTHER,
      });

      expect(appStore.get(perSubChatMainMessageIdsAtomFamily(OTHER))).toEqual(['shared-id', 'a1']);
    });
  });
});

describe('hiddenApprovalPlanIdsForSubChatAtomFamily', () => {
  const SUB = 'sub-hidden-test';

  type PlanPart = {
    type: 'tool-frink-plan';
    toolCallId: string;
    input: { planId: string; status: string; summary: string };
  };

  function planPart(callId: string, planId: string, status: string): PlanPart {
    return {
      type: 'tool-frink-plan',
      toolCallId: callId,
      input: { planId, status, summary: 's' },
    };
  }

  function setMessages(subChatId: string, parts: PlanPart[][]): void {
    const messages = parts.map((p, i) => ({
      id: `msg-${subChatId}-${i}`,
      role: 'assistant' as const,
      parts: p,
    }));
    appStore.set(syncMessagesWithStatusAtom, {
      messages: messages as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId,
    });
  }

  beforeEach(() => {
    appStore.set(currentSubChatIdAtom, SUB);
    appStore.set(approvedPlanIdsAtomFamily(SUB), new Set<string>());
    setMessages(SUB, []);
  });

  it('returns empty set for an unknown sub-chat with no messages', () => {
    expect(appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily('does-not-exist')).size).toBe(0);
  });

  it('returns empty set when no plan parts exist', () => {
    setMessages(SUB, [[]]);
    expect(appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB)).size).toBe(0);
  });

  it('returns empty set for a single awaiting_approval plan (no closed epoch yet)', () => {
    setMessages(SUB, [[planPart('call-1', 'plan-1', 'awaiting_approval')]]);
    expect(appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB)).size).toBe(0);
  });

  it.each(['approved', 'in_progress', 'completed'] as const)(
    'includes a plan whose status is %s',
    (status) => {
      setMessages(SUB, [[planPart('call-1', 'plan-1', status)]]);
      const hidden = appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB));
      expect(hidden.has('call-1')).toBe(true);
    },
  );

  it('includes a plan whose planId is in the approvedPlanIds atom (immediate signal)', () => {
    setMessages(SUB, [[planPart('call-1', 'plan-1', 'awaiting_approval')]]);
    appStore.set(approvedPlanIdsAtomFamily(SUB), new Set(['plan-1']));
    const hidden = appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB));
    expect(hidden.has('call-1')).toBe(true);
  });

  it('ignores plan parts that have no planId even when approvedPlanIds is non-empty', () => {
    const part: PlanPart = {
      type: 'tool-frink-plan',
      toolCallId: 'call-no-id',
      input: { planId: '', status: 'awaiting_approval', summary: 's' },
    };
    setMessages(SUB, [[part]]);
    appStore.set(approvedPlanIdsAtomFamily(SUB), new Set(['plan-1']));
    expect(appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB)).size).toBe(0);
  });

  it('hides plans BEFORE and AT the latest approved plan but leaves later plans visible (epoch boundary)', () => {
    setMessages(SUB, [
      [planPart('call-1', 'plan-1', 'awaiting_approval')],
      [planPart('call-2', 'plan-2', 'awaiting_approval')],
      [planPart('call-3', 'plan-3', 'awaiting_approval')],
    ]);
    // User approves plan-2 → status flips approved
    setMessages(SUB, [
      [planPart('call-1', 'plan-1', 'awaiting_approval')],
      [planPart('call-2', 'plan-2', 'approved')],
      [planPart('call-3', 'plan-3', 'awaiting_approval')],
    ]);
    const hidden = appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB));
    expect(hidden.has('call-1')).toBe(true);
    expect(hidden.has('call-2')).toBe(true);
    expect(hidden.has('call-3')).toBe(false);
  });

  it('hides a plan approved from another surface once its approval message arrives', () => {
    const plan = (callId: string, planId: string) => ({
      id: `msg-${callId}`,
      role: 'assistant' as const,
      parts: [planPart(callId, planId, 'awaiting_approval')],
    });
    appStore.set(syncMessagesWithStatusAtom, {
      messages: [
        plan('call-1', 'plan-1'),
        {
          id: 'approval',
          role: 'user',
          parts: [{ type: 'text', text: PLAN_APPROVAL_EXECUTION_TRIGGER_TEXT }],
        },
        plan('call-2', 'plan-2'),
      ] as unknown as import('ai').UIMessage[],
      status: 'ready',
      subChatId: SUB,
    });
    const hidden = appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB));
    expect([...hidden]).toEqual(['call-1']);
  });

  it('isolates state per sub-chat — approving in one sub-chat does not hide buttons in another', () => {
    const OTHER = 'sub-hidden-test-other';
    appStore.set(approvedPlanIdsAtomFamily(OTHER), new Set<string>());
    setMessages(SUB, [[planPart('call-a', 'plan-a', 'approved')]]);
    setMessages(OTHER, [[planPart('call-b', 'plan-b', 'awaiting_approval')]]);

    expect(appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(SUB)).has('call-a')).toBe(true);
    expect(appStore.get(hiddenApprovalPlanIdsForSubChatAtomFamily(OTHER)).size).toBe(0);
  });
});

// The only real coverage of this derivation — the component tests mock it out, and it became the
// sole source of streaming truth once sc-3372 deleted the write-only streaming-id atoms.
describe('isStreamingForSubChatAtomFamily — derivation and split-pane isolation', () => {
  const SUB = 'streaming-derivation';
  const OTHER = 'streaming-derivation-other';

  const msg = (id: string, role: 'user' | 'assistant'): import('ai').UIMessage => ({
    id,
    role,
    parts: [{ type: 'text', text: id }],
  });

  const sync = (subChatId: string, status: string, ids: [string, 'user' | 'assistant'][]) =>
    appStore.set(syncMessagesWithStatusAtom, {
      messages: ids.map(([id, role]) => msg(id, role)),
      status,
      subChatId,
    });

  beforeEach(() => {
    clearSubChatCaches(SUB);
    clearSubChatCaches(OTHER);
    appStore.set(currentSubChatIdAtom, SUB);
  });

  it.each([
    ['streaming', true],
    ['submitted', true],
    ['ready', false],
    ['error', false],
  ])('reports status %s as streaming=%s', (status, expected) => {
    sync(SUB, status, [['u1', 'user']]);
    expect(appStore.get(isStreamingForSubChatAtomFamily(SUB))).toBe(expected);
  });

  it('returns to not-streaming once a completed stream settles to ready', () => {
    sync(SUB, 'streaming', [
      ['u1', 'user'],
      ['a1', 'assistant'],
    ]);
    expect(appStore.get(isStreamingForSubChatAtomFamily(SUB))).toBe(true);

    sync(SUB, 'ready', [
      ['u1', 'user'],
      ['a1', 'assistant'],
    ]);
    expect(appStore.get(isStreamingForSubChatAtomFamily(SUB))).toBe(false);
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u1', 'a1']);
  });

  it('keeps each pane’s streaming state independent when two sub-chats interleave', () => {
    sync(SUB, 'streaming', [['u1', 'user']]);
    sync(OTHER, 'ready', [['o1', 'user']]);

    // Syncing the second pane must not settle the first one.
    expect(appStore.get(isStreamingForSubChatAtomFamily(SUB))).toBe(true);
    expect(appStore.get(isStreamingForSubChatAtomFamily(OTHER))).toBe(false);

    // ...and the reverse: the second pane streaming must not disturb the first.
    sync(OTHER, 'streaming', [
      ['o1', 'user'],
      ['o2', 'assistant'],
    ]);
    sync(SUB, 'ready', [['u1', 'user']]);

    expect(appStore.get(isStreamingForSubChatAtomFamily(SUB))).toBe(false);
    expect(appStore.get(isStreamingForSubChatAtomFamily(OTHER))).toBe(true);
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual(['u1']);
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(OTHER))).toEqual(['o1', 'o2']);
  });

  it('treats an empty message list under a streaming status as streaming with no ids', () => {
    sync(SUB, 'streaming', []);

    expect(appStore.get(isStreamingForSubChatAtomFamily(SUB))).toBe(true);
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(SUB))).toEqual([]);
    expect(appStore.get(perSubChatMessageIdsAtomFamily(SUB))).toEqual([]);
  });

  it('clearing one sub-chat leaves the other sub-chat’s atomFamily entries intact', () => {
    sync(SUB, 'streaming', [['u1', 'user']]);
    sync(OTHER, 'streaming', [['o1', 'user']]);

    const otherBefore = {
      ids: perSubChatMainMessageIdsAtomFamily(OTHER),
      status: perSubChatStatusAtomFamily(OTHER),
      isStreaming: isStreamingForSubChatAtomFamily(OTHER),
    };

    clearSubChatCaches(SUB);

    // Over-eviction would silently reset the surviving pane in split view.
    expect(perSubChatMainMessageIdsAtomFamily(OTHER)).toBe(otherBefore.ids);
    expect(perSubChatStatusAtomFamily(OTHER)).toBe(otherBefore.status);
    expect(isStreamingForSubChatAtomFamily(OTHER)).toBe(otherBefore.isStreaming);
    expect(appStore.get(isStreamingForSubChatAtomFamily(OTHER))).toBe(true);
    expect(appStore.get(perSubChatMainMessageIdsAtomFamily(OTHER))).toEqual(['o1']);
  });
});
