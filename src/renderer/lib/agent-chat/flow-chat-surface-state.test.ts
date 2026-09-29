import { describe, expect, it } from 'vitest';
import type { TaskResultRecord } from '../../../shared/types/task-result';
import {
  deriveFlowChatBottomSurface,
  deriveParkSurfaceState,
  getFlowSurfaceRefetchInterval,
} from './flow-chat-surface-state';

/** What a reply park resolves to when the agent signal carried no prose of its own. */
const DEFAULT_ASK = 'The agent needs your input to continue.';

const QUESTIONS = [
  {
    header: 'Path',
    question: 'which',
    options: [{ label: 'Now', description: '' }],
    multiSelect: false,
  },
];

type AgentSignalFixture = { state: string; questions?: typeof QUESTIONS; summary?: string };

const parked = (state: string, questions?: typeof QUESTIONS, summary?: string) => {
  const agentSignal: AgentSignalFixture = { state };
  if (questions !== undefined) agentSignal.questions = questions;
  if (summary !== undefined) agentSignal.summary = summary;
  return { status: 'needs_attention', result: { agentSignal } };
};

describe('deriveParkSurfaceState', () => {
  it('maps a non-parked task to none', () => {
    expect(deriveParkSurfaceState({ status: 'running' })).toEqual({ kind: 'none' });
    expect(deriveParkSurfaceState(null)).toEqual({ kind: 'none' });
  });

  it('maps a transient park (usage limit / API error) to none — TaskControls owns those', () => {
    expect(
      deriveParkSurfaceState({ status: 'needs_attention', result: { usageLimit: { at: 1 } } }),
    ).toEqual({ kind: 'none' });
    expect(
      deriveParkSurfaceState({ status: 'needs_attention', result: { apiError: { status: 500 } } }),
    ).toEqual({ kind: 'none' });
  });

  it('maps a user-pause park to none — the paused bar owns it', () => {
    expect(
      deriveParkSurfaceState({ status: 'needs_attention', result: { userPause: { at: 'x' } } }),
    ).toEqual({ kind: 'none' });
  });

  it('maps awaiting_input WITH questions to the card', () => {
    expect(deriveParkSurfaceState(parked('awaiting_input', QUESTIONS))).toEqual({
      kind: 'questions',
      questions: QUESTIONS,
    });
  });

  it('maps awaiting_input WITHOUT questions to the reply box, carrying the summary', () => {
    expect(deriveParkSurfaceState(parked('awaiting_input', undefined, 'how verify?'))).toEqual({
      kind: 'reply',
      summary: 'how verify?',
    });
    expect(deriveParkSurfaceState(parked('awaiting_input', []))).toEqual({
      kind: 'reply',
      summary: DEFAULT_ASK,
    });
  });

  it('maps blocked / partial parks to the reply box (questions only ride awaiting_input)', () => {
    expect(deriveParkSurfaceState(parked('blocked', QUESTIONS, 'stuck'))).toEqual({
      kind: 'reply',
      summary: 'stuck',
    });
    expect(deriveParkSurfaceState(parked('partial'))).toEqual({
      kind: 'reply',
      summary: DEFAULT_ASK,
    });
  });

  it('maps a park with no agentSignal at all to the reply box', () => {
    expect(deriveParkSurfaceState({ status: 'needs_attention', result: {} })).toEqual({
      kind: 'reply',
      summary: DEFAULT_ASK,
    });
  });
});

const RUN = { id: 'run-1' };

type SurfaceData = Parameters<typeof deriveFlowChatBottomSurface>[0];

/** The query the surface consumes, spread as positional args so each case stays a one-liner. */
const surface = (
  run: NonNullable<SurfaceData>['run'],
  task: NonNullable<SurfaceData>['task'],
  subChatMode?: NonNullable<SurfaceData>['subChatMode'],
) => deriveFlowChatBottomSurface({ run, task, subChatMode });

describe('deriveFlowChatBottomSurface', () => {
  it('non-flow chats and terminal runs always get the composer', () => {
    // No live run is the ONLY thing that hands the composer back wholesale — a terminal run
    // resolves to null, whatever task the caller happens to hold.
    expect(surface(null, null)).toEqual({ kind: 'composer' });
    expect(surface(null, { status: 'running' })).toEqual({ kind: 'composer' });
    expect(
      surface(null, {
        status: 'needs_attention',
        result: { agentSignal: { state: 'awaiting_input', summary: 'stale' } },
      }),
    ).toEqual({ kind: 'composer' });
  });

  it('a running driving task shows the running strip, pausable', () => {
    expect(surface(RUN, { status: 'running', result: {} })).toEqual({
      kind: 'running',
      flowRunId: 'run-1',
      canPause: true,
      mode: 'agent',
    });
  });

  it('holds the strip through the taskless window between two nodes', () => {
    // No task row exists at all: before the run's first task, or while a non-agent node runs. The
    // run is still burning tokens — a composer here invites a keystroke that would abort the next
    // node's turn. Pause is hidden: parkFlowTaskForSubChat needs a `running` task and finds none.
    expect(surface(RUN, null)).toEqual({
      kind: 'running',
      flowRunId: 'run-1',
      canPause: false,
    });
  });

  it('holds the strip for a TERMINAL task under a live run — a task is never the run’s liveness', () => {
    // Node N finished; node N+1's task does not exist yet (the watcher has not ticked, and the
    // executor has not stamped result.subChatId).
    for (const status of ['done', 'completed']) {
      expect(surface(RUN, { status, result: {} })).toEqual({
        kind: 'running',
        flowRunId: 'run-1',
        canPause: false,
        mode: 'agent',
      });
    }
  });

  it('offers Pause only for a running task (park helper refuses the rest)', () => {
    expect(surface(RUN, { status: 'pending', result: {} })).toMatchObject({
      kind: 'running',
      canPause: false,
    });
  });

  it('a batch member gets Pause and the paused bar exactly as any flow (decision flow-run-chat-surface, 2026-09-16 re-target)', () => {
    // A batch member's run carries no field here that distinguishes it from any other flow's —
    // canPause and the paused surface ride the same task-status checks for both.
    expect(surface(RUN, { status: 'running', result: {} })).toMatchObject({
      kind: 'running',
      canPause: true,
    });
    expect(surface(RUN, { status: 'needs_attention', result: { userPause: { at: 'x' } } })).toEqual(
      { kind: 'paused', flowRunId: 'run-1', mode: 'agent' },
    );
  });

  it('a user-pause park shows the paused bar', () => {
    expect(
      surface(RUN, {
        status: 'needs_attention',
        result: { userPause: { at: 'x' } },
      }),
    ).toEqual({ kind: 'paused', flowRunId: 'run-1', mode: 'agent' });
  });

  it('a user-input park shows the park surface', () => {
    expect(
      surface(RUN, {
        status: 'needs_attention',
        result: { agentSignal: { state: 'awaiting_input', summary: 'which path?' } },
      }),
    ).toEqual({ kind: 'park' });
  });

  it('a transient park (api error) keeps the composer — TaskControls owns Carry on', () => {
    expect(
      surface(RUN, {
        status: 'needs_attention',
        result: { apiError: { status: 500 } },
      }),
    ).toEqual({ kind: 'composer' });
  });

  it('plan_ready keeps the composer (plan card owns approval)', () => {
    expect(surface(RUN, { status: 'plan_ready', result: {} })).toEqual({
      kind: 'composer',
    });
  });

  it('failed keeps the composer (TaskControls owns Carry on / Retry)', () => {
    expect(surface(RUN, { status: 'failed', result: {} })).toEqual({
      kind: 'composer',
    });
  });

  it('a cancelled task under a LIVE run keeps the composer — it is the resume surface', () => {
    // A restart-interrupted run reaches here live: the boot sweep cancels the TASK while its
    // flow_run stays `paused`. The chat reply + InterruptedRunControls resume it (decision
    // flow-run-restart-recovery, which rejected blocking the input); the strip must not hide them.
    expect(
      surface(RUN, {
        status: 'cancelled',
        result: { error: 'Interrupted by an app restart' },
      }),
    ).toEqual({ kind: 'composer' });
  });
});

describe('running/paused readout carries the node model + mode', () => {
  it('reads model + mode from the dispatched Config', () => {
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { model: 'opus-4.8-max', startMode: 'plan' } },
        result: {},
      }),
    ).toEqual({
      kind: 'running',
      flowRunId: 'run-1',
      canPause: true,
      modelId: 'opus-4.8-max',
      mode: 'plan',
    });
  });

  // The mode a node was DISPATCHED in stops being the mode it is RUNNING in the moment an
  // auto-approved plan node starts implementing, so the live sub-chat mode outranks both snapshots.
  it('the live sub-chat mode wins over both task snapshots, on either surface', () => {
    const planNode = { Config: { model: 'opus-4.8-max', startMode: 'plan' } };
    expect(
      surface(RUN, { status: 'running', triggerContext: planNode, result: {} }, 'agent'),
    ).toMatchObject({ kind: 'running', mode: 'agent' });
    expect(
      surface(
        RUN,
        { status: 'needs_attention', triggerContext: planNode, result: { userPause: { at: 'x' } } },
        'agent',
      ),
    ).toMatchObject({ kind: 'paused', mode: 'agent' });
  });

  // Main's own contract (task-executor's extractResultStartMode): result is the task's CURRENT mode,
  // Config the ORIGINAL node config. Reading Config first mis-reported a parked plan node a human
  // carried on manually, since that path rewrites result.startMode alone.
  it('prefers result.startMode over the original Config when no live mode is known', () => {
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { startMode: 'plan' } },
        result: { startMode: 'execute' },
      }),
    ).toMatchObject({ mode: 'agent' });
  });

  // The window a live mode opens: the new node's task row is not visible to the surface until its
  // mode has been written (reuseWithTaskMode runs before result.subChatId is stamped), so the
  // surface briefly pairs the PREVIOUS node's terminal task with the NEW node's mode. Mode leading
  // the task is the harmless direction — the alternative is a pill that is simply wrong all run.
  it('shows the incoming mode against the previous node’s terminal task', () => {
    expect(
      surface(
        RUN,
        { status: 'done', triggerContext: { Config: { startMode: 'execute' } }, result: {} },
        'plan',
      ),
    ).toMatchObject({ kind: 'running', canPause: false, mode: 'plan' });
  });

  it('a taskless window still reports no mode at all, live mode or not', () => {
    expect(surface(RUN, null, 'plan')).toEqual({
      kind: 'running',
      flowRunId: 'run-1',
      canPause: false,
    });
  });

  it('falls back to result, and defaults mode to agent when no startMode is named', () => {
    expect(surface(RUN, { status: 'running', result: { model: 'sonnet-5' } })).toEqual({
      kind: 'running',
      flowRunId: 'run-1',
      canPause: true,
      modelId: 'sonnet-5',
      mode: 'agent',
    });
  });

  it('the paused bar carries the node model + mode too', () => {
    expect(
      surface(RUN, {
        status: 'needs_attention',
        triggerContext: { Config: { model: 'opus-4.8-max', startMode: 'plan' } },
        result: { userPause: { at: 'x' } },
      }),
    ).toEqual({ kind: 'paused', flowRunId: 'run-1', modelId: 'opus-4.8-max', mode: 'plan' });
  });

  it('reads the canonical tRPC `Config` key', () => {
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { model: 'opus-4.8-max', startMode: 'plan' } },
        result: {},
      }),
    ).toMatchObject({ modelId: 'opus-4.8-max', mode: 'plan' });
  });

  // Auto consent rides the SAME `Config` the model and mode come from, so the readout reports the
  // Flow's own setting for the whole run rather than a per-turn snapshot.
  it('carries the flow’s auto-review consent from Config, on both surfaces', () => {
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { model: 'opus-4.8-max', autoReviewTools: true } },
        result: {},
      }),
    ).toMatchObject({ kind: 'running', autoReviewTools: true });
    expect(
      surface(RUN, {
        status: 'needs_attention',
        triggerContext: { Config: { autoReviewTools: false } },
        result: { userPause: { at: 'x' } },
      }),
    ).toMatchObject({ kind: 'paused', autoReviewTools: false });
  });

  it('carries the flow’s Codex speed from Config, on both surfaces', () => {
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { model: 'codex-gpt-5.6-sol-high', codexSpeed: 'ultrafast' } },
        result: {},
      }),
    ).toMatchObject({ kind: 'running', codexSpeed: 'ultrafast' });
    expect(
      surface(RUN, {
        status: 'needs_attention',
        triggerContext: { Config: { codexSpeed: 'standard' } },
        result: { userPause: { at: 'x' } },
      }),
    ).toMatchObject({ kind: 'paused', codexSpeed: 'standard' });
    // Absent means "not flow-dispatched / no value", which the pill must not read as on.
    expect(
      surface(RUN, { status: 'running', triggerContext: { Config: {} }, result: {} }),
    ).toMatchObject({ codexSpeed: undefined });
  });

  it('reads auto-review consent from the canonical tRPC `Config` key', () => {
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { autoReviewTools: true } },
        result: {},
      }),
    ).toMatchObject({ autoReviewTools: true });
  });

  // `undefined` means "this task predates the flag / is not flow-dispatched", which the card must
  // be able to tell apart from an explicit `false` — one renders no pill, the other renders "off".
  it('leaves auto-review undefined when the task names no consent', () => {
    // toEqual, not a property read: the surface is a union whose composer member has no such key.
    // An exact match also fails loudly if a defined value ever appears here.
    expect(
      surface(RUN, {
        status: 'running',
        triggerContext: { Config: { model: 'sonnet-5' } },
        result: {},
      }),
    ).toEqual({
      kind: 'running',
      flowRunId: 'run-1',
      canPause: true,
      modelId: 'sonnet-5',
      mode: 'agent',
    });
  });
});

describe('getFlowSurfaceRefetchInterval', () => {
  it('polls fast while running, parked cadence while waiting, off when idle', () => {
    expect(
      getFlowSurfaceRefetchInterval({ run: RUN, task: { status: 'running', result: {} } }),
    ).toBe(3500);
    expect(
      getFlowSurfaceRefetchInterval({
        run: RUN,
        task: { status: 'needs_attention', result: { userPause: { at: 'x' } } },
      }),
    ).toBe(5000);
    expect(getFlowSurfaceRefetchInterval({ run: null, task: { status: 'completed' } })).toBe(false);
    expect(getFlowSurfaceRefetchInterval(null)).toBe(false);
    // Non-flow parked task still polls at the parked cadence (ParkAnswerSurface reads it).
    expect(
      getFlowSurfaceRefetchInterval({ run: null, task: { status: 'needs_attention', result: {} } }),
    ).toBe(5000);
  });

  // A restart-interrupted run is CANCELLED, so there is no live run and the surface shows the
  // composer + Resume. The resume itself happens in the main process (the executor's follow-up turn,
  // or rerunRun) with no renderer invalidation — so if the poll switches off here, the run going
  // live again is never observed and the composer sticks for the rest of the session.
  it('keeps polling a cancelled task with no live run, so a resume is picked up', () => {
    expect(
      getFlowSurfaceRefetchInterval({ run: null, task: { status: 'cancelled', result: {} } }),
    ).toBe(5000);
    // Genuinely finished work stays off — this is not "poll every terminal chat".
    expect(getFlowSurfaceRefetchInterval({ run: null, task: { status: 'completed' } })).toBe(false);
    expect(getFlowSurfaceRefetchInterval({ run: null, task: { status: 'done' } })).toBe(false);
  });

  it('never switches polling off while a run is live, whatever the task says', () => {
    // The invariant that turns the composer regression from sticky back into self-healing: keying
    // the interval off the DERIVED SURFACE let a `done` task (the taskless window) return false, so
    // the query stopped polling mid-run and never picked the next node up.
    const tasks: Array<{ status: string; result?: TaskResultRecord } | null> = [
      null, // taskless window between two nodes
      { status: 'done', result: {} }, // the node that just finished
      { status: 'plan_ready', result: {} }, // plan gate — composer, but still live
      { status: 'failed', result: {} }, // TaskControls' Carry on — still live
      { status: 'cancelled', result: {} }, // restart-interrupted — resumable, still live
      { status: 'needs_attention', result: { apiError: { status: 500 } } }, // transient park
    ];
    for (const task of tasks) {
      expect(getFlowSurfaceRefetchInterval({ run: RUN, task })).not.toBe(false);
    }
  });
});
