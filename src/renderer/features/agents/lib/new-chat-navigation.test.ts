// @vitest-environment happy-dom
/* eslint-disable project-structure/folder-structure */
import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_DEFAULT_MODEL_ID } from '../../../../shared/lib/codex-cli-models';
import { codexSpeedAtomFamily } from '../../../lib/atoms/codex-speed';
import {
  activeOverlayAtom,
  agentsSettingsDialogOpenAtom,
  flowsSelectedFlowIdAtom,
} from '../../../lib/atoms';
import {
  agentsMobileViewModeAtom,
  autoModePerChatAtomFamily,
  chatModeAtomFamily,
  justCreatedIdsAtom,
  lastSelectedModelIdAtom,
  lastSelectedModelIdAtomFamily,
  NEW_CHAT_PANE,
  newChatPaneProjectMapAtom,
  type SplitViewState,
  selectedAgentChatIdAtom,
  splitViewAtom,
} from '../atoms';
import { newChatDraftKey, readDraft, writeDraft } from './drafts';
import {
  createNewChatStaging,
  seedNewChatNavigation,
  seedNewChatPromptAtom,
} from './new-chat-navigation';

function freshStore() {
  const store = createStore();
  store.set(lastSelectedModelIdAtom, 'sonnet'); // a known Claude model id
  return store;
}

describe('seedNewChatNavigation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('single-pane: selects the chat and seeds its model/mode + just-created set', () => {
    const store = freshStore();

    seedNewChatNavigation(store.get, store.set, 'chat-1', {
      isCodexAccount: false,
    });

    expect(store.get(selectedAgentChatIdAtom)).toBe('chat-1');
    expect(store.get(justCreatedIdsAtom).has('chat-1')).toBe(true);
    expect(store.get(chatModeAtomFamily('chat-1'))).toBe('agent');
    expect(store.get(lastSelectedModelIdAtomFamily('chat-1'))).toBe('sonnet');
    expect(store.get(autoModePerChatAtomFamily('chat-1'))).toBe(true);
  });

  it('copies a locally staged Auto opt-out to the created chat', () => {
    const store = freshStore();

    seedNewChatNavigation(store.get, store.set, 'chat-auto', {
      isCodexAccount: false,
      autoModeEnabled: false,
    });

    expect(store.get(autoModePerChatAtomFamily('chat-auto'))).toBe(false);
  });

  it.each([
    [true, 'ultrafast'],
    [false, 'standard'],
  ])('Codex account %s: staged Ultrafast seeds the chat as %s', (isCodexAccount, seeded) => {
    const store = freshStore();

    seedNewChatNavigation(store.get, store.set, 'chat-fast', {
      isCodexAccount,
      codexSpeed: 'ultrafast',
    });

    expect(store.get(codexSpeedAtomFamily('chat-fast'))).toBe(seeded);
  });

  it('includes the first sub-chat id in the just-created set', () => {
    const store = freshStore();

    seedNewChatNavigation(store.get, store.set, 'chat-2', {
      isCodexAccount: false,
      subChatId: 'sub-2',
    });

    const created = store.get(justCreatedIdsAtom);
    expect(created.has('chat-2')).toBe(true);
    expect(created.has('sub-2')).toBe(true);
  });

  it('coerces the seeded model to the Codex default for a Codex account', () => {
    const store = freshStore(); // global model is 'sonnet' (not a Codex model)

    seedNewChatNavigation(store.get, store.set, 'chat-codex', {
      isCodexAccount: true,
    });

    expect(store.get(lastSelectedModelIdAtomFamily('chat-codex'))).toBe(CODEX_DEFAULT_MODEL_ID);
  });

  it('preserves an already-valid non-default codex id when seeding a codex account', () => {
    const store = freshStore();
    store.set(lastSelectedModelIdAtom, 'codex-gpt-5.5-high'); // valid codex id, non-default effort
    seedNewChatNavigation(store.get, store.set, 'chat-cx2', {
      isCodexAccount: true,
    });
    // Preserved end-to-end (getEffectiveModelIdForPane → normalize), NOT snapped to the default.
    expect(store.get(lastSelectedModelIdAtomFamily('chat-cx2'))).toBe('codex-gpt-5.5-high');
  });

  it('split-pane: fills the NEW_CHAT_PANE pane and clears that pane index map', () => {
    const store = freshStore();
    store.set(splitViewAtom, (prev: SplitViewState) => ({
      ...prev,
      chatIds: [NEW_CHAT_PANE, null],
      activePaneIndex: 0,
    }));
    store.set(newChatPaneProjectMapAtom, {
      0: { id: 'p', name: 'p', path: '/p' },
    });

    seedNewChatNavigation(store.get, store.set, 'chat-4', {
      isCodexAccount: false,
    });

    const split = store.get(splitViewAtom);
    expect(split.chatIds[0]).toBe('chat-4'); // pane filled
    expect(store.get(newChatPaneProjectMapAtom)[0]).toBeUndefined(); // pane map cleared
    expect(store.get(justCreatedIdsAtom).has('chat-4')).toBe(true);
  });
});

describe('createNewChatStaging', () => {
  it('freezes the staged toggles at capture, so a later flip cannot reach the in-flight chat', () => {
    const staging = createNewChatStaging();
    staging.autoMode.current = true;
    staging.codexSpeed.current = 'fast';

    staging.capture();
    staging.codexSpeed.current = 'standard';

    expect(staging.pending).toEqual({ autoMode: true, codexSpeed: 'fast' });
  });

  it('gives each form its own staging, Auto on and standard speed by default', () => {
    const a = createNewChatStaging();
    a.codexSpeed.current = 'fast';
    expect(createNewChatStaging().codexSpeed.current).toBe('standard');
    expect(createNewChatStaging().autoMode.current).toBe(true);
  });
});

describe('seedNewChatPromptAtom', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('single view: seeds the home slot, shows the composer, and closes the overlay', () => {
    const store = freshStore();
    store.set(selectedAgentChatIdAtom, 'chat-open');
    store.set(activeOverlayAtom, 'settings');

    store.set(seedNewChatPromptAtom, 'Catch me up');

    expect(readDraft(newChatDraftKey(0))?.text).toBe('Catch me up');
    expect(store.get(selectedAgentChatIdAtom)).toBeNull();
    expect(store.get(activeOverlayAtom)).toBeNull();
    expect(store.get(agentsMobileViewModeAtom)).toBe('chat');
  });

  it('keeps every stored attachment field when replacing the text', () => {
    const store = freshStore();
    // Written raw: file attachments only reach storage through the async writer,
    // and the seed must preserve them without being able to re-create them.
    localStorage.setItem(
      'agent-drafts-global',
      JSON.stringify({
        [newChatDraftKey(0)]: {
          text: 'half-typed thought',
          updatedAt: Date.now(),
          images: [
            {
              id: 'img-1',
              filename: 'shot.png',
              base64Data: 'aGk=',
              mediaType: 'image/png',
            },
          ],
          files: [{ id: 'file-1', filename: 'notes.pdf', base64Data: 'cGRm' }],
        },
      }),
    );

    store.set(seedNewChatPromptAtom, 'Suggested prompt');

    const raw = JSON.parse(localStorage.getItem('agent-drafts-global') ?? '{}');
    const draft = raw[newChatDraftKey(0)];
    expect(draft?.text).toBe('Suggested prompt');
    expect(draft?.images).toHaveLength(1);
    expect(draft?.files).toHaveLength(1);
    expect(draft?.files[0]?.base64Data).toBe('cGRm');
  });

  it('drops a stale record instead of reviving its attachments under fresh text', () => {
    vi.useFakeTimers();
    const store = freshStore();
    writeDraft(newChatDraftKey(0), {
      text: 'ancient',
      images: [
        {
          id: 'img-old',
          filename: 'old.png',
          url: '',
          isLoading: false,
          base64Data: 'b2xk',
          mediaType: 'image/png',
        },
      ],
    });
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);

    store.set(seedNewChatPromptAtom, 'Fresh prompt');

    const draft = readDraft(newChatDraftKey(0));
    expect(draft?.text).toBe('Fresh prompt');
    expect(draft?.images).toHaveLength(0);
  });

  it('split view collapses to the single-pane home so the seed is never invisible', () => {
    const store = freshStore();
    store.set(splitViewAtom, (prev: SplitViewState) => ({
      ...prev,
      chatIds: ['chat-a', 'chat-b'],
      activePaneIndex: 1,
    }));
    store.set(newChatPaneProjectMapAtom, {
      1: { id: 'p', name: 'p', path: '/p' },
    });

    store.set(seedNewChatPromptAtom, 'Pane prompt');

    expect(store.get(splitViewAtom).chatIds).toEqual([]);
    // Staged per-pane state dies with the panes, exactly as closing the split does.
    expect(store.get(newChatPaneProjectMapAtom)).toEqual({});
    expect(readDraft(newChatDraftKey(0))?.text).toBe('Pane prompt');
    expect(store.get(selectedAgentChatIdAtom)).toBeNull();
    expect(store.get(activeOverlayAtom)).toBeNull();
  });

  it('clears the URL chat param so the remounting chat surface cannot re-open the old chat', () => {
    const store = freshStore();
    window.history.replaceState({}, '', '/?chat=chat-open');

    store.set(seedNewChatPromptAtom, 'Fresh start');

    expect(new URL(window.location.href).searchParams.get('chat')).toBeNull();
    expect(readDraft(newChatDraftKey(0))?.text).toBe('Fresh start');
  });

  it('keeps the overlay stack when Settings sits over a flow editor, parking the seed in the draft', () => {
    const store = freshStore();
    store.set(activeOverlayAtom, 'flows');
    store.set(flowsSelectedFlowIdAtom, 'flow-1');
    store.set(agentsSettingsDialogOpenAtom, true);

    store.set(seedNewChatPromptAtom, 'Parked prompt');

    // The editor's stack is never dismissed on a caller's behalf.
    expect(store.get(activeOverlayAtom)).toBe('settings');
    expect(store.get(agentsSettingsDialogOpenAtom)).toBe(true);
    expect(readDraft(newChatDraftKey(0))?.text).toBe('Parked prompt');
  });

  it('clears a hash-carried chat param, the form packaged file:// builds use', () => {
    const store = freshStore();
    window.history.replaceState({}, '', '/#chat=chat-open&window=w1');

    store.set(seedNewChatPromptAtom, 'Fresh start');

    expect(window.location.hash).not.toContain('chat=chat-open');
    // Sibling hash params survive the surgical delete.
    expect(window.location.hash).toContain('window=w1');
  });
});
