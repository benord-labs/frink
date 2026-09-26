// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newChatDraftKey, readDraft, readDraftStamp, writeDraft } from '../lib/drafts';
import type { AgentsMentionsEditorHandle } from '../mentions';
import { useDraftManagement } from './use-draft-management';

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    files: { writePastedText: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    tasks: { updateStatus: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    useUtils: () => ({
      tasks: { listPaginated: { invalidate: vi.fn() }, listCounts: { invalidate: vi.fn() } },
    }),
  },
}));

/**
 * Stand-in for the contenteditable editor: text lives outside React, reachable only through the
 * imperative handle. `setValue` calls `onContentChange` synchronously, exactly as the real one does.
 */
function makeEditor(initial = '') {
  let value = initial;
  let onContentChange: ((hasContent: boolean) => void) | null = null;
  const handle = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      onContentChange?.(Boolean(next));
    },
    clear: () => {
      value = '';
    },
    focus: vi.fn(),
  } as unknown as AgentsMentionsEditorHandle;

  return {
    ref: { current: handle } as React.RefObject<AgentsMentionsEditorHandle | null>,
    /** Simulate the user typing, which is what drives the debounced save. */
    type(next: string) {
      value = next;
      onContentChange?.(Boolean(next));
    },
    bind(handler: (hasContent: boolean) => void) {
      onContentChange = handler;
    },
  };
}

function mountComposer(editorRef: React.RefObject<AgentsMentionsEditorHandle | null>, key: string) {
  const setHasContent = vi.fn();
  const view = renderHook(() => useDraftManagement({ editorRef, setHasContent, draftKey: key }));
  return { view, setHasContent };
}

const KEY = newChatDraftKey(0);

describe('useDraftManagement', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('restores what was typed after the composer unmounts and remounts', () => {
    const first = makeEditor();
    const a = mountComposer(first.ref, KEY);
    first.bind(a.view.result.current.handleContentChange);

    act(() => first.type('half a thought'));
    act(() => a.view.unmount());

    const second = makeEditor();
    mountComposer(second.ref, KEY);
    expect(second.ref.current?.getValue()).toBe('half a thought');
  });

  it('persists on unmount even when the debounce has not fired yet', () => {
    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    editor.bind(view.result.current.handleContentChange);

    act(() => editor.type('typed then left immediately'));
    // Deliberately no timer advance — leaving is what has to save it.
    act(() => view.unmount());

    expect(readDraft(KEY)?.text).toBe('typed then left immediately');
  });

  it('persists on window close inside the debounce window', () => {
    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    editor.bind(view.result.current.handleContentChange);

    act(() => editor.type('quit before the timer'));
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });

    expect(readDraft(KEY)?.text).toBe('quit before the timer');
    view.unmount();
  });

  // The regression that a single round trip cannot catch: restoring writes straight into the
  // editor's DOM, so a mirror-only flush would write the recovered text back as empty.
  it('survives a second navigation with no typing in between', () => {
    writeDraft(KEY, { text: 'written once' });

    const first = makeEditor();
    const a = mountComposer(first.ref, KEY);
    expect(first.ref.current?.getValue()).toBe('written once');
    act(() => a.view.unmount());

    expect(readDraft(KEY)?.text).toBe('written once');

    const second = makeEditor();
    const b = mountComposer(second.ref, KEY);
    expect(second.ref.current?.getValue()).toBe('written once');
    act(() => b.view.unmount());

    expect(readDraft(KEY)?.text).toBe('written once');
  });

  it('does not delete a text-only draft that was restored but not retyped', () => {
    writeDraft(KEY, { text: 'do not evaporate' });

    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    act(() => view.unmount());

    expect(readDraft(KEY)).not.toBeNull();
    expect(readDraft(KEY)?.text).toBe('do not evaporate');
  });

  it('restores a pasted-text chip and an attached task', () => {
    writeDraft(KEY, {
      text: 'with context',
      pastedTexts: [
        {
          id: 'p-1',
          filePath: '/tmp/p-1.txt',
          filename: 'p-1.txt',
          size: 10,
          preview: 'blah',
          createdAt: new Date(),
        },
      ],
      task: { id: 't-1', title: 'Ticket', description: 'body' },
    });

    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);

    expect(view.result.current.pastedTexts).toHaveLength(1);
    expect(view.result.current.taskAttachment.attachedTask?.id).toBe('t-1');
    view.unmount();
  });

  it('does not wipe stored attachments while restoring them', () => {
    writeDraft(KEY, {
      text: '',
      pastedTexts: [
        {
          id: 'p-1',
          filePath: '/tmp/p-1.txt',
          filename: 'p-1.txt',
          size: 10,
          preview: 'blah',
          createdAt: new Date(),
        },
      ],
    });

    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    act(() => {
      vi.runAllTimers();
    });

    expect(readDraft(KEY)?.pastedTexts).toHaveLength(1);
    view.unmount();
    expect(readDraft(KEY)?.pastedTexts).toHaveLength(1);
  });

  // The editor can appear LATER than this hook: while no account is connected the form renders an
  // empty state in its place, and connecting one swaps the editor in without remounting the form.
  it('starts persisting once an editor that mounted late appears', () => {
    writeDraft(KEY, { text: 'from a previous visit' });

    // First render: no-accounts empty state, so there is no editor yet.
    const late = makeEditor();
    const ref = { current: null } as React.RefObject<AgentsMentionsEditorHandle | null>;
    const setHasContent = vi.fn();
    const view = renderHook(() =>
      useDraftManagement({ editorRef: ref, setHasContent, draftKey: KEY }),
    );

    // The user connects an account; EditorSection mounts and populates the ref.
    ref.current = late.ref.current;
    act(() => view.rerender());
    late.bind(view.result.current.handleContentChange);

    expect(ref.current?.getValue()).toBe('from a previous visit');

    act(() => late.type('typed after connecting'));
    act(() => {
      vi.runAllTimers();
    });
    expect(readDraft(KEY)?.text).toBe('typed after connecting');
    view.unmount();
  });

  // Restoring sets React state, which the mount pass's own props do not yet reflect. If the
  // attachment-save effect runs against those stale props it writes empty attachments over the slot
  // it just recovered — a window in which a quit or crash loses them for good. Asserting on the
  // final state alone would miss it, so this inspects every write made during mount.
  it('never writes empty attachments over the draft it is restoring', () => {
    writeDraft(KEY, {
      text: 'has context attached',
      pastedTexts: [
        {
          id: 'p-1',
          filePath: '/tmp/p-1.txt',
          filename: 'p-1.txt',
          size: 10,
          preview: 'ctx',
          createdAt: new Date(),
        },
      ],
    });

    const writes: string[] = [];
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
      if (k === 'agent-drafts-global') writes.push(v);
      setItem(k, v);
    });

    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    act(() => {
      vi.runAllTimers();
    });

    const droppedContext = writes.filter((raw) => {
      const slot = JSON.parse(raw)[KEY];
      return slot?.text && !slot.pastedTexts?.length;
    });
    expect(droppedContext).toEqual([]);
    expect(readDraft(KEY)?.pastedTexts).toHaveLength(1);
    view.unmount();
  });

  // editor.setValue fires onContentChange SYNCHRONOUSLY, inside applyRestoredDraft — before that
  // function returns. If the mirror is seeded from its RETURN VALUE (too late) rather than before
  // it runs, handleContentChange's equality guard compares the just-restored text against a STALE
  // mirror, misreads the restore as a user edit, and arms a debounce write — silently refreshing
  // `updatedAt` and resetting the 7-day staleness clock on every mere VIEW of the composer.
  //
  // Exercised via a draftKey CHANGE rather than the very first mount: the editor's onContentChange
  // can only be bound to handleContentChange once renderHook returns a handle to it, which is too
  // late to observe the first restore's own setValue call — but the same synchronous-callback path
  // fires identically on every later re-sync, once bound, so it's an equally faithful reproduction.
  it('does not touch the stored updatedAt merely by re-pointing to a slot and restoring it', () => {
    writeDraft(newChatDraftKey(1), { text: 'just sitting here' });
    const before = readDraftStamp(newChatDraftKey(1));

    const editor = makeEditor();
    const setHasContent = vi.fn();
    const view = renderHook(
      ({ key }) => useDraftManagement({ editorRef: editor.ref, setHasContent, draftKey: key }),
      { initialProps: { key: newChatDraftKey(0) } },
    );
    editor.bind(view.result.current.handleContentChange);

    act(() => view.rerender({ key: newChatDraftKey(1) }));
    act(() => {
      vi.runAllTimers();
    });

    expect(readDraftStamp(newChatDraftKey(1))).toBe(before);
    view.unmount();
  });

  // applyRestoredDraft's setters land freshly-allocated arrays, one render later, on the
  // attachment-mirror effect's own dependency list — reference-different from the initial empty
  // state even though nothing NEW happened. Asserted via a write-count spy, not a stamp
  // comparison: the spurious write (if the bug regresses) happens synchronously, on the very same
  // frozen fake-clock tick as the setup write, so a before/after stamp comparison alone cannot
  // distinguish "no write" from "a write that happened to land on the same millisecond."
  it('does not re-persist a draft merely by restoring its attachments', () => {
    writeDraft(KEY, {
      text: 'has an image and a task',
      images: [
        {
          id: 'img-1',
          filename: 'img-1.png',
          url: 'blob:seed-img-1',
          isLoading: false,
          mediaType: 'image/png',
          base64Data: 'aGk=',
        },
      ],
      pastedTexts: [
        {
          id: 'p-1',
          filePath: '/tmp/p-1.txt',
          filename: 'p-1.txt',
          size: 10,
          preview: 'ctx',
          createdAt: new Date(),
        },
      ],
      task: { id: 't-1', title: 'Ticket', description: 'body' },
    });

    const setItemSpy = vi.spyOn(localStorage, 'setItem');

    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    act(() => {
      vi.runAllTimers();
    });

    expect(setItemSpy).not.toHaveBeenCalled();
    view.unmount();
    setItemSpy.mockRestore();
  });

  it('leaves a stored draft untouched when no editor ever mounts', () => {
    writeDraft(KEY, { text: 'written while signed out' });

    // The no-accounts branch renders an empty state instead of the editor.
    const detachedRef = createRef<AgentsMentionsEditorHandle>();
    const { view } = mountComposer(detachedRef, KEY);
    act(() => {
      vi.runAllTimers();
    });
    act(() => view.unmount());

    expect(readDraft(KEY)?.text).toBe('written while signed out');
  });

  it('does not resurrect a draft that was cleared on send', () => {
    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    editor.bind(view.result.current.handleContentChange);

    act(() => editor.type('ship it'));
    act(() => {
      view.result.current.clearCurrentDraft();
      editor.ref.current?.clear();
    });
    act(() => view.unmount());

    expect(readDraft(KEY)).toBeNull();
  });

  it('writes nothing for a composer that was never typed in', () => {
    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    act(() => view.unmount());

    expect(readDraft(KEY)).toBeNull();
  });

  // The composer's own state is cleared field by field on send, and each of those is a state change
  // that re-triggers the attachment save. That save must not re-create what the send just discarded.
  it('does not resurrect a draft when send clears its attachments after the draft is cleared', () => {
    writeDraft(KEY, {
      text: 'ship it',
      pastedTexts: [
        {
          id: 'p-1',
          filePath: '/tmp/p-1.txt',
          filename: 'p-1.txt',
          size: 10,
          preview: 'ctx',
          createdAt: new Date(),
        },
      ],
    });

    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    editor.bind(view.result.current.handleContentChange);
    expect(view.result.current.pastedTexts).toHaveLength(1);

    // Mirrors createChatMutation.onSuccess: clear the editor and each attachment, then the draft.
    act(() => {
      editor.ref.current?.clear();
      view.result.current.clearPastedTexts();
      view.result.current.taskAttachment.clearTask();
      view.result.current.clearCurrentDraft();
    });
    act(() => {
      vi.runAllTimers();
    });

    expect(readDraft(KEY)).toBeNull();
    act(() => view.unmount());
    expect(readDraft(KEY)).toBeNull();
  });

  // Guards the scope-drift class: a pending or teardown save must land in the slot it was typed in,
  // never in whichever slot the component has since been re-pointed at.
  it('flushes to the slot the text was typed in when the draft key changes', () => {
    const editor = makeEditor();
    const setHasContent = vi.fn();
    const view = renderHook(
      ({ key }) => useDraftManagement({ editorRef: editor.ref, setHasContent, draftKey: key }),
      { initialProps: { key: newChatDraftKey(0) } },
    );
    editor.bind(view.result.current.handleContentChange);

    act(() => editor.type('typed in pane 0'));
    act(() => view.rerender({ key: newChatDraftKey(1) }));

    expect(readDraft(newChatDraftKey(0))?.text).toBe('typed in pane 0');
    expect(readDraft(newChatDraftKey(1))).toBeNull();
    view.unmount();
  });

  // applyRestoredDraft's contract is that a re-point's (possibly empty) incoming attachments
  // replace the outgoing slot's — proven for images/pastedTexts elsewhere, but task used a
  // truthy-only setter that skipped exactly the empty case, leaving a stale task visibly attached
  // (and sendable) after moving to a slot that has none.
  it('drops the attached task when the draft key re-points to a slot with none', () => {
    writeDraft(newChatDraftKey(0), {
      text: 'has a task',
      task: { id: 't-1', title: 'T', description: '' },
    });
    writeDraft(newChatDraftKey(1), { text: 'no task here' });

    const editor = makeEditor();
    const setHasContent = vi.fn();
    const view = renderHook(
      ({ key }) => useDraftManagement({ editorRef: editor.ref, setHasContent, draftKey: key }),
      { initialProps: { key: newChatDraftKey(0) } },
    );
    expect(view.result.current.taskAttachment.attachedTask?.id).toBe('t-1');

    act(() => view.rerender({ key: newChatDraftKey(1) }));

    expect(view.result.current.taskAttachment.attachedTask).toBeNull();
    view.unmount();
  });

  // The slot is keyed by pane, not by mount, and `useMutation`'s onSuccess still fires after its
  // component unmounts — so a send that resolves late must not delete whatever the composer that
  // replaced it has since typed.
  it('does not let a departed composer clear the draft of the one that replaced it', () => {
    const first = makeEditor();
    const a = mountComposer(first.ref, KEY);
    first.bind(a.view.result.current.handleContentChange);
    const staleClear = a.view.result.current.clearCurrentDraft;

    act(() => first.type('sent prompt'));
    act(() => a.view.unmount());

    const second = makeEditor();
    const b = mountComposer(second.ref, KEY);
    second.bind(b.view.result.current.handleContentChange);
    act(() => second.type('what I am typing now'));
    act(() => {
      vi.runAllTimers();
    });
    expect(readDraft(KEY)?.text).toBe('what I am typing now');

    // The old instance's createChatMutation finally resolves.
    act(() => staleClear());

    expect(readDraft(KEY)?.text).toBe('what I am typing now');
    b.view.unmount();
  });

  // The mirror image of the test above: nobody else has claimed the slot, so the sent prompt must
  // not be left behind to reappear as a draft next time the composer opens.
  it('clears its own sent draft even when it resolves after the composer has gone', () => {
    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    editor.bind(view.result.current.handleContentChange);
    const lateClear = view.result.current.clearCurrentDraft;

    act(() => editor.type('a prompt that was sent'));
    // Navigate away before createChatMutation resolves — the unmount flush persists the sent text.
    act(() => view.unmount());
    expect(readDraft(KEY)?.text).toBe('a prompt that was sent');

    act(() => lateClear());

    expect(readDraft(KEY)).toBeNull();
  });

  it('still clears its own draft on send while mounted', () => {
    const editor = makeEditor();
    const { view } = mountComposer(editor.ref, KEY);
    editor.bind(view.result.current.handleContentChange);

    act(() => editor.type('ship it'));
    act(() => {
      view.result.current.clearCurrentDraft();
      editor.ref.current?.clear();
    });

    expect(readDraft(KEY)).toBeNull();
    view.unmount();
  });

  // The composer's own pane stays the NEW_CHAT_PANE sentinel until createChatMutation succeeds, so
  // navigating away and back during that (possibly long) window remounts a FRESH composer at the
  // SAME slot while the first instance's send is still in flight. Without pausing persistence, the
  // departed instance's unmount flush would persist the still-visible sent text, and the fresh
  // instance would restore it — an already-sent message reappearing as a stuck draft.
  describe('send suspension', () => {
    it('does not let the sending instance persist the sent text if it unmounts mid-request', () => {
      const editor = makeEditor();
      const { view } = mountComposer(editor.ref, KEY);
      editor.bind(view.result.current.handleContentChange);

      act(() => editor.type('about to be sent'));
      act(() => {
        vi.runAllTimers();
      });
      expect(readDraft(KEY)?.text).toBe('about to be sent');

      // Mirrors handleSend: commit, wiping + pausing before the async mutation starts.
      act(() => {
        view.result.current.beginSend();
      });
      expect(readDraft(KEY)).toBeNull();

      // Navigate away before createChatMutation resolves. The unmount flush must stay suppressed.
      act(() => view.unmount());
      expect(readDraft(KEY)).toBeNull();
    });

    // handleContentChange never checks isSendingRef, so content changing AFTER beginSend arms a
    // fresh debounce timer. If the
    // instance then unmounts before that timer fires, flushTo's early-return must still cancel it —
    // otherwise it survives, and once resume flips isSendingRef back false it fires unguarded,
    // clobbering whatever a replacement composer at the same slot has since saved.
    it('cancels a debounce timer armed after beginSend, even though the unmount flush early-returns', () => {
      const first = makeEditor();
      const a = mountComposer(first.ref, KEY);
      first.bind(a.view.result.current.handleContentChange);

      act(() => first.type('about to be sent'));
      act(() => {
        vi.runAllTimers();
      });
      act(() => {
        a.view.result.current.beginSend();
      });
      // Content changes again post-pause (e.g. a transcription resolving late) — arms a new timer.
      // Critically, nothing consumes it here: the guard on isSendingRef would swallow it harmlessly
      // if it fired NOW, masking a surviving timer as identical to a cancelled one. The bug only
      // shows once isSendingRef later flips back false with the timer still pending.
      act(() => first.type('a late edit after send was already committed'));
      const staleResume = a.view.result.current.resumeDraftPersistence;
      act(() => a.view.unmount());

      // The send fails; resume flips isSendingRef false without itself writing (unmounted). If the
      // dangling timer survived, THIS is the moment it can finally get through the guard.
      act(() => staleResume());
      act(() => {
        vi.runAllTimers();
      });
      expect(readDraft(KEY)).toBeNull();

      // Unrelated composer B, mounting after the fact, must never have to contend with it either.
      const second = makeEditor();
      const b = mountComposer(second.ref, KEY);
      second.bind(b.view.result.current.handleContentChange);
      act(() => second.type('replacement composer draft'));
      act(() => {
        vi.runAllTimers();
      });
      expect(readDraft(KEY)?.text).toBe('replacement composer draft');
      b.view.unmount();
    });

    it('does not let a fresh instance at the same slot resurrect the sent text', () => {
      const first = makeEditor();
      const a = mountComposer(first.ref, KEY);
      first.bind(a.view.result.current.handleContentChange);

      act(() => first.type('about to be sent'));
      act(() => {
        a.view.result.current.beginSend();
      });
      act(() => a.view.unmount());

      // User navigates back to the same pane before the mutation resolves — a fresh composer mounts.
      const second = makeEditor();
      const b = mountComposer(second.ref, KEY);
      expect(second.ref.current?.getValue()).toBe('');

      // The fresh instance is left completely idle (no typing) and itself unmounts — it must not
      // write anything, since it never had content to persist.
      act(() => b.view.unmount());
      expect(readDraft(KEY)).toBeNull();
    });

    it('resumes and immediately recaptures the live editor once the send fails', () => {
      const editor = makeEditor();
      const { view } = mountComposer(editor.ref, KEY);
      editor.bind(view.result.current.handleContentChange);

      act(() => editor.type('about to be sent'));
      act(() => {
        view.result.current.beginSend();
      });
      expect(readDraft(KEY)).toBeNull();

      // The mutation fails; onError resumes persistence. The editor still shows the unsent text —
      // onError never clears it — so resuming must recapture it without waiting for a keystroke.
      act(() => view.result.current.resumeDraftPersistence());

      expect(readDraft(KEY)?.text).toBe('about to be sent');
    });

    // onError is a stale closure: it can fire long after this instance unmounted, by which point a
    // fresh composer may already own the slot and have saved its own newer content. An unconditional
    // flush of the departed instance's stale mirror would clobber that — exactly the class of bug
    // `mountedRef` already guards for `clearCurrentDraft`.
    it("does not let a departed composer resurrect its stale draft over a replacement's newer one", () => {
      const first = makeEditor();
      const a = mountComposer(first.ref, KEY);
      first.bind(a.view.result.current.handleContentChange);
      const staleResume = a.view.result.current.resumeDraftPersistence;

      act(() => first.type('the failed send'));
      act(() => {
        a.view.result.current.beginSend();
      });
      act(() => a.view.unmount());

      const second = makeEditor();
      const b = mountComposer(second.ref, KEY);
      second.bind(b.view.result.current.handleContentChange);
      act(() => second.type('newer, unrelated draft'));
      act(() => {
        vi.runAllTimers();
      });
      expect(readDraft(KEY)?.text).toBe('newer, unrelated draft');

      // The original mutation finally fails.
      act(() => staleResume());

      expect(readDraft(KEY)?.text).toBe('newer, unrelated draft');
      b.view.unmount();
    });

    // Recovering a failed send after the composer has already unmounted is out of scope for
    // composer-draft-persistence (which promises text survives NAVIGATION, not a mid-flight send
    // failure): there is no live editor left to read a retry from, and no way for a storage write
    // here to reach whatever composer the user is now looking at — its own next keystroke would
    // silently clobber it regardless. Doing nothing is correct, not just simplest.
    it('does nothing when a failed send resolves after the composer has already unmounted', () => {
      const first = makeEditor();
      const a = mountComposer(first.ref, KEY);
      first.bind(a.view.result.current.handleContentChange);
      const staleResume = a.view.result.current.resumeDraftPersistence;

      act(() => first.type('the message that failed to send'));
      act(() => {
        a.view.result.current.beginSend();
      });
      act(() => a.view.unmount());
      expect(readDraft(KEY)).toBeNull();

      act(() => staleResume());

      expect(readDraft(KEY)).toBeNull();
    });

    it('keeps persisting normally again after a resume', () => {
      const editor = makeEditor();
      const { view } = mountComposer(editor.ref, KEY);
      editor.bind(view.result.current.handleContentChange);

      act(() => editor.type('first attempt'));
      act(() => {
        view.result.current.beginSend();
      });
      act(() => view.result.current.resumeDraftPersistence());

      act(() => editor.type('retyped after the failure'));
      act(() => {
        vi.runAllTimers();
      });

      expect(readDraft(KEY)?.text).toBe('retyped after the failure');
      view.unmount();
    });

    // beginSend's clearCurrentDraft wipes the latestRef MIRROR pre-emptively, before the send's
    // outcome is known — but onError never clears the LIVE images/pastedTexts/attachedTask state
    // (only a confirmed success does), so on failure the two disagree. flushTo must trust live
    // state, or a resumed flush silently drops attachments that are still visibly attached.
    it('keeps the attached task after a failed send, not just the recovered text', () => {
      const editor = makeEditor();
      const { view } = mountComposer(editor.ref, KEY);
      editor.bind(view.result.current.handleContentChange);

      act(() => editor.type('has a task attached'));
      act(() => {
        view.result.current.taskAttachment.setAttachedTask({
          id: 't-1',
          title: 'Ticket',
          description: '',
        });
      });
      act(() => {
        view.result.current.beginSend();
      });

      // The mutation fails; onError never clears the task (only onSuccess does).
      act(() => view.result.current.resumeDraftPersistence());

      expect(readDraft(KEY)?.text).toBe('has a task attached');
      expect(readDraft(KEY)?.task?.id).toBe('t-1');
      view.unmount();
    });

    // beginSend clears the STORED draft pre-emptively, but the composer stays mounted and
    // visibly showing the attached image while the send is in flight. Revoking its blob URL at
    // clear time (the default clearDraft behavior) would blank that thumbnail immediately, with
    // no repair path if the send then fails.
    it('does not revoke the attached image blob URL while a send is in flight', () => {
      writeDraft(KEY, {
        text: 'has an image',
        images: [
          {
            id: 'img-1',
            filename: 'img-1.png',
            url: 'blob:seed-img-1',
            isLoading: false,
            mediaType: 'image/png',
            base64Data: 'aGk=',
          },
        ],
      });

      const editor = makeEditor();
      const { view } = mountComposer(editor.ref, KEY);
      editor.bind(view.result.current.handleContentChange);
      expect(view.result.current.images).toHaveLength(1);

      const revokeSpy = URL.revokeObjectURL as ReturnType<typeof vi.fn>;
      revokeSpy.mockClear();

      act(() => {
        view.result.current.beginSend();
      });

      expect(revokeSpy).not.toHaveBeenCalled();
      view.unmount();
    });

    // isSending suppresses writes so a same-session remount can't restore an about-to-be-sent
    // text before its outcome is known — but beforeunload means the app itself is quitting, so
    // that race can't happen. Without this, a process kill mid-send would silently lose text that
    // was never confirmed sent, violating the composer-draft-persistence beforeunload guarantee.
    it('persists the still-visible text on beforeunload even while a send is in flight', () => {
      const editor = makeEditor();
      const { view } = mountComposer(editor.ref, KEY);
      editor.bind(view.result.current.handleContentChange);

      act(() => editor.type('scaffolding is slow'));
      act(() => {
        vi.runAllTimers();
      });
      act(() => {
        view.result.current.beginSend();
      });
      expect(readDraft(KEY)).toBeNull();

      // The mutation is still in flight when the app quits — never resolves either way.
      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      expect(readDraft(KEY)?.text).toBe('scaffolding is slow');
      view.unmount();
    });
  });

  it('keeps split panes independent', () => {
    const left = makeEditor();
    const a = mountComposer(left.ref, newChatDraftKey(0));
    left.bind(a.view.result.current.handleContentChange);

    const right = makeEditor();
    const b = mountComposer(right.ref, newChatDraftKey(1));
    right.bind(b.view.result.current.handleContentChange);

    act(() => left.type('left side'));
    act(() => right.type('right side'));
    act(() => {
      a.view.unmount();
      b.view.unmount();
    });

    expect(readDraft(newChatDraftKey(0))?.text).toBe('left side');
    expect(readDraft(newChatDraftKey(1))?.text).toBe('right side');
  });
});
