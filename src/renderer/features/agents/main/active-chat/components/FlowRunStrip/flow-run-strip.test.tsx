// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexSpeed } from '../../../../../../../shared/types/execution';
import { agentChatStore } from '../../../../stores/agent-chat-store';
import { FlowPausedBar, FlowRunStrip } from './index';

const pauseMutate = vi.fn();
const cancelMutate = vi.fn();
let runData: unknown;

vi.mock('../../../../../../lib/trpc', () => ({
  trpc: {
    flows: {
      getRun: { useQuery: () => ({ data: runData }) },
      pauseRun: { useMutation: () => ({ mutate: pauseMutate, isPending: false }) },
      cancelRun: { useMutation: () => ({ mutate: cancelMutate, isPending: false }) },
    },
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: vi.fn() },
        listCounts: { invalidate: vi.fn() },
        getById: { invalidate: vi.fn() },
        getDrivingTaskForSubChat: { invalidate: vi.fn() },
      },
      flows: {
        getRun: { invalidate: vi.fn() },
        listRuns: { invalidate: vi.fn() },
      },
    }),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Fresh jotai store per test — the note draft lives in an atomFamily keyed by sub-chat, which would
// otherwise leak between cases on the module-level default store.
let store = createStore();

function renderStrip(
  overrides: {
    flowRunId?: string;
    canPause?: boolean;
    onAddNote?: (t: string) => boolean;
    modelId?: string;
    mode?: 'agent' | 'plan' | 'debug';
    subChatId?: string;
    autoReviewTools?: boolean;
    codexSpeed?: CodexSpeed;
  } = {},
) {
  const onAddNote = overrides.onAddNote ?? vi.fn(() => true);
  const onStopTurn = vi.fn();
  const result = render(
    <Provider store={store}>
      <FlowRunStrip
        subChatId={overrides.subChatId ?? 'sub1'}
        flowRunId={overrides.flowRunId ?? 'run1'}
        canPause={overrides.canPause ?? true}
        modelId={overrides.modelId}
        mode={overrides.mode}
        autoReviewTools={overrides.autoReviewTools}
        codexSpeed={overrides.codexSpeed}
        onAddNote={onAddNote}
        onStopTurn={onStopTurn}
      />
    </Provider>,
  );
  return { onAddNote, onStopTurn, ...result };
}

// Query the BUTTONS, never their label text. Labels live in a span that sheds to `sr-only` on a
// narrow card, so `getByText('Stop')` returns that span — and `children.indexOf(span)` would then
// be -1 in every branch, quietly turning the layout-invariance assertions below into `-1 === -1`.
const stopButton = () => screen.getByRole('button', { name: 'Stop' });
const noteToggle = () => screen.getByRole('button', { name: 'Add a note' });

/** The group Stop is pinned to — the invariant this layout exists to hold. */
function stopActionGroup(): HTMLElement {
  const group = stopButton().closest('div');
  if (!group) throw new Error('Stop is not inside an action group');
  return group;
}

describe('FlowRunStrip', () => {
  beforeEach(() => {
    runData = {
      nodeRuns: [{ id: 'nr1', node_id: 'a', status: 'running' }],
      graph: { nodes: [{ id: 'a', blockType: 'agent', label: 'Build step' }] },
    };
    pauseMutate.mockReset();
    cancelMutate.mockReset();
    store = createStore();
  });
  afterEach(cleanup);

  it('shows the running node label from the run graph', () => {
    renderStrip();
    expect(screen.getByText('Running Build step')).toBeInTheDocument();
  });

  it('shows the model + mode readout when provided', () => {
    renderStrip({ modelId: 'opus-4.8-max', mode: 'plan' });
    expect(screen.getByText('Opus 4.8 · Max')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
  });

  it('hides each readout pill independently when its value is missing', () => {
    // Mode present, model absent (an unknown/stale id or a taskless window).
    renderStrip({ mode: 'agent' });
    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('fires flows.pauseRun for the sub-chat on Pause', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Pause'));
    expect(pauseMutate).toHaveBeenCalledWith({ subChatId: 'sub1' });
  });

  it('hides Pause for batch members (canPause=false), keeping Stop', () => {
    renderStrip({ canPause: false });
    expect(screen.queryByText('Pause')).toBeNull();
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  // Measured in a real engine: the two confirm verbs are 206px and cannot share a narrow row with
  // anything else. Both keep their full wording — a destructive confirm must never reduce to a
  // glyph, and an ✕ beside "Confirm stop" would read as "cancel the run" — so everything else
  // steps aside instead and the row becomes the question.
  it('sheds Pause while Stop is armed, keeping both confirm verbs fully worded', () => {
    renderStrip({ modelId: 'opus-4.8-max', mode: 'agent', autoReviewTools: true });
    fireEvent.click(screen.getByText('Stop'));

    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.getByText('Confirm stop')).toBeInTheDocument();
    expect(screen.getByText('Keep running')).toBeInTheDocument();

    // Cancelling restores Pause — the shed is presentation, not a state change.
    fireEvent.click(screen.getByText('Keep running'));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  // The toggle offers "Add a note"; once the note is open that verb is already carried out, so the
  // control goes rather than lingering as a de-labelled glyph above the field it opened.
  it('removes the note toggle while its field is open, rather than de-labelling it', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));

    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
  });

  // The interleaving that a second mount-gate on the toggle used to break: close the note WHILE
  // Stop is armed. collapse() arms the refocus and flips `open`, so the toggle must exist at that
  // moment or the restore is consumed against nothing and focus falls to <body> for good.
  it('returns focus to the toggle when the note closes while Stop is armed', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.keyDown(screen.getByLabelText('Message the agent'), { key: 'Escape' });

    expect(noteToggle()).toBeInTheDocument();
    expect(noteToggle()).toHaveFocus();
  });

  it('Stop is a two-step confirm that cancels the run AND aborts the turn', () => {
    const { onStopTurn } = renderStrip();
    fireEvent.click(screen.getByText('Stop'));
    // First click only arms — nothing fired yet.
    expect(cancelMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm stop'));
    expect(cancelMutate).toHaveBeenCalledWith({ runId: 'run1' });
    expect(onStopTurn).toHaveBeenCalled();
  });

  it('queues a note through onAddNote and collapses the field on success', () => {
    const { onAddNote } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    const input = screen.getByLabelText('Message the agent');
    fireEvent.change(input, { target: { value: 'prefer approach B' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAddNote).toHaveBeenCalledWith('prefer approach B');
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
  });

  // The running strip STEERS: a note reaches the step it annotates instead of queueing behind it.
  // Steering removed the constraint that forced queue-only wording here — a direct send used to
  // abort the very step being annotated, and a steer costs that step nothing.
  it('submits from the steer control, which names steering rather than queueing', () => {
    const { onAddNote } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'note' } });
    expect(screen.queryByLabelText('Add to queue')).toBeNull();
    fireEvent.click(screen.getByLabelText('Steer'));
    expect(onAddNote).toHaveBeenCalledWith('note');
  });

  it('keeps the note text when the send fails so the user can retry', () => {
    renderStrip({ onAddNote: vi.fn(() => false) });
    fireEvent.click(screen.getByText('Add a note'));
    const input = screen.getByLabelText('Message the agent');
    fireEvent.change(input, { target: { value: 'note' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('Message the agent')).toHaveValue('note');
  });

  // A preserved draft the user cannot SEE is a silent stash — they retype, or send stale text days
  // later. Keeping it means showing it, so an unsent note reopens the field on remount. The empty
  // case still starts collapsed, which is what "notes stay deliberate" governs.
  it('keeps an unsent note across the strip unmounting, and reopens the field to show it', () => {
    const { unmount } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), {
      target: { value: 'half a thought' },
    });
    unmount();

    renderStrip();
    expect(screen.getByLabelText('Message the agent')).toHaveValue('half a thought');
  });

  // "Collapsed" means the toggle is offering the verb and the field is absent. Assert both: the
  // toggle alone would not distinguish this from the open state on a card that kept it mounted.
  it('starts collapsed when there is no draft to show', () => {
    renderStrip();
    expect(noteToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
  });

  // getOrCreateFlowChat reuses ONE chat + sub-chat for every run against the same worktree, so a
  // sub-chat-only key would resurface run A's unsent note under an unrelated run B — auto-opened,
  // one Enter from being queued into the wrong run's turn.
  it('does not carry a draft from one run into the next run on the same sub-chat', () => {
    const { unmount } = renderStrip({ flowRunId: 'run-a' });
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), {
      target: { value: 'meant for run A' },
    });
    unmount();

    renderStrip({ flowRunId: 'run-b' });
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByLabelText('Message the agent')).toHaveValue('');
  });

  // The strip instance is REUSED when the same sub-chat starts a new run (no unmount), and the
  // open/closed state is seeded by a mount-only initializer — so without a scope reset it would
  // carry over while the draft atom underneath switched, hiding the new run's draft behind a
  // collapsed toggle or leaving the field open over an empty one.
  it('re-derives open/closed when the run changes under a reused strip', () => {
    const { rerender } = renderStrip({ flowRunId: 'run-a' });
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'for A' } });
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();

    // Same mount, new run: run B has no draft, so the field must close rather than sit open+empty.
    rerender(
      <Provider store={store}>
        <FlowRunStrip
          subChatId="sub1"
          flowRunId="run-b"
          canPause
          onAddNote={vi.fn(() => true)}
          onStopTurn={vi.fn()}
        />
      </Provider>,
    );
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
    expect(noteToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  // Split panes drive several sub-chats at once; a draft is per sub-chat, never global.
  it('does not leak one sub-chat’s draft into another', () => {
    const { unmount } = renderStrip({ subChatId: 'sub-a' });
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'for A' } });
    unmount();

    renderStrip({ subChatId: 'sub-b' });
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByLabelText('Message the agent')).toHaveValue('');
  });

  it('clears the kept draft once the note actually queues', () => {
    const { unmount } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'sent' } });
    fireEvent.keyDown(screen.getByLabelText('Message the agent'), { key: 'Enter' });
    unmount();

    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByLabelText('Message the agent')).toHaveValue('');
  });

  it('does not queue or collapse on a whitespace-only note', () => {
    const { onAddNote } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    const input = screen.getByLabelText('Message the agent');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAddNote).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message the agent')).toBeInTheDocument();
  });

  // Enter commits an IME candidate (Japanese/Chinese/Korean input) before it ever means "submit" —
  // queuing a half-composed note would be silent data loss for anyone typing via an IME.
  it('does not queue on Enter while an IME composition is open', () => {
    const { onAddNote } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    const input = screen.getByLabelText('Message the agent');
    fireEvent.change(input, { target: { value: 'にほんご' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onAddNote).not.toHaveBeenCalled();
  });

  // Collapsing unmounts the focused input; without a hand-back, focus falls to <body> and the next
  // Tab restarts at the top of the chat.
  it('returns focus to the toggle when the note field collapses', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.keyDown(screen.getByLabelText('Message the agent'), { key: 'Escape' });
    expect(noteToggle()).toHaveFocus();
  });

  // The field must be dismissable without a keyboard — Escape alone is undiscoverable.
  it('offers a visible X beside submit that closes the field', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByLabelText('Discard message')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Discard message'));
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
    expect(noteToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  // The ✕ is labelled, so it may discard. Without this, dismissing would silently resurrect the
  // text on the next mount via the reopen-on-draft rule.
  it('discards the draft via the ✕, so it does not resurrect on the next mount', () => {
    const { unmount } = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), {
      target: { value: 'never mind' },
    });
    fireEvent.click(screen.getByLabelText('Discard message'));
    unmount();

    renderStrip();
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByLabelText('Message the agent')).toHaveValue('');
  });

  // Escape is pressed reflexively to shed focus and carries no discard contract — destroying a
  // paragraph on it would be the opposite of what the draft atom exists for. It only collapses.
  it('keeps the draft on Escape — collapse is not discard', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), {
      target: { value: 'a long paragraph' },
    });
    fireEvent.keyDown(screen.getByLabelText('Message the agent'), { key: 'Escape' });

    // Collapsed, but the text is one click away rather than gone.
    expect(screen.queryByLabelText('Message the agent')).toBeNull();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByLabelText('Message the agent')).toHaveValue('a long paragraph');
  });

  it('keeps a delivery cue visible in the placeholder', () => {
    renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    expect(screen.getByPlaceholderText('Steer the running step…')).toBeInTheDocument();
  });

  // The misclick this layout exists to prevent: Stop must not travel when the note row opens or
  // collapses, nor when Pause unmounts mid-run. happy-dom has no layout, so assert the two
  // structural properties that would produce the movement instead of a pixel position.
  it('never moves Stop within its action group when the note field opens or closes', () => {
    renderStrip();
    const indexOfStop = () => Array.from(stopActionGroup().children).indexOf(stopButton());
    const before = indexOfStop();
    expect(before).toBeGreaterThanOrEqual(0);

    fireEvent.click(screen.getByText('Add a note'));
    expect(indexOfStop()).toBe(before);
    fireEvent.keyDown(screen.getByLabelText('Message the agent'), { key: 'Escape' });
    expect(indexOfStop()).toBe(before);
  });

  // The toggle sits in the card's `aside` slot, BEFORE the pinned group, and that placement is what
  // lets it vanish safely: removing it only widens the status sentence beside it, so the group keeps
  // its membership and Stop's right edge does not move under a cursor.
  it('keeps the note toggle out of the pinned group, so its coming and going cannot move Stop', () => {
    renderStrip();
    const membersWhenClosed = stopActionGroup().children.length;
    expect(stopActionGroup().contains(noteToggle())).toBe(false);

    fireEvent.click(screen.getByText('Add a note'));
    expect(stopActionGroup().children.length).toBe(membersWhenClosed);
    expect(stopActionGroup().lastElementChild).toBe(stopButton());
  });

  it('keeps Stop last in its group when Pause is hidden, and never wraps or re-stacks the group', () => {
    renderStrip({ canPause: false });
    const group = stopActionGroup();
    // Stop is the LAST child, so a right-anchored group pins its right edge regardless of what
    // sits before it. `justify-between`/`flex-col`/`flex-wrap` would each break that.
    expect(group.lastElementChild).toBe(stopButton());
    expect(group.className).not.toMatch(/justify-between|flex-col|flex-wrap/);
    expect(group.className).toMatch(/ml-auto/);
  });

  // The regression pin for the squish bug, restated as the geometry that now prevents it: on the
  // live row the status sentence is the ONLY flexible child, so it absorbs every pixel of shrink,
  // and everything after it refuses to shrink at all, so nothing can be compressed into. `truncate`
  // carries the overflow that clips the sentence itself. happy-dom resolves no container queries, so
  // the @max-* tiers are unobservable here and this structural check is what holds the line.
  it('makes the status the only flexible child of the live row', () => {
    renderStrip({ modelId: 'opus-4.8-max', mode: 'agent', autoReviewTools: true });
    const row = stopActionGroup().parentElement as HTMLElement;
    const status = row.firstElementChild as HTMLElement;

    expect(status.className).toMatch(/min-w-0/);
    expect(status.className).toMatch(/flex-1/);
    expect(status.className).toMatch(/truncate/);
    for (const sibling of Array.from(row.children).slice(1)) {
      expect((sibling as HTMLElement).className).toMatch(/shrink-0/);
    }
  });

  // The readout owns a line of its own, which would otherwise cost 24px of dead card in the taskless
  // windows between nodes where FlowRunMeta renders nothing at all.
  it('collapses the context line when there are no pills to show', () => {
    renderStrip({ modelId: undefined, mode: undefined, autoReviewTools: undefined });
    const row = stopActionGroup().parentElement as HTMLElement;
    const contextLine = row.previousElementSibling as HTMLElement;

    expect(contextLine.className).toMatch(/empty:hidden/);
    expect(contextLine.children.length).toBe(0);
  });

  describe('fast-mode readout', () => {
    it('labels speed and ChatGPT credit use separately while a Fast run is live', () => {
      // The composer — and its own Fast switch — is replaced by this strip during a run, so this
      // pill is the only place the multiplier is visible while it is being charged.
      renderStrip({ modelId: 'codex-gpt-5.6-sol-high', mode: 'agent', codexSpeed: 'fast' });
      const label = screen.getByText('Fast · 1.5× speed · 2.5× ChatGPT credits');
      expect(label).toBeInTheDocument();
      expect(label.className).toContain('@max-[22rem]:sr-only');
      expect(label.parentElement).toHaveAttribute(
        'title',
        'Fast mode on — 1.5× model speed at 2.5× ChatGPT credits per turn; API-key pricing differs',
      );
    });

    it('discloses Ultrafast and its multiplier on a model that offers it', () => {
      renderStrip({ modelId: 'codex-gpt-6-astra-high', mode: 'agent', codexSpeed: 'ultrafast' });
      expect(
        screen.getByText('Ultrafast · up to 8× speed · 8× ChatGPT credits'),
      ).toBeInTheDocument();
    });

    it('hides the Ultrafast pill on a model without the tier, which runs at standard speed', () => {
      renderStrip({ modelId: 'codex-gpt-6.1-sol-high', mode: 'agent', codexSpeed: 'ultrafast' });
      expect(screen.queryByText(/Ultrafast/)).toBeNull();
    });

    it('shows the per-model multiplier rather than a fixed one', () => {
      renderStrip({ modelId: 'codex-gpt-5.4-medium', mode: 'agent', codexSpeed: 'fast' });
      expect(screen.getByText('Fast · 1.5× speed · 2× ChatGPT credits')).toBeInTheDocument();
    });

    it.each([
      [
        'the flow runs standard',
        { modelId: 'codex-gpt-5.6-sol-high', codexSpeed: 'standard' as const },
      ],
      ['the flow carries no value', { modelId: 'codex-gpt-5.6-sol-high' }],
      // Claiming a cost that is not being charged is worse than saying nothing.
      [
        'the model has no priority tier',
        { modelId: 'codex-gpt-5.4-mini-high', codexSpeed: 'fast' as const },
      ],
      ['the node is not Codex', { modelId: 'opus-4.8-max', codexSpeed: 'fast' as const }],
      [
        'the picker id is stale',
        { modelId: 'codex-gpt-5.3-codex-high', codexSpeed: 'fast' as const },
      ],
      // KNOWN UNDER-REPORT, deliberate: a node that INHERITS its model writes no `model` into
      // _config, so the provider is unknown here. An inheriting Codex node really is billing at the
      // tier and shows nothing. Silence is the safe failure — the alternative is painting a credit
      // cost onto a Claude run that is not being charged one. autoPill can resolve this because it
      // may assume the Claude SDK default; a cost claim may not. Revisit if _config ever carries the
      // resolved account type.
      ['the node inherits its model', { codexSpeed: 'fast' as const }],
    ])('hides the pill when %s', (_label, over) => {
      renderStrip({ mode: 'agent', ...over });
      expect(screen.queryByText(/^Fast /)).toBeNull();
    });
  });

  describe('auto-mode readout', () => {
    it('reads on when the flow requested auto and the node can honour it', () => {
      renderStrip({ modelId: 'opus-4.8-max', mode: 'agent', autoReviewTools: true });
      expect(screen.getByText('Auto on')).toBeInTheDocument();
    });

    it('reads off when the flow turned auto off', () => {
      renderStrip({ modelId: 'opus-4.8-max', mode: 'agent', autoReviewTools: false });
      expect(screen.getByText('Auto off')).toBeInTheDocument();
    });

    // Codex has its own native reviewer (approvalsReviewer auto_review), so gating the pill on
    // "is this Claude?" would silently under-report every Codex node.
    it('reads on for a Codex node', () => {
      renderStrip({ modelId: 'codex-gpt-5.6-sol-high', mode: 'agent', autoReviewTools: true });
      expect(screen.getByText('Auto on')).toBeInTheDocument();
    });

    // A node that inherits its model writes no `model` into _config; the executor still resolves
    // auto through the SDK default, so the card must not treat "no model" as "no auto".
    it('reads on for a node that inherits its model', () => {
      renderStrip({ mode: 'agent', autoReviewTools: true });
      expect(screen.getByText('Auto on')).toBeInTheDocument();
    });

    // Auto reviews the planning phase too, so plan mode is a live axis rather than a carve-out — and
    // an unattended plan run is precisely where the reader needs the readout to speak.
    it('reads on in plan mode, which auto now covers', () => {
      renderStrip({ modelId: 'opus-4.8-max', mode: 'plan', autoReviewTools: true });
      expect(screen.getByText('Auto on')).toBeInTheDocument();
    });

    // Match the exact pill copy, never /^Auto/ — a model label can itself contain "Auto", so a
    // loose pattern reports the MODEL pill and the assertion stops testing anything.
    const autoPill = () => screen.queryByText(/^Auto (on|off)$/);

    // Where auto can never apply the pill says nothing rather than spending width on "unavailable".
    it('says nothing for a model with no native reviewer', () => {
      renderStrip({ modelId: 'haiku', mode: 'agent', autoReviewTools: true });
      expect(autoPill()).toBeNull();
    });

    it('says nothing when the task carries no auto consent at all', () => {
      renderStrip({ modelId: 'opus-4.8-max', mode: 'agent' });
      expect(autoPill()).toBeNull();
    });

    // A stale or foreign id resolves to no variant, exactly like "no model set" — but they mean
    // opposite things. Reading an unresolved id as Claude would feed the raw string to the Claude
    // version check, which passes anything that is not `haiku`, and claim auto for a retired node.
    // The model pill already hides here; the Auto pill hides with it.
    it('says nothing for a model id it cannot resolve', () => {
      renderStrip({ modelId: 'retired-model-x', mode: 'agent', autoReviewTools: false });
      expect(autoPill()).toBeNull();
      expect(screen.queryByText(/·/)).toBeNull(); // the model pill hides too
    });
  });
});

describe('FlowPausedBar', () => {
  beforeEach(() => {
    cancelMutate.mockReset();
  });
  afterEach(cleanup);

  function renderBar(
    overrides: {
      flowRunId?: string;
      isTurnActive?: boolean;
      modelId?: string;
      mode?: 'agent' | 'plan' | 'debug';
      onResume?: () => boolean;
      onSubmitAnswer?: (text: string) => boolean;
    } = {},
  ) {
    const onSubmitAnswer = vi.fn(() => true);
    const onResume = vi.fn(() => true);
    const onStopTurn = vi.fn();
    const props = {
      flowRunId: overrides.flowRunId ?? 'run1',
      isTurnActive: overrides.isTurnActive ?? false,
      modelId: overrides.modelId,
      mode: overrides.mode,
      onSubmitAnswer: overrides.onSubmitAnswer ?? onSubmitAnswer,
      onResume: overrides.onResume ?? onResume,
      onStopTurn,
    };
    const result = render(
      <FlowPausedBar
        flowRunId={props.flowRunId}
        subChatId="sub1"
        isTurnActive={props.isTurnActive}
        modelId={props.modelId}
        mode={props.mode}
        onSubmitAnswer={props.onSubmitAnswer}
        onResume={props.onResume}
        onStopTurn={props.onStopTurn}
      />,
    );
    return {
      onSubmitAnswer: props.onSubmitAnswer,
      onResume: props.onResume,
      onStopTurn,
      rerenderBar: (next: { flowRunId?: string; isTurnActive?: boolean }) =>
        result.rerender(
          <FlowPausedBar
            flowRunId={next.flowRunId ?? props.flowRunId}
            subChatId="sub1"
            isTurnActive={next.isTurnActive ?? props.isTurnActive}
            modelId={props.modelId}
            mode={props.mode}
            onSubmitAnswer={props.onSubmitAnswer}
            onResume={props.onResume}
            onStopTurn={props.onStopTurn}
          />,
        ),
      ...result,
    };
  }

  it('shows the model + mode readout', () => {
    renderBar({ modelId: 'sonnet-5', mode: 'plan' });
    expect(screen.getByText('Sonnet 5 · High')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
  });

  it('offers a reply box that rides the follow-up pipe', () => {
    const { onSubmitAnswer } = renderBar();
    const input = screen.getByPlaceholderText('Reply with new instructions…');
    fireEvent.change(input, { target: { value: 'change approach' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmitAnswer).toHaveBeenCalledWith('change approach');
  });

  // The paused bar's reply resumes the run; the strip's note joins the queue. Sharing a draft
  // between them would put an unsent mid-run note into a resume instruction.
  it('does not inherit the running strip’s note draft', () => {
    const strip = renderStrip();
    fireEvent.click(screen.getByText('Add a note'));
    fireEvent.change(screen.getByLabelText('Message the agent'), { target: { value: 'a note' } });
    strip.unmount();

    renderBar();
    expect(screen.getByPlaceholderText('Reply with new instructions…')).toHaveValue('');
  });

  it('pins Stop last in the action group, away from the reply box', () => {
    renderBar();
    const group = stopButton().closest('div');
    expect(group?.lastElementChild).toBe(stopButton());
    expect(group?.className).not.toMatch(/justify-between|flex-col|flex-wrap/);
  });

  it('fires onResume from the Resume button', () => {
    const { onResume } = renderBar();
    fireEvent.click(screen.getByText('Resume'));
    expect(onResume).toHaveBeenCalled();
  });

  it('locks Resume synchronously after one accepted click and shows progress', () => {
    const { onResume } = renderBar();
    const resume = screen.getByRole('button', { name: 'Resume' });

    fireEvent.click(resume);
    fireEvent.click(resume);

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resuming…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Stop')).not.toBeDisabled();
  });

  it('shares the single-shot lock between typed Reply and Resume', () => {
    const { onSubmitAnswer, onResume } = renderBar();
    const input = screen.getByPlaceholderText('Reply with new instructions…');
    fireEvent.change(input, { target: { value: 'change approach' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resuming…' }));

    expect(onSubmitAnswer).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
  });

  it('stays retryable when the guarded resume send is rejected synchronously', () => {
    const onResume = vi.fn(() => false);
    renderBar({ onResume });

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.queryByText('Resuming…')).toBeNull();
  });

  it('re-enables and reports failure when the turn ends while the run is still paused', () => {
    const { rerenderBar } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    rerenderBar({ isTurnActive: true });
    rerenderBar({ isTurnActive: false });

    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith('Flow did not resume', {
      description: 'The continuation ended while the flow was still paused. Try again.',
    });
  });

  it('leaves an errored continuation to its own error toast', () => {
    type StoredChat = ReturnType<typeof agentChatStore.get>;
    const getChat = vi
      .spyOn(agentChatStore, 'get')
      .mockReturnValue({ status: 'error' } as StoredChat);
    vi.mocked(toast.error).mockClear();
    const { rerenderBar } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    // A replacement Chat for the sub-chat must not decide how the sent continuation ended.
    getChat.mockReturnValue({ status: 'ready' } as StoredChat);
    rerenderBar({ isTurnActive: true });
    rerenderBar({ isTurnActive: false });

    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(toast.error).not.toHaveBeenCalledWith('Flow did not resume', expect.anything());
    getChat.mockRestore();
  });

  it('starts a different flow run unlocked', () => {
    const { rerenderBar } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('button', { name: 'Resuming…' })).toBeDisabled();

    rerenderBar({ flowRunId: 'run2' });

    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
  });

  it('Stop confirms before cancelling', () => {
    renderBar();
    fireEvent.click(screen.getByText('Stop'));
    fireEvent.click(screen.getByText('Confirm stop'));
    expect(cancelMutate).toHaveBeenCalledWith({ runId: 'run1' });
  });
});
