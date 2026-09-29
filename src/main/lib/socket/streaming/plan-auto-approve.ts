/**
 * What happens when a plan is AUTO-approved — the flip out of plan mode, and arming the provider
 * reviewer for the rest of that turn.
 *
 * An auto-approved plan node implements in the SAME turn it planned in (the turn is only
 * interrupted when a human has to approve), so it opens in `permissionMode: 'plan'` and nothing
 * else would ever re-arm it: every tool of the implementation half would prompt, on a run nobody is
 * watching. See decision `auto-mode-tool-approval`.
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { supportsNativeAutoReview } from '../../../../shared/lib/models';
import { type ExecutionSettings, parseClaudeModel } from '../../../../shared/types/execution';
import { REQUIRED_TOOLS } from '../../../../shared/types/permissions';
import { getDatabase } from '../../db';
import { withSubChatLock } from '../../db/repos/sub-chat-mutex';
import { updateSubChatMode } from '../../db/repos/sub-chats';
import { captureContained } from '../../sentry';
import type { ClaudeTurnContext } from '../claude-turn-context';
import { attachTurn } from '../execution/claude-session/attach';
import { PLAN_MODE_EXIT_REMINDER } from '../operator-reminders';
import { effortKeyPart } from '../execution/claude-session/session-key';

/** Whether the send's Auto consent runs natively on its provider and model (the SDK default model
 * included). The send and the pre-warm share it: it feeds the CLI env their session keys compare. */
export function isAutoReviewSupported(
  settings: ExecutionSettings | undefined,
  accountType: string,
): boolean {
  return (
    settings?.autoReviewTools === true &&
    supportsNativeAutoReview(accountType, parseClaudeModel(settings.model), {
      allowClaudeSdkDefault: true,
    })
  );
}

/** Per-runtime Auto-review eligibility, kept as ONE decision so the three-way split can't be silently
 * collapsed onto a single predicate (a prior regression). See decision `auto-mode-tool-approval`:
 * `nativeAutoReview` = non-plan Claude 'auto' / Codex env gate; `codexAutoReview` = Codex reviews plan
 * turns too (no planning-phase carve-out); `planAutoReview` = a Claude plan turn arms DURING planning
 * (plan→default→plan flip); `autoReviewArmable` = Claude-only (arming goes through setPermissionMode). */
export function resolveAutoReviewModes(
  autoReviewSupported: boolean,
  agentRuntime: 'claude' | 'codex',
  mode: string,
): {
  nativeAutoReview: boolean;
  codexAutoReview: boolean;
  planAutoReview: boolean;
  autoReviewArmable: boolean;
} {
  return {
    nativeAutoReview: autoReviewSupported && mode !== 'plan',
    codexAutoReview: autoReviewSupported,
    planAutoReview: agentRuntime === 'claude' && autoReviewSupported && mode === 'plan',
    autoReviewArmable: agentRuntime === 'claude' && autoReviewSupported,
  };
}

/** The SDK permissionMode a turn opens in. A plan turn (including plan-auto) opens in 'plan' — its
 * read-only restriction holds from t=0 — and armAutoDuringPlan later arms the reviewer in place. */
export function resolvePermissionMode(
  mode: string,
  nativeAutoReview: boolean,
): 'auto' | 'plan' | 'default' {
  if (mode === 'plan') return 'plan';
  return nativeAutoReview ? 'auto' : 'default';
}

/**
 * Deny plan-mode transitions inside a between-turn wake burst — a SECURITY control, not hygiene.
 * A burst is driven by the pump's own transformer and never reaches the foreground stream's plan
 * bookkeeping (`trackToolInputChunk` / `handleExitPlanModeCompletion`): an allowed ExitPlanMode
 * would lift the SDK's plan restrictions with no card, no submission halt and no approval — an
 * unattended chat could then write files across later bursts. EnterPlanMode is the same hole
 * mirrored: the SDK would flip to plan with frink's DB and UI unaware. Both wait for a foreground
 * turn, where the full machinery runs. Returned in canUseTool's deny shape; the PreToolUse hook
 * adapts it — the hook is the authoritative layer, since Auto mode can resolve permissions before
 * canUseTool is ever consulted.
 */
export function denyPlanTransitionInWakeBurst(
  toolName: string,
  turn: { isWakeBurst: boolean },
): { behavior: 'deny'; message: string } | null {
  if (!turn.isWakeBurst) return null;
  if (toolName === 'ExitPlanMode') {
    return {
      behavior: 'deny',
      // States only what the deny itself guarantees. Whether a card reaches the user is decided at
      // burst end (emitBurstPlanCard), so promising one here would reassure the model on the very
      // paths that emit none — the silent dead end this hook's caller exists to remove.
      message:
        'Plan submission cannot run during a background wake. Write the finished plan to your plan file and stop; do not run further tools.',
    };
  }
  if (toolName === 'EnterPlanMode') {
    return {
      behavior: 'deny',
      message: 'Mode changes are not available during a background wake.',
    };
  }
  return null;
}

type AdoptableSession = {
  query: Pick<Query, 'setPermissionMode' | 'setModel' | 'applyFlagSettings'>;
  /** The spawn key; only its `max`-effort part matters here. */
  keyParts?: Record<string, string>;
};

/** The turn's live-settable options; model and effort are outside the spawn key. */
export type LiveTurnSettings = {
  model: string | undefined;
  effort: string | undefined;
  ultracode: boolean;
};

/**
 * Set the turn's model and effort on a session it did not spawn. `max` has no live tier and stays
 * in the spawn key, so it is never set here. False when the CLI refuses: the turn reruns fresh.
 */
async function reconcileLiveModelAndEffort(
  session: AdoptableSession,
  live: LiveTurnSettings,
): Promise<boolean> {
  // `max` cannot be set or unset live, so a held session spawned on the other side of it is refused.
  const spawnedEffort = session.keyParts?.effort;
  if (spawnedEffort !== undefined && spawnedEffort !== effortKeyPart(live.effort)) return false;
  try {
    await session.query.setModel(live.model);
    if (live.effort !== 'max') {
      const effortLevel = (live.effort ?? null) as Parameters<
        Query['applyFlagSettings']
      >[0]['effortLevel'];
      await session.query.applyFlagSettings({ effortLevel });
    }
    return true;
  } catch (err) {
    log.warn(
      '[Socket Executor] Could not set model/effort on a live session — starting fresh:',
      err,
    );
    return false;
  }
}

/**
 * Align an adopted held session's SDK permission mode with the adopting turn — the mode a FRESH
 * session would open in ({@link resolvePermissionMode}). Cross-mode adoption is the point:
 * refusing it disposed the held session, and the CLI kills live background work on stdin close —
 * the exact defect the wake hold exists to prevent (and the mismatch can be automatic: the
 * transport flips a parked plan sub-chat to agent on submit). Returns false on failure so the
 * takeover aborts (adopt-refused) and the follow-up reruns on a fresh session: a session whose
 * mode cannot be proven is not safe to adopt — a plan follow-up on a still-permissive session
 * would write files during drafting.
 */
export async function reconcileAdoptedPermissionMode(
  session: AdoptableSession,
  mode: string,
  nativeAutoReview: boolean,
): Promise<boolean> {
  try {
    await session.query.setPermissionMode(resolvePermissionMode(mode, nativeAutoReview));
    return true;
  } catch (err) {
    log.warn(
      '[Socket Executor] Could not reconcile adopted session permission mode — disposing and starting fresh:',
      err,
    );
    return false;
  }
}

type AdoptedSession = AdoptableSession & Parameters<typeof attachTurn>[0];

/**
 * Align an adopted session's Ultra orchestration (`ultracode`, a flag-tier setting) with the adopting
 * turn. A held session keeps its spawn options, and an Ultra turn's running Workflow is exactly what
 * holds it, so without this a follow-up on a lower tier would keep orchestrating. `null` clears the
 * key. Best-effort: a refusal (e.g. `ultracode_unavailable`) is reported, never fails the turn.
 */
async function reconcileAdoptedUltracode(
  session: AdoptableSession,
  ultracode: boolean,
): Promise<void> {
  try {
    await session.query.applyFlagSettings({ ultracode: ultracode || null });
  } catch (err) {
    log.warn('[Socket Executor] Could not reconcile adopted session ultracode:', err);
    captureContained(err, { surface: 'socket-executor', stage: 'adopted-ultracode-reconcile' });
  }
}

/**
 * The `beforePush` of a turn taking over a live session: a held one's `startTurn`, or a claimed
 * idle one's `runTurn`. It runs after any in-flight wake burst's result, right before the push.
 *
 * The attach and the permission-mode reconcile land there: reconciling at adoption time changed
 * SDK policy under a still-streaming burst (a plan-armed hold's read-only layer could lift).
 *
 * False → adopt-refused: the turn reruns on a fresh CLI (opened in the right mode natively), and
 * the refused session is disposed.
 */
export function adoptedTurnBeforePush(params: {
  session: AdoptedSession;
  turn: ClaudeTurnContext;
  signal: AbortSignal;
  mode: string;
  nativeAutoReview: boolean;
  /** The turn's model, effort and Ultra state, set on the session before the push. */
  live: LiveTurnSettings;
  /** Runs with the attach: the turn's own session-wide bindings (its MCP channel). */
  onTakeover?: () => void;
  /** A refused reconcile on a turn that was not aborted (an abort closed the query itself). */
  onSetterRejected?: () => void;
}): () => Promise<boolean> {
  const { session, turn, signal, mode, nativeAutoReview } = params;
  return async () => {
    if (signal.aborted) return false;
    attachTurn(session, turn, params.onTakeover);
    if (await reconcileAdoptedPermissionMode(session, mode, nativeAutoReview)) {
      // A live switch out of plan gets the CLI's own exit reminder; ours would repeat it.
      turn.pendingReminders = turn.pendingReminders.filter((r) => r !== PLAN_MODE_EXIT_REMINDER);
      // Ultra first: clearing it leaves the CLI at xhigh until an effort is set after it.
      await reconcileAdoptedUltracode(session, params.live.ultracode);
      if (await reconcileLiveModelAndEffort(session, params.live)) return !signal.aborted;
    }
    if (!signal.aborted) params.onSetterRejected?.();
    return false;
  };
}

/** Plan-auto deny-floor — a PLANNING-PHASE fail-safe. While planning (before ExitPlanMode) the
 * PreToolUse hook abstains so the during-plan classifier decides the ask bucket; an ask-bucket tool
 * reaching canUseTool proves that classifier is inactive, so it fails safe as a deny rather than a
 * silent blanket allow. It stops at `planSubmitted`: the implementation half runs as a normal 'auto'
 * turn (armAutoReview switched the query to 'auto'), where a tool the classifier defers to canUseTool
 * must blanket-allow exactly like the non-plan auto path — denying it would brick the implementation.
 * REQUIRED_TOOLS (ExitPlanMode/TodoWrite/…) always pass: they reach canUseTool but are agent infra. */
export function planAutoDenyFloor(
  planAutoReview: boolean,
  autoReviewTools: boolean,
  planSubmitted: boolean,
  toolName: string,
): { behavior: 'deny'; message: string } | null {
  if (
    isPlanAutoDenyFloorActive({ planAutoReview, autoReviewTools, planSubmitted }) &&
    !REQUIRED_TOOLS.has(toolName)
  ) {
    return { behavior: 'deny', message: 'Not auto-approved during the planning phase' };
  }
  return null;
}

type PlanAutoDenyFloorState = Pick<
  ClaudeTurnContext,
  'planAutoReview' | 'autoReviewTools' | 'planSubmitted'
>;

export function isPlanAutoDenyFloorActive(state: PlanAutoDenyFloorState): boolean {
  return state.planAutoReview && state.autoReviewTools && !state.planSubmitted;
}

/**
 * One-time flip of the sub-chat out of plan mode once the card is emitted, so the input-bar label
 * reflects the real execution state. Called from every card-emit path (inline ExitPlanMode plus the
 * post-stream fallbacks), hence the latch. `notify` is INJECTED rather than imported: this module
 * must stay off the client↔executor import cycle, the same constraint claude-wake-hold documents.
 */
export function createModeFlip(
  subChatId: string,
  autoApproved: boolean,
  notify: () => void,
): () => void {
  let flipped = false;
  return () => {
    if (!autoApproved || flipped) return;
    flipped = true;
    void persistModeThenNotify(subChatId, 'agent', notify).catch((err) => {
      log.warn(`[Socket Executor] failed to persist auto-approve → agent for ${subChatId}:`, err);
      captureContained(err, { surface: 'socket-executor', stage: 'plan-auto-approve-flip' });
    });
  };
}

/**
 * Write-then-notify under the shared per-sub-chat mutex — the single shape every
 * `sub_chats.mode` writer uses (decision `sub-chat-mode-ownership`): writers serialize, the
 * broadcast fires only after ITS write landed, and the mirror never leads the authority a
 * follow-up turn resolves from. `notify` is injected to stay off the client↔executor cycle.
 */
export function persistModeThenNotify(
  subChatId: string,
  mode: 'plan' | 'agent' | 'debug',
  notify: () => void,
): Promise<void> {
  return withSubChatLock(subChatId, async () => {
    await updateSubChatMode(getDatabase(), subChatId, mode);
    notify();
  });
}

/** Mid-turn EnterPlanMode: {@link persistModeThenNotify} with the flip's capture-on-drop. */
export function persistPlanFlipThenNotify(subChatId: string, notify: () => void): void {
  void persistModeThenNotify(subChatId, 'plan', notify).catch((err) => {
    log.warn(`[Socket Executor] EnterPlanMode plan write failed for ${subChatId}:`, err);
    captureContained(err, { surface: 'socket-executor', stage: 'enter-plan-mode-flip' });
  });
}

type ArmableSession = {
  query: { setPermissionMode: (mode: 'auto') => Promise<void> };
  currentTurn?: { autoReviewTools: boolean } | null;
};

type PlanArmableSession = {
  query: { setPermissionMode: (mode: 'default' | 'plan') => Promise<void> };
  currentTurn?: { autoReviewTools: boolean } | null;
};

/**
 * Arm the provider reviewer DURING the planning phase of a Claude plan turn.
 *
 * The turn's query opens in `permissionMode: 'plan'`, so the read-only restriction is in effect from
 * t=0 — the query is NEVER in the permissive 'auto' mode, where the CLI's classifier would auto-execute
 * a mutating tool before we could intervene. The CLI activates its during-plan classifier only on a
 * real transition INTO plan (`prepareContextForPlanMode`) with `skipAutoPermissionPrompt` set, so this
 * exits to 'default' and re-enters 'plan' to arm it: the opt-in is applied FIRST (it is read as the
 * plan transition evaluates), then the plan→default→plan flip, then the abstain flag. The 'default'
 * intermediate still GATES mutating tools (they are not auto-approved), so no real action can slip
 * through the flip. Runs on the first live frame, before the model dispatches any tool.
 *
 * `prePlanMode` ends as 'default', so ExitPlanMode restores 'default' and the implementation half is
 * armed by `armAutoReview` at plan approval. A closed reviewer gate or a settings tier that never takes
 * the opt-in leaves the classifier INACTIVE; there is no synchronous signal that it armed, so the
 * abstain flag is optimistic and the `canUseTool` plan-turn deny-floor is the backstop: an abstained
 * ask-bucket tool that reaches `canUseTool` proves the classifier did not handle it, and is denied
 * rather than blanket-allowed.
 */
export async function armAutoDuringPlan(session: PlanArmableSession): Promise<void> {
  const turn = session.currentTurn;
  if (!turn || turn.autoReviewTools) return;
  // Tracks whether the 'default' leg resolved — i.e. the query has LEFT the read-only 'plan' and, if
  // the re-entry then fails, would be stranded in the execution-permitting 'default'.
  let leftPlan = false;
  try {
    // The CLI reads `skipAutoPermissionPrompt` from the flag settings tier at runtime, but the shipped
    // SDK's `Settings` d.ts type lags and omits it — hence the cast past the strict `applyFlagSettings`
    // param. Applied BEFORE the plan transition, which reads the opt-in as it evaluates.
    await (
      session.query as unknown as {
        applyFlagSettings: (settings: Record<string, boolean>) => Promise<void>;
      }
    ).applyFlagSettings({ skipAutoPermissionPrompt: true });
    // Exit plan to a still-gated 'default', then re-enter — that INTO-plan transition is what arms the
    // during-plan classifier. Never touches 'auto', so mutating tools stay gated throughout.
    await session.query.setPermissionMode('default');
    leftPlan = true;
    await session.query.setPermissionMode('plan');
    turn.autoReviewTools = true;
  } catch (err) {
    // If the re-entry leg failed after we left plan, the query is stranded in the execution-permitting
    // 'default' instead of the read-only 'plan'. Restore 'plan' (best-effort) so the planning phase
    // never runs in a permissive mode; the abstain flag stays off so the hook + deny-floor gate.
    if (leftPlan) {
      await session.query.setPermissionMode('plan').catch((restoreErr) => {
        log.error(
          '[Socket Executor] armAutoDuringPlan: failed to restore plan mode after a flip error:',
          restoreErr,
        );
      });
    }
    log.warn(
      '[Socket Executor] Could not arm Auto during plan — the planning phase asks (or denies unattended):',
      err,
    );
  }
}

/**
 * Switch the SDK to `'auto'` at plan approval so an auto-approved node's implementation half is
 * reviewed. Only THEN let Frink's hook abstain.
 *
 * The ordering is the whole point, not style. `autoReviewTools` makes the PreToolUse hook ABSTAIN,
 * and an abstention falls through to a `canUseTool` that blanket-allows non-MCP tools — so the flag
 * set while the SDK is not in `'auto'` is a silent allow of the entire ask bucket, not a prompt.
 * Setting the mode first, and the flag only once that call RESOLVES, means a closed auto gate
 * (which rejects) degrades to today's prompting rather than to an ungated turn.
 *
 * `force` re-arms even when the abstain flag is already set: a plan-auto turn set it during planning
 * (armAutoDuringPlan), but ExitPlanMode restores the query to the non-'auto' `prePlanMode` and turns
 * the during-plan classifier off, so the implementation half MUST be switched to 'auto' explicitly —
 * otherwise its tools reach `canUseTool` and the deny-floor denies them.
 */
export async function armAutoReview(
  session: ArmableSession,
  eligible: boolean,
  force = false,
): Promise<void> {
  const turn = session.currentTurn;
  if (!eligible || !turn) return;
  if (turn.autoReviewTools && !force) return;
  try {
    await session.query.setPermissionMode('auto');
    turn.autoReviewTools = true;
  } catch (err) {
    log.warn(
      '[Socket Executor] Could not arm Auto at plan approval — the rest of this turn asks:',
      err,
    );
  }
}
