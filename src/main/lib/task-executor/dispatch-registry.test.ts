import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearActiveFlowTaskForChat,
  clearActiveFlowTaskForChatIfMatches,
  consumeDispatchMode,
  getActiveFlowTaskForChat,
  getDispatchedSubChatForTask,
  matchDispatchModeForSend,
  registerPendingDispatchMode,
  resolveFlowContinuationExecutionTask,
  setActiveFlowTaskForChat,
} from './dispatch-registry';
import {
  _clearActiveExecutionsForTests,
  _registerExecutionForTests,
} from '../socket/streaming/execution-registry';

const ACTIVE_FLOW_CHAT_ID = 'active-flow-chat-test-id';
const ACTIVE_FLOW_CHAT_B = 'active-flow-chat-test-b';

describe('activeFlowTaskForChat', () => {
  afterEach(() => {
    clearActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID);
    clearActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_B);
  });

  it('returns null when unset', () => {
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBeNull();
  });

  it('returns the registered continuation task id and clears on clearActiveFlowTaskForChat', () => {
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, 'continuation-task-id');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBe('continuation-task-id');
    clearActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID);
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBeNull();
  });

  it('clearActiveFlowTaskForChatIfMatches removes only when task id still matches', () => {
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, 'task-a');
    clearActiveFlowTaskForChatIfMatches(ACTIVE_FLOW_CHAT_ID, 'task-b');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBe('task-a');
    clearActiveFlowTaskForChatIfMatches(ACTIVE_FLOW_CHAT_ID, 'task-a');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBeNull();
  });

  it('overwrites the task id when the same chat is registered again (sequential continuation claims)', () => {
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, 'first-continuation');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBe('first-continuation');
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, 'second-continuation');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBe('second-continuation');
  });

  it('keeps independent entries per chat id (multi-chat / multi-pane)', () => {
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, 'task-for-chat-a');
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_B, 'task-for-chat-b');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBe('task-for-chat-a');
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_B)).toBe('task-for-chat-b');
    clearActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID);
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID)).toBeNull();
    expect(getActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_B)).toBe('task-for-chat-b');
  });
});

describe('resolveFlowContinuationExecutionTask', () => {
  afterEach(() => {
    clearActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID);
  });

  it('uses chat row task when expectedFlowTaskId is absent', () => {
    expect(
      resolveFlowContinuationExecutionTask({
        chatId: ACTIVE_FLOW_CHAT_ID,
        chatRowTaskId: 'row-task',
        expectedFlowTaskId: undefined,
      }),
    ).toEqual({ taskIdForExecution: 'row-task', flowContinuationClearId: null });
  });

  it('overrides when in-memory map matches expectedFlowTaskId', () => {
    const tid = '550e8400-e29b-41d4-a716-446655440001';
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, tid);
    expect(
      resolveFlowContinuationExecutionTask({
        chatId: ACTIVE_FLOW_CHAT_ID,
        chatRowTaskId: 'stale-row',
        expectedFlowTaskId: tid,
      }),
    ).toEqual({ taskIdForExecution: tid, flowContinuationClearId: tid });
  });

  it('keeps chat row task when expectedFlowTaskId does not match map', () => {
    setActiveFlowTaskForChat(ACTIVE_FLOW_CHAT_ID, '550e8400-e29b-41d4-a716-446655440001');
    expect(
      resolveFlowContinuationExecutionTask({
        chatId: ACTIVE_FLOW_CHAT_ID,
        chatRowTaskId: 'row-task',
        expectedFlowTaskId: '660e8400-e29b-41d4-a716-446655440002',
      }),
    ).toEqual({ taskIdForExecution: 'row-task', flowContinuationClearId: null });
  });
});

describe('pendingDispatchMode', () => {
  const SUB_CHAT_A = 'dispatch-mode-sub-chat-a';
  const SUB_CHAT_B = 'dispatch-mode-sub-chat-b';
  const TASK_ID = 'task-dispatch-1';

  afterEach(() => {
    consumeDispatchMode(SUB_CHAT_A, TASK_ID);
    consumeDispatchMode(SUB_CHAT_A, 'task-dispatch-2');
    consumeDispatchMode(SUB_CHAT_B, TASK_ID);
  });

  it('binds a send carrying the registered dispatch task id to the task-resolved mode', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBe('plan');
  });

  it('maps execute startMode to agent chat mode', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'execute');
    expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBe('agent');
  });

  it('never binds a send without a dispatch id (user replies keep intent/row resolution)', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    expect(matchDispatchModeForSend(SUB_CHAT_A, undefined)).toBeNull();
  });

  it('never binds a send carrying a different dispatch id', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    expect(matchDispatchModeForSend(SUB_CHAT_A, 'some-other-task')).toBeNull();
  });

  // Match is a PEEK so a matched-then-failed row write leaves the record for the retry;
  // the caller settles it with consumeDispatchMode only after the write lands.
  it('a match peeks; consumeDispatchMode settles it; a settled record never re-binds', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBe('plan');
    expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBe('plan');
    consumeDispatchMode(SUB_CHAT_A, TASK_ID);
    expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBeNull();
  });

  // Per-(subChatId, taskId) keying: a consume settles only its own record, and overlapping
  // dispatches into one reused sub-chat each keep their binding.
  it('a consume settles only its own record; a newer dispatch record survives', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    registerPendingDispatchMode(SUB_CHAT_A, 'task-dispatch-2', 'execute');
    consumeDispatchMode(SUB_CHAT_A, TASK_ID);
    expect(matchDispatchModeForSend(SUB_CHAT_A, 'task-dispatch-2')).toBe('agent');
  });

  it('an unconsumed record expires (memory hygiene)', () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
      nowSpy.mockReturnValue(now + 16 * 60 * 1000);
      expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('overlapping dispatches into one sub-chat each bind their own send', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    registerPendingDispatchMode(SUB_CHAT_A, 'task-dispatch-2', 'execute');
    expect(matchDispatchModeForSend(SUB_CHAT_A, TASK_ID)).toBe('plan');
    expect(matchDispatchModeForSend(SUB_CHAT_A, 'task-dispatch-2')).toBe('agent');
  });

  it('scopes records per sub-chat: a record for A never applies to B', () => {
    registerPendingDispatchMode(SUB_CHAT_A, TASK_ID, 'plan');
    expect(matchDispatchModeForSend(SUB_CHAT_B, TASK_ID)).toBeNull();
  });
});

describe('dispatchedSubChatByTask (sc-3263 cancel reach)', () => {
  it('records the sub-chat a task was dispatched into; a re-dispatch overwrites it', () => {
    registerPendingDispatchMode('sc-first', 'task-reach-1', 'execute');
    expect(getDispatchedSubChatForTask('task-reach-1')).toBe('sc-first');
    registerPendingDispatchMode('sc-second', 'task-reach-1', 'execute');
    expect(getDispatchedSubChatForTask('task-reach-1')).toBe('sc-second');
    consumeDispatchMode('sc-first', 'task-reach-1');
    consumeDispatchMode('sc-second', 'task-reach-1');
    // Consuming the send-mode binding must not forget where the task's turn runs.
    expect(getDispatchedSubChatForTask('task-reach-1')).toBe('sc-second');
  });

  it('returns null for a task that never dispatched', () => {
    expect(getDispatchedSubChatForTask('task-never')).toBeNull();
  });

  it('over the soft cap, prunes only settled entries; a live turn is never evicted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      registerPendingDispatchMode('sc-live', 'task-live', 'execute');
      _registerExecutionForTests('sc-live', new AbortController()); // still streaming
      registerPendingDispatchMode('sc-done', 'task-done', 'execute'); // turn ended, no execution
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z')); // both settled by age
      for (let i = 0; i < 500; i += 1) {
        registerPendingDispatchMode(`sc-cap-${i}`, `task-cap-${i}`, 'execute');
        consumeDispatchMode(`sc-cap-${i}`, `task-cap-${i}`);
      }
      expect(getDispatchedSubChatForTask('task-live')).toBe('sc-live');
      expect(getDispatchedSubChatForTask('task-done')).toBeNull();
      // Fresh (unsettled) entries are kept even over the cap: their turn may not have started yet.
      expect(getDispatchedSubChatForTask('task-cap-0')).toBe('sc-cap-0');
      expect(getDispatchedSubChatForTask('task-cap-499')).toBe('sc-cap-499');
    } finally {
      vi.useRealTimers();
      _clearActiveExecutionsForTests();
      consumeDispatchMode('sc-live', 'task-live');
      consumeDispatchMode('sc-done', 'task-done');
    }
  });
});
