import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('../../db/repos/sub-chats', () => ({ updateSubChatMode: vi.fn(async () => {}) }));

import { computeClaudeSessionKey } from '../execution/claude-session/session-key';
import {
  adoptedTurnBeforePush,
  armAutoDuringPlan,
  armAutoReview,
  createModeFlip,
  denyPlanTransitionInWakeBurst,
  planAutoDenyFloor,
  reconcileAdoptedPermissionMode,
  resolveAutoReviewModes,
  resolvePermissionMode,
} from './plan-auto-approve';

/** A session whose `setPermissionMode` the test drives. */
function session(
  over: {
    autoReviewTools?: boolean;
    reject?: boolean;
    defer?: boolean;
    rejectModel?: boolean;
  } = {},
) {
  let release: (() => void) | undefined;
  const setPermissionMode = vi.fn(async (_mode: 'auto' | 'default' | 'plan') => {
    if (over.reject) throw new Error('Cannot set permission mode to auto: gate is not enabled');
    if (over.defer) await new Promise<void>((resolve) => (release = resolve));
  });
  const setModel = vi.fn(async (_model?: string) => {
    if (over.rejectModel) throw new Error('set_model failed');
  });
  const applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => {});
  return {
    session: {
      query: { setPermissionMode, setModel, applyFlagSettings },
      currentTurn: { autoReviewTools: over.autoReviewTools ?? false },
    },
    setPermissionMode,
    setModel,
    applyFlagSettings,
    release: () => release?.(),
  };
}

const LIVE = { model: undefined, effort: undefined, ultracode: false };

describe('armAutoReview', () => {
  it('sets the SDK mode BEFORE the abstain flag, never the other way round', async () => {
    // The ordering is the safety property, not a style choice: the flag makes Frink's PreToolUse
    // hook abstain, and an abstention falls through to a canUseTool that blanket-allows non-MCP
    // tools. Flag-set-first would silently allow the whole ask bucket while the SDK is still in
    // plan mode. Holding setPermissionMode unresolved proves the flag waits for it.
    const s = session({ defer: true });
    const pending = armAutoReview(s.session, true);

    await Promise.resolve();
    expect(s.setPermissionMode).toHaveBeenCalledWith('auto');
    expect(s.session.currentTurn.autoReviewTools).toBe(false);

    s.release();
    await pending;
    expect(s.session.currentTurn.autoReviewTools).toBe(true);
  });

  it('leaves the turn un-armed when the provider rejects the mode change', async () => {
    // A closed auto gate must degrade to today's prompting, never to an ungated turn.
    const s = session({ reject: true });
    await armAutoReview(s.session, true);
    expect(s.session.currentTurn.autoReviewTools).toBe(false);
  });

  it('does nothing when the turn is not eligible', async () => {
    const s = session();
    await armAutoReview(s.session, false);
    expect(s.setPermissionMode).not.toHaveBeenCalled();
    expect(s.session.currentTurn.autoReviewTools).toBe(false);
  });

  it('does not re-arm a turn that is already armed', async () => {
    const s = session({ autoReviewTools: true });
    await armAutoReview(s.session, true);
    expect(s.setPermissionMode).not.toHaveBeenCalled();
  });

  it('force re-arms an already-armed turn — the plan-auto implementation half needs the switch to auto', async () => {
    // A plan-auto turn sets the abstain flag DURING planning; at plan approval the query is back in a
    // non-auto mode, so the implementation half must be forced to 'auto' despite the flag being set.
    const s = session({ autoReviewTools: true });
    await armAutoReview(s.session, true, true);
    expect(s.setPermissionMode).toHaveBeenCalledWith('auto');
    expect(s.session.currentTurn.autoReviewTools).toBe(true);
  });

  it('tolerates a session with no current turn', async () => {
    const setPermissionMode = vi.fn(async () => {});
    await armAutoReview({ query: { setPermissionMode }, currentTurn: null }, true);
    expect(setPermissionMode).not.toHaveBeenCalled();
  });
});

/** A session driving `armAutoDuringPlan`: an `applyFlagSettings` (opt-in) and a `setPermissionMode`
 * that takes the plan→default→plan flip. */
function planSession(
  over: {
    autoReviewTools?: boolean;
    rejectFlag?: boolean;
    rejectMode?: boolean;
    rejectPlanLeg?: boolean;
    deferFlag?: boolean;
  } = {},
) {
  let release: (() => void) | undefined;
  const applyFlagSettings = vi.fn(async (_s: Record<string, boolean>) => {
    if (over.rejectFlag) throw new Error('flag settings rejected');
    if (over.deferFlag) await new Promise<void>((resolve) => (release = resolve));
  });
  const setPermissionMode = vi.fn(async (mode: 'default' | 'plan') => {
    if (over.rejectMode) throw new Error('Cannot set permission mode: gate is not enabled');
    // Simulate the 'default' leg resolving but the plan re-entry rejecting.
    if (over.rejectPlanLeg && mode === 'plan') throw new Error('plan re-entry rejected');
  });
  return {
    session: {
      query: { setPermissionMode, applyFlagSettings },
      currentTurn: { autoReviewTools: over.autoReviewTools ?? false },
    },
    applyFlagSettings,
    setPermissionMode,
    release: () => release?.(),
  };
}

describe('armAutoDuringPlan', () => {
  it('applies the opt-in BEFORE the plan transition, and the abstain flag only after both resolve', async () => {
    // shouldPlanUseAutoMode() reads skipAutoPermissionPrompt as the plan transition evaluates, so the
    // opt-in must land first. Holding applyFlagSettings unresolved proves setPermissionMode waits.
    const s = planSession({ deferFlag: true });
    const pending = armAutoDuringPlan(s.session);

    await Promise.resolve();
    expect(s.applyFlagSettings).toHaveBeenCalledWith({ skipAutoPermissionPrompt: true });
    expect(s.setPermissionMode).not.toHaveBeenCalled();
    expect(s.session.currentTurn.autoReviewTools).toBe(false);

    s.release();
    await pending;
    // The reviewer is armed by a plan→default→plan flip (the INTO-plan leg activates the classifier);
    // the query never touches 'auto'.
    expect(s.setPermissionMode).toHaveBeenNthCalledWith(1, 'default');
    expect(s.setPermissionMode).toHaveBeenNthCalledWith(2, 'plan');
    expect(s.setPermissionMode).not.toHaveBeenCalledWith('auto');
    expect(s.session.currentTurn.autoReviewTools).toBe(true);
  });

  it('leaves the turn un-armed when the opt-in is rejected (deny-floor then backstops)', async () => {
    const s = planSession({ rejectFlag: true });
    await armAutoDuringPlan(s.session);
    expect(s.setPermissionMode).not.toHaveBeenCalled();
    expect(s.session.currentTurn.autoReviewTools).toBe(false);
  });

  it('leaves the turn un-armed when the plan transition is rejected', async () => {
    const s = planSession({ rejectMode: true });
    await armAutoDuringPlan(s.session);
    expect(s.session.currentTurn.autoReviewTools).toBe(false);
  });

  it('restores plan mode when the re-entry leg fails — never strands the planning phase in default', async () => {
    // The 'default' leg resolved but the 'plan' re-entry rejected: the query must not be left in the
    // execution-permitting 'default'. armAutoDuringPlan attempts to restore 'plan' and leaves un-armed.
    const s = planSession({ rejectPlanLeg: true });
    await armAutoDuringPlan(s.session);
    expect(s.session.currentTurn.autoReviewTools).toBe(false);
    expect(s.setPermissionMode).toHaveBeenCalledWith('default');
    // 'plan' attempted twice: the flip's re-entry leg, then the restore in the catch.
    expect(s.setPermissionMode.mock.calls.filter(([mode]) => mode === 'plan')).toHaveLength(2);
  });

  it('does not re-arm a turn that is already armed', async () => {
    const s = planSession({ autoReviewTools: true });
    await armAutoDuringPlan(s.session);
    expect(s.applyFlagSettings).not.toHaveBeenCalled();
    expect(s.setPermissionMode).not.toHaveBeenCalled();
  });

  it('tolerates a session with no current turn', async () => {
    const s = planSession();
    await armAutoDuringPlan({ ...s.session, currentTurn: null });
    expect(s.applyFlagSettings).not.toHaveBeenCalled();
  });
});

describe('resolveAutoReviewModes', () => {
  it('a Claude plan turn arms DURING planning, not via the non-plan flag', () => {
    expect(resolveAutoReviewModes(true, 'claude', 'plan')).toEqual({
      nativeAutoReview: false,
      codexAutoReview: true,
      planAutoReview: true,
      autoReviewArmable: true,
    });
  });

  it('a Claude non-plan turn is native auto, never plan-auto', () => {
    expect(resolveAutoReviewModes(true, 'claude', 'agent')).toEqual({
      nativeAutoReview: true,
      codexAutoReview: true,
      planAutoReview: false,
      autoReviewArmable: true,
    });
  });

  it('Codex reviews plan turns too, but is never Claude-armable or plan-auto', () => {
    expect(resolveAutoReviewModes(true, 'codex', 'plan')).toEqual({
      nativeAutoReview: false,
      codexAutoReview: true,
      planAutoReview: false,
      autoReviewArmable: false,
    });
  });

  it('nothing is eligible when auto is unsupported', () => {
    expect(resolveAutoReviewModes(false, 'claude', 'plan')).toEqual({
      nativeAutoReview: false,
      codexAutoReview: false,
      planAutoReview: false,
      autoReviewArmable: false,
    });
  });
});

describe('resolvePermissionMode', () => {
  it('a plan turn (including plan-auto) opens in plan — read-only from t=0, never permissive', () => {
    expect(resolvePermissionMode('plan', false)).toBe('plan');
    expect(resolvePermissionMode('plan', true)).toBe('plan');
  });

  it('a non-plan auto turn opens in auto; otherwise default', () => {
    expect(resolvePermissionMode('agent', true)).toBe('auto');
    expect(resolvePermissionMode('agent', false)).toBe('default');
  });
});

describe('planAutoDenyFloor', () => {
  it('denies an abstained ask-bucket tool DURING PLANNING — the during-plan reviewer was inactive', () => {
    expect(planAutoDenyFloor(true, true, false, 'Bash')).toEqual({
      behavior: 'deny',
      message: expect.any(String),
    });
  });

  it('stops at plan submission — the implementation half blanket-allows like a normal auto turn', () => {
    // After ExitPlanMode the query is 'auto'; a tool the classifier defers to canUseTool must pass,
    // not be denied — this is the exact implementation-half regression the reviewer caught.
    expect(planAutoDenyFloor(true, true, true, 'Bash')).toBeNull();
  });

  it('lets REQUIRED_TOOLS through so the turn cannot brick itself', () => {
    expect(planAutoDenyFloor(true, true, false, 'ExitPlanMode')).toBeNull();
  });

  it('does not apply off a plan-auto turn or without the abstain flag', () => {
    expect(planAutoDenyFloor(false, true, false, 'Bash')).toBeNull();
    expect(planAutoDenyFloor(true, false, false, 'Bash')).toBeNull();
  });
});

describe('denyPlanTransitionInWakeBurst', () => {
  // The burst path bypasses the foreground stream's plan bookkeeping entirely, so an allowed
  // transition would lift/flip SDK plan mode with no card, no halt and no approval — unattended.
  it('denies ExitPlanMode and EnterPlanMode inside a wake burst', () => {
    expect(denyPlanTransitionInWakeBurst('ExitPlanMode', { isWakeBurst: true })).toMatchObject({
      behavior: 'deny',
    });
    expect(denyPlanTransitionInWakeBurst('EnterPlanMode', { isWakeBurst: true })).toMatchObject({
      behavior: 'deny',
    });
  });

  it('leaves every other burst tool and every foreground turn alone', () => {
    expect(denyPlanTransitionInWakeBurst('Bash', { isWakeBurst: true })).toBeNull();
    // A foreground plan turn submits through the full ExitPlanMode machinery — never denied here.
    expect(denyPlanTransitionInWakeBurst('ExitPlanMode', { isWakeBurst: false })).toBeNull();
    expect(denyPlanTransitionInWakeBurst('EnterPlanMode', { isWakeBurst: false })).toBeNull();
  });
});

describe('reconcileAdoptedPermissionMode', () => {
  it('aligns the adopted session to the mode a fresh session would open in', async () => {
    const { session: s, setPermissionMode } = session();
    // Plan follow-up over an agent-armed hold: the SDK must be read-only before the turn runs.
    expect(await reconcileAdoptedPermissionMode(s, 'plan', false)).toBe(true);
    expect(setPermissionMode).toHaveBeenLastCalledWith('plan');
    // Agent follow-up over a plan-armed hold: restore the ordinary gated mode.
    expect(await reconcileAdoptedPermissionMode(s, 'agent', false)).toBe(true);
    expect(setPermissionMode).toHaveBeenLastCalledWith('default');
    expect(await reconcileAdoptedPermissionMode(s, 'agent', true)).toBe(true);
    expect(setPermissionMode).toHaveBeenLastCalledWith('auto');
  });

  it('reports failure so the caller disposes instead of adopting an unproven mode', async () => {
    // A plan turn on a session stuck permissive would write files during drafting — the caller's
    // dispose+fresh fallback (which opens in 'plan') is the only safe path.
    const { session: s } = session({ reject: true });
    expect(await reconcileAdoptedPermissionMode(s, 'plan', false)).toBe(false);
  });
});

describe('adoptedTurnBeforePush', () => {
  type Params = Parameters<typeof adoptedTurnBeforePush>[0];
  const asAdopted = (s: ReturnType<typeof session>['session']) => s as unknown as Params['session'];
  const turnCtx = () => ({ msgId: 'adopting-turn' }) as unknown as Params['turn'];

  it('swaps the turn, then reconciles — a plan follow-up reaches SDK plan at the boundary', async () => {
    const { session: s, setPermissionMode, release } = session({ defer: true });
    const turn = turnCtx();
    const onTakeover = vi.fn();
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn,
      signal: new AbortController().signal,
      mode: 'plan',
      nativeAutoReview: false,
      live: LIVE,
      onTakeover,
    })();
    await Promise.resolve();
    // The swap precedes the (still-pending) mode write, so the reconcile acts on the new turn.
    expect(s.currentTurn).toBe(turn);
    expect(onTakeover).toHaveBeenCalledOnce();
    expect(setPermissionMode).toHaveBeenCalledWith('plan');
    release();
    expect(await push).toBe(true);
    expect(setPermissionMode).toHaveBeenCalledTimes(1);
  });

  it('agent follow-ups restore the ordinary gated (or auto) SDK mode', async () => {
    const { session: s, setPermissionMode } = session();
    const base = {
      session: asAdopted(s),
      turn: turnCtx(),
      signal: new AbortController().signal,
      live: LIVE,
    };
    expect(await adoptedTurnBeforePush({ ...base, mode: 'agent', nativeAutoReview: false })()).toBe(
      true,
    );
    expect(setPermissionMode).toHaveBeenLastCalledWith('default');
    expect(await adoptedTurnBeforePush({ ...base, mode: 'agent', nativeAutoReview: true })()).toBe(
      true,
    );
    expect(setPermissionMode).toHaveBeenLastCalledWith('auto');
  });

  it('aligns the session ultracode with the turn, clearing it with null', async () => {
    const { session: s, applyFlagSettings } = session();
    const base = { session: asAdopted(s), turn: turnCtx(), signal: new AbortController().signal };
    const push = (ultracode: boolean) =>
      adoptedTurnBeforePush({
        ...base,
        mode: 'agent',
        nativeAutoReview: false,
        live: { ...LIVE, ultracode },
      })();

    expect(await push(false)).toBe(true);
    expect(await push(true)).toBe(true);
    const ultra = applyFlagSettings.mock.calls.filter(([arg]) => 'ultracode' in arg);
    expect(ultra).toEqual([[{ ultracode: null }], [{ ultracode: true }]]);
  });

  it('an unavailable ultracode never refuses the takeover', async () => {
    const { session: s, applyFlagSettings } = session();
    applyFlagSettings.mockImplementation(async (arg: Record<string, unknown>) => {
      if ('ultracode' in arg) throw new Error('ultracode_unavailable');
    });
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: new AbortController().signal,
      mode: 'agent',
      nativeAutoReview: false,
      live: { ...LIVE, ultracode: true },
    });
    expect(await push()).toBe(true);
  });

  it('sets the turn model and effort on the session before the push', async () => {
    const { session: s, setModel, applyFlagSettings } = session();
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: new AbortController().signal,
      mode: 'agent',
      nativeAutoReview: false,
      live: { model: 'claude-opus-5-5', effort: 'low', ultracode: false },
    });
    expect(await push()).toBe(true);
    expect(setModel).toHaveBeenCalledWith('claude-opus-5-5');
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'low' });
  });

  it('clears the effort to the default and never sets max live', async () => {
    const { session: s, applyFlagSettings } = session();
    const base = { session: asAdopted(s), turn: turnCtx(), signal: new AbortController().signal };
    const push = (effort?: string) =>
      adoptedTurnBeforePush({
        ...base,
        mode: 'agent',
        nativeAutoReview: false,
        live: { ...LIVE, effort },
      })();
    expect(await push(undefined)).toBe(true);
    expect(await push('max')).toBe(true);
    const effort = applyFlagSettings.mock.calls.filter(([arg]) => 'effortLevel' in arg);
    expect(effort).toEqual([[{ effortLevel: null }]]);
  });

  it('sets the effort after clearing Ultra, which would otherwise leave the CLI at xhigh', async () => {
    const { session: s, applyFlagSettings } = session();
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: new AbortController().signal,
      mode: 'agent',
      nativeAutoReview: false,
      live: { model: undefined, effort: 'high', ultracode: false },
    });
    expect(await push()).toBe(true);
    expect(applyFlagSettings.mock.calls).toEqual([
      [{ ultracode: null }],
      [{ effortLevel: 'high' }],
    ]);
  });

  it('refuses a session spawned on the other side of max effort, which has no live setting', async () => {
    const { session: s, setModel } = session();
    const keyed = (effort: string) =>
      Object.assign(s, { keyParts: computeClaudeSessionKey({ effort }, undefined) });
    const push = (effort: string) =>
      adoptedTurnBeforePush({
        session: asAdopted(s),
        turn: turnCtx(),
        signal: new AbortController().signal,
        mode: 'agent',
        nativeAutoReview: false,
        live: { ...LIVE, effort },
      })();

    keyed('max');
    expect(await push('low')).toBe(false);
    keyed('high');
    expect(await push('max')).toBe(false);
    expect(setModel).not.toHaveBeenCalled();
    keyed('max');
    expect(await push('max')).toBe(true);
  });

  it('a refused model change reruns the turn fresh', async () => {
    const { session: s } = session({ rejectModel: true });
    const onSetterRejected = vi.fn();
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: new AbortController().signal,
      mode: 'agent',
      nativeAutoReview: false,
      live: { ...LIVE, model: 'claude-opus-5-5' },
      onSetterRejected,
    });
    expect(await push()).toBe(false);
    expect(onSetterRejected).toHaveBeenCalledOnce();
  });

  it('a refused reconcile aborts the takeover so the follow-up reruns fresh', async () => {
    // false makes the pump finish 'interrupted' and reject the unpushed takeover adopt-refused;
    // the executor's retry then opens a fresh session, which starts in the right mode natively.
    const { session: s } = session({ reject: true });
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: new AbortController().signal,
      mode: 'plan',
      nativeAutoReview: false,
      live: LIVE,
    });
    expect(await push()).toBe(false);
  });

  it('an abort landing during the deferred reconcile still refuses the push', async () => {
    // The trailing signal re-check is load-bearing: without it a Stop that lands while
    // setPermissionMode awaits would still push the user message into a turn nobody owns.
    const { session: s, setPermissionMode, release } = session({ defer: true });
    const controller = new AbortController();
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: controller.signal,
      mode: 'agent',
      nativeAutoReview: false,
      live: LIVE,
    })();
    await Promise.resolve();
    expect(setPermissionMode).toHaveBeenCalledWith('default');
    controller.abort();
    release();
    expect(await push).toBe(false);
  });

  it('a pre-aborted signal refuses before touching the session', async () => {
    const { session: s, setPermissionMode } = session();
    const controller = new AbortController();
    controller.abort();
    const untouched = s.currentTurn;
    const onTakeover = vi.fn();
    const push = adoptedTurnBeforePush({
      session: asAdopted(s),
      turn: turnCtx(),
      signal: controller.signal,
      mode: 'agent',
      nativeAutoReview: false,
      live: LIVE,
      onTakeover,
    });
    expect(await push()).toBe(false);
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(onTakeover).not.toHaveBeenCalled();
    expect(s.currentTurn).toBe(untouched);
  });
});

describe('createModeFlip', () => {
  it('flips once and only for an auto-approved plan, notifying after the row write lands', async () => {
    const notify = vi.fn();
    const flip = createModeFlip('sub-1', true, notify);
    flip();
    flip();
    // The broadcast must trail the persisted write (the row owns the mode); it is async.
    expect(notify).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

    const skipped = vi.fn();
    createModeFlip('sub-1', false, skipped)();
    await Promise.resolve();
    expect(skipped).not.toHaveBeenCalled();
  });

  it('suppresses the broadcast when the row write fails — the mirror must not lead the authority', async () => {
    const { updateSubChatMode } = await import('../../db/repos/sub-chats');
    vi.mocked(updateSubChatMode).mockRejectedValueOnce(new Error('disk full'));
    const notify = vi.fn();
    createModeFlip('sub-2', true, notify)();
    await Promise.resolve();
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });
});
