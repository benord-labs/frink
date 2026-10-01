import { beforeEach, describe, expect, it } from 'vitest';
import { getRuntimeTopologySnapshot } from '../../diagnostics/provider-topology';
import {
  _clearActiveExecutionsForTests,
  deleteActiveExecution,
  getExecutionOwner,
  closeAdmission,
  doomAdmissionsForChat,
  listSubChatIdsForChat,
  openAdmission,
  releaseExecutionOwnershipForWebContents,
  setActiveExecution,
} from './execution-registry';

const ownerless = (): number => getRuntimeTopologySnapshot().ownerlessExecutionCount;
const active = (): number => getRuntimeTopologySnapshot().activeExecutionCount;

beforeEach(() => _clearActiveExecutionsForTests());

describe('ownerless execution count', () => {
  it('is zero when nothing is running', () => {
    expect(ownerless()).toBe(0);
  });

  it('counts a run started without a window — a wake burst or main-initiated turn', () => {
    // No localRendererWebContentsId, so getExecutionOwner returns undefined and EVERY window,
    // including the focused one, repaints from checkpoints.
    setActiveExecution('sub-burst', new AbortController());

    expect(ownerless()).toBe(1);
    expect(active()).toBe(1);
  });

  it('does not count an ordinary user-typed send, which registers its window', () => {
    setActiveExecution('sub-typed', new AbortController(), 42);

    expect(getExecutionOwner('sub-typed')).toBe(42);
    expect(ownerless()).toBe(0);
    expect(active()).toBe(1);
  });

  it('starts counting a run whose window reloaded out from under it', () => {
    setActiveExecution('sub-reloaded', new AbortController(), 42);
    expect(ownerless()).toBe(0);

    releaseExecutionOwnershipForWebContents(42);

    expect(ownerless()).toBe(1);
    expect(active()).toBe(1);
  });

  it('releases only the reloading window, leaving a second pane owning its own run', () => {
    // Multi-pane: one window reloading must not push another window's run onto the observer lane.
    setActiveExecution('sub-a', new AbortController(), 42);
    setActiveExecution('sub-b', new AbortController(), 99);

    releaseExecutionOwnershipForWebContents(42);

    expect(ownerless()).toBe(1);
    expect(getExecutionOwner('sub-b')).toBe(99);
  });

  it('drops to zero once the ownerless run finishes', () => {
    setActiveExecution('sub-burst', new AbortController());
    deleteActiveExecution('sub-burst');

    expect(ownerless()).toBe(0);
    expect(active()).toBe(0);
  });
});

describe('listSubChatIdsForChat', () => {
  const presentation = (chatId: string) => ({ chatId, assistantMessageId: `msg-${chatId}` });

  it('returns only the sub-chats whose run belongs to the chat, across tabs', () => {
    setActiveExecution('tab-1', new AbortController(), 1, presentation('chat-a'));
    setActiveExecution('tab-2', new AbortController(), 2, presentation('chat-a'));
    setActiveExecution('other', new AbortController(), 1, presentation('chat-b'));

    expect(listSubChatIdsForChat('chat-a').sort()).toEqual(['tab-1', 'tab-2']);
  });

  it('never matches a run registered without a chat id', () => {
    // Archive sweeps by chat id; a chatless record must not be swept up by an empty-string chat.
    setActiveExecution('chatless', new AbortController());

    expect(listSubChatIdsForChat('')).toEqual([]);
    expect(listSubChatIdsForChat('chat-a')).toEqual([]);
  });

  it('stops listing a run once it is deleted', () => {
    setActiveExecution('tab-1', new AbortController(), 1, presentation('chat-a'));
    deleteActiveExecution('tab-1');

    expect(listSubChatIdsForChat('chat-a')).toEqual([]);
  });
});

describe('admission tokens', () => {
  it('dooms only the open admissions of the archived chat', () => {
    const archivedChat = openAdmission('chat-a');
    const otherChat = openAdmission('chat-b');

    doomAdmissionsForChat('chat-a');

    expect(archivedChat.doomed).toBe(true);
    expect(otherChat.doomed).toBe(false);
  });

  it('does not doom an admission that already closed, or one opened after the archive', () => {
    const closed = openAdmission('chat-a');
    closeAdmission(closed);

    doomAdmissionsForChat('chat-a');
    const later = openAdmission('chat-a');

    expect(closed.doomed).toBe(false);
    // Opened after archived_at landed: its own row read will see the archive.
    expect(later.doomed).toBe(false);
  });

  it('forgets open admissions on the test reset, so none leak between suites', () => {
    const open = openAdmission('chat-a');
    _clearActiveExecutionsForTests();

    doomAdmissionsForChat('chat-a');
    expect(open.doomed).toBe(false);
  });
});
