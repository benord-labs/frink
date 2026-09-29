// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Seam tests for the Chat factory's completion/error side-effects. The
 * away/visibility matrix itself lives in completion-effects.test.ts — here we
 * pin what the factory DOES with the verdict: which sound plays for which
 * outcome, the sound-toggle gate, and the abort-flag read/clear contract
 * between onError and onFinish.
 */
const mocks = vi.hoisted(() => ({
  chatOptions: null as null | {
    onError: () => void;
    onFinish: () => void;
  },
  playSound: vi.fn(),
  resolveCompletionEffects: vi.fn(),
  appStoreGet: vi.fn((_atom: unknown): unknown => true),
  appStoreSet: vi.fn(),
  wasManuallyAborted: vi.fn(() => false),
  wasTornDown: vi.fn(() => false),
  clearManuallyAborted: vi.fn(),
  setStatus: vi.fn(),
  flowChatIds: new Set<string>(),
  deferred: new Map<string, () => void>(),
}));

vi.mock('@ai-sdk/react', () => ({
  Chat: class {
    constructor(options: never) {
      mocks.chatOptions = options;
    }
  },
}));

vi.mock('./websocket-chat-transport', () => ({
  WebSocketChatTransport: class {},
}));

vi.mock('../../../lib/jotai-store', () => ({
  appStore: { get: mocks.appStoreGet, set: mocks.appStoreSet },
}));

vi.mock('../../../lib/audio/play-chime', () => ({
  playSound: mocks.playSound,
}));

vi.mock('./completion-effects', () => ({
  resolveCompletionEffects: mocks.resolveCompletionEffects,
}));

vi.mock('../stores/agent-chat-store', () => ({
  agentChatStore: {
    set: vi.fn(),
    setStreamId: vi.fn(),
    wasManuallyAborted: mocks.wasManuallyAborted,
    wasTornDown: mocks.wasTornDown,
    clearManuallyAborted: mocks.clearManuallyAborted,
    // Real Set: the factory reads flow-driven-ness LIVE at finish time.
    markFlowChat: (chatId: string) => mocks.flowChatIds.add(chatId),
    isFlowChat: (chatId: string) => mocks.flowChatIds.has(chatId),
  },
}));

vi.mock('../stores/streaming-status-store', () => ({
  useStreamingStatusStore: { getState: () => ({ setStatus: mocks.setStatus }) },
}));

vi.mock('../stores/sub-chat-store', () => ({
  useAgentSubChatStore: { getState: () => ({ chatId: null, activeSubChatId: null }) },
}));

vi.mock('../../sidebar/unified/sidebar-chat-activity', () => ({
  notifySidebarChatActivity: vi.fn(),
}));

vi.mock('../../../lib/utils/platform', () => ({
  isDesktopApp: () => true,
}));

// Captured rather than real: `fireWaitOver` stands in for main's wait-over retraction.
vi.mock('../../../lib/stores/use-wake-hold-sync', () => ({
  deferUntilWaitOver: (subChatId: string, fire: () => void) => mocks.deferred.set(subChatId, fire),
}));

import { soundNotificationsEnabledAtom } from '../../../lib/atoms';
import { wakeHeldAtomFamily } from '../../../lib/stores/active-transport-registry';
import { agentsSubChatUnseenChangesAtom, loadingSubChatsAtom } from '../atoms';
import { flowRunIncompleteAtomFamily } from '../stores/message-store';
import { createAgentChat } from './create-agent-chat';

/** Atom-aware store read: structural atoms get real shapes, flags get booleans. */
function storeGet(soundEnabled: boolean, flowRunIncomplete = false, held = false) {
  return (atom: unknown) => {
    if (atom === loadingSubChatsAtom) return new Map();
    if (atom === soundNotificationsEnabledAtom) return soundEnabled;
    if (atom === flowRunIncompleteAtomFamily('sub-1')) return flowRunIncomplete;
    if (atom === wakeHeldAtomFamily('sub-1')) return held ? { waitingOn: ['Monitor'] } : null;
    return true;
  };
}

const EFFECTS_ON = { markSubChatUnseen: false, markChatUnseen: false, notifyCompletion: true };
const EFFECTS_OFF = { markSubChatUnseen: false, markChatUnseen: false, notifyCompletion: false };

function buildChat(params: Partial<Parameters<typeof createAgentChat>[0]> = {}) {
  const notifyComplete = vi.fn();
  createAgentChat({
    chatId: 'chat-1',
    subChatId: 'sub-1',
    projectId: 'proj-1',
    mode: 'agent' as never,
    initialMessages: [],
    getExecutionAccountType: () => 'claude' as never,
    notifyComplete,
    ...params,
  });
  if (!mocks.chatOptions) throw new Error('Chat constructor not captured');
  return { options: mocks.chatOptions, notifyComplete };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatOptions = null;
  mocks.flowChatIds.clear();
  mocks.deferred.clear();
  mocks.appStoreGet.mockImplementation(storeGet(true));
  mocks.wasManuallyAborted.mockReturnValue(false);
  mocks.wasTornDown.mockReturnValue(false);
  mocks.resolveCompletionEffects.mockReturnValue(EFFECTS_ON);
});

describe('onFinish — completion sound seam', () => {
  it('plays turnComplete and fires the OS notification when notifying', () => {
    const { options, notifyComplete } = buildChat();
    options.onFinish();
    expect(mocks.playSound).toHaveBeenCalledExactlyOnceWith('turnComplete');
    expect(notifyComplete).toHaveBeenCalledExactlyOnceWith('sub-1');
  });

  it('keeps the OS notification when the sound toggle is off', () => {
    mocks.appStoreGet.mockImplementation(storeGet(false));
    const { options, notifyComplete } = buildChat();
    options.onFinish();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(notifyComplete).toHaveBeenCalledTimes(1);
  });

  it('stays fully silent when effects say do not notify', () => {
    mocks.resolveCompletionEffects.mockReturnValue(EFFECTS_OFF);
    const { options, notifyComplete } = buildChat();
    options.onFinish();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(notifyComplete).not.toHaveBeenCalled();
  });

  it('a torn-down Chat instance finishes without touching the sub-chat state its replacement owns', () => {
    // The deferred teardown close makes this instance finish while a re-created Chat may already
    // stream on the same sub-chat: no chime, no status write, no abort-flag clear, no loading clear.
    mocks.wasTornDown.mockReturnValue(true);
    const { options, notifyComplete } = buildChat();
    options.onError();
    options.onFinish();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(notifyComplete).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.clearManuallyAborted).not.toHaveBeenCalled();
    expect(mocks.appStoreSet).not.toHaveBeenCalled();
  });

  it('clears the manual-abort flag (finish owns the clear)', () => {
    const { options } = buildChat();
    options.onFinish();
    expect(mocks.clearManuallyAborted).toHaveBeenCalledExactlyOnceWith('sub-1');
  });
});

// A turn that leaves background work running has not finished: its chime, OS notification and
// unseen marks wait for the wait itself to end, and resolve against the view at that moment.
describe('onFinish — a held turn defers its completion effects to the wait-over', () => {
  const AWAY = { markSubChatUnseen: true, markChatUnseen: true, notifyCompletion: true };
  const fireWaitOver = () => mocks.deferred.get('sub-1')?.();
  const unseenWrites = () =>
    mocks.appStoreSet.mock.calls.filter(([atom]) => atom === agentsSubChatUnseenChangesAtom);

  beforeEach(() => {
    mocks.appStoreGet.mockImplementation(storeGet(true, false, true));
    mocks.resolveCompletionEffects.mockReturnValue(AWAY);
  });

  it('stays silent at turn end but still releases the queue, then chimes once at the wait-over', () => {
    const onFinishExtra = vi.fn();
    const { options, notifyComplete } = buildChat({ onFinishExtra });
    options.onFinish();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(notifyComplete).not.toHaveBeenCalled();
    expect(unseenWrites()).toHaveLength(0);
    expect(mocks.setStatus).toHaveBeenCalledWith('sub-1', 'ready');
    expect(onFinishExtra).toHaveBeenCalledOnce();

    fireWaitOver();
    expect(mocks.playSound).toHaveBeenCalledExactlyOnceWith('turnComplete');
    expect(notifyComplete).toHaveBeenCalledExactlyOnceWith('sub-1');
    expect(unseenWrites()).toHaveLength(1);
  });

  it('resolves the view when the wait ends, so a chat opened meanwhile neither chimes nor marks', () => {
    const { options, notifyComplete } = buildChat();
    options.onFinish();
    mocks.resolveCompletionEffects.mockReturnValue(EFFECTS_OFF); // the user opened the chat
    fireWaitOver();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(notifyComplete).not.toHaveBeenCalled();
    expect(unseenWrites()).toHaveLength(0);
  });

  it('never plays turnComplete at the wait-over of a turn that errored', () => {
    const { options, notifyComplete } = buildChat();
    options.onError();
    options.onFinish();
    fireWaitOver();
    expect(mocks.playSound.mock.calls).toEqual([['failed']]);
    expect(notifyComplete).not.toHaveBeenCalled();
  });

  it('stays silent at the wait-over of a flow-driven chat', () => {
    mocks.resolveCompletionEffects.mockImplementation((ctx: { isFlowDriven: boolean }) => ({
      ...AWAY,
      notifyCompletion: !ctx.isFlowDriven,
    }));
    mocks.flowChatIds.add('chat-1');
    const { options } = buildChat();
    options.onFinish();
    fireWaitOver();
    expect(mocks.playSound).not.toHaveBeenCalled();
  });
});

describe('onError — failure sound seam', () => {
  it('plays the failed sound when the effects verdict notifies', () => {
    const { options } = buildChat();
    options.onError();
    expect(mocks.playSound).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('never plays turnComplete from the error path', () => {
    const { options } = buildChat();
    options.onError();
    expect(mocks.playSound).not.toHaveBeenCalledWith('turnComplete');
  });

  it('is silent when the sound toggle is off', () => {
    mocks.appStoreGet.mockImplementation(storeGet(false));
    const { options } = buildChat();
    options.onError();
    expect(mocks.playSound).not.toHaveBeenCalled();
  });

  it('is silent when effects say do not notify (viewing / aborted / flow-driven)', () => {
    mocks.resolveCompletionEffects.mockReturnValue(EFFECTS_OFF);
    const { options } = buildChat();
    options.onError();
    expect(mocks.playSound).not.toHaveBeenCalled();
  });

  it('reads the abort flag WITHOUT clearing it — onFinish still owns the clear', () => {
    mocks.wasManuallyAborted.mockReturnValue(true);
    const { options } = buildChat();
    options.onError();
    expect(mocks.clearManuallyAborted).not.toHaveBeenCalled();
    expect(mocks.resolveCompletionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ wasManuallyAborted: true }),
    );
  });

  it('threads isFlowDriven through so flow turns defer to run_failed', () => {
    mocks.flowChatIds.add('chat-1');
    const { options } = buildChat();
    options.onError();
    expect(mocks.resolveCompletionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ isFlowDriven: true }),
    );
  });

  it('still releases the queue: streaming status resets to ready', () => {
    const { options } = buildChat();
    options.onError();
    expect(mocks.setStatus).toHaveBeenCalledWith('sub-1', 'ready');
  });
});

describe('isFlowDriven — read LIVE at finish, never a creation-time snapshot', () => {
  it('a Chat created before the flow linked its chat goes silent once the chat is marked', () => {
    // The poison this fixes: ActiveChat builds the Chat for a continue_chat flow before the
    // flow's first dispatch links it. The mark arrives later (headless task:chat-ready) and
    // must apply to the ALREADY-CREATED Chat — a frozen constructor param cannot.
    const { options } = buildChat();
    options.onFinish();
    expect(mocks.resolveCompletionEffects).toHaveBeenLastCalledWith(
      expect.objectContaining({ isFlowDriven: false }),
    );

    mocks.flowChatIds.add('chat-1');
    options.onFinish();
    expect(mocks.resolveCompletionEffects).toHaveBeenLastCalledWith(
      expect.objectContaining({ isFlowDriven: true }),
    );
  });

  it('an unmarked chat with no live flow run reports isFlowDriven false (non-flow pings stay)', () => {
    const { options } = buildChat();
    options.onFinish();
    expect(mocks.resolveCompletionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ isFlowDriven: false }),
    );
  });

  it('a live incomplete flow run suppresses even without a mark (post-reload stream-resume)', () => {
    mocks.appStoreGet.mockImplementation(storeGet(true, true));
    const { options } = buildChat();
    options.onFinish();
    expect(mocks.resolveCompletionEffects).toHaveBeenCalledWith(
      expect.objectContaining({ isFlowDriven: true }),
    );
  });
});

describe('onError → onFinish — the SDK finally-contract', () => {
  it('an errored turn plays ONLY failed; the trailing onFinish neither sounds nor notifies', () => {
    // The `ai` SDK invokes onFinish in a finally block, so it always follows
    // onError. Without suppression this played 'failed' then 'turnComplete'.
    const { options, notifyComplete } = buildChat();
    options.onError();
    options.onFinish();
    expect(mocks.playSound.mock.calls).toEqual([['failed']]);
    expect(notifyComplete).not.toHaveBeenCalled();
  });

  it('the suppression is per-turn: the next clean finish sounds again', () => {
    const { options, notifyComplete } = buildChat();
    options.onError();
    options.onFinish(); // errored turn — consumed the flag
    options.onFinish(); // next turn, clean
    expect(mocks.playSound.mock.calls).toEqual([['failed'], ['turnComplete']]);
    expect(notifyComplete).toHaveBeenCalledTimes(1);
  });

  it('an error on a Chat torn down before its finish never mutes its replacement', () => {
    const { options: torn } = buildChat();
    torn.onError();
    mocks.wasTornDown.mockReturnValue(true);
    torn.onFinish(); // skipped: the instance is torn down, its error flag is never consumed
    mocks.wasTornDown.mockReturnValue(false);
    const { options: replacement, notifyComplete } = buildChat(); // same sub-chat, new instance
    replacement.onFinish();
    expect(mocks.playSound.mock.calls).toEqual([['failed'], ['turnComplete']]);
    expect(notifyComplete).toHaveBeenCalledTimes(1);
  });
});
