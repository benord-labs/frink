import { beforeEach, describe, expect, it } from 'vitest';
import { getRuntimeTopologySnapshot } from '../../diagnostics/provider-topology';
import {
  _clearActiveExecutionsForTests,
  deleteActiveExecution,
  getExecutionOwner,
  listSubChatIdsForChat,
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

// Chat delete/archive stop a chat's turns from this list when the DB sub-chat lookup fails.
describe('listSubChatIdsForChat', () => {
  it("returns only that chat's live sub-chats", () => {
    const presentation = (chatId: string) => ({ chatId, assistantMessageId: 'm' });
    setActiveExecution('sub-a', new AbortController(), undefined, presentation('c1'));
    setActiveExecution('sub-b', new AbortController(), undefined, presentation('c1'));
    setActiveExecution('sub-other', new AbortController(), undefined, presentation('c2'));
    setActiveExecution('sub-untagged', new AbortController());

    expect(listSubChatIdsForChat('c1')).toEqual(['sub-a', 'sub-b']);
    expect(listSubChatIdsForChat('c3')).toEqual([]);
  });
});
