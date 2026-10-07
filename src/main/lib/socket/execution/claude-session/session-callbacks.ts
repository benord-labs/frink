import type { CanUseTool, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { isClaudePermissionGatedTool, resolveToolPermissionPath } from '../../../permissions';
import { createSubagentAllowlistHook } from '../../../permissions/subagent-allowlist-hook';
import {
  type HookPermission,
  NO_HOOKS,
  type PreToolUseHooks,
  preToolUseOutput,
  runPreToolUseHooks,
} from '../../../provider/hooks/pre-tool-use';
import { createTaskStopHook, type TaskStopHook } from '../../../task-stop-hook';
import { turnOwesTerminalSignal } from '../../../trpc/routers/frink-task-signal';
import {
  hasLatestTaskSignalFor,
  isTaskSignalDisarmedFor,
  markQuietEndIfUnsignaled,
  recordTaskSignalFromToolCall,
  suppressQuietEndForPlanTurn,
} from '../../../trpc/routers/frink-task-signal-persist';
import type { ClaudeSession } from '../../claude-session-registry';
import {
  buildPartsFromChunks,
  type ClaudeTurnContext,
  createTurnChunkEmitter,
} from '../../claude-turn-context';
import type { validateToolPermission } from '../../streaming/pending-permission/validate-tool-permission';
import { buildUserPromptSubmitReminderHook } from '../../operator-reminders';
import {
  denyPlanTransitionInWakeBurst,
  isPlanAutoDenyFloorActive,
  planAutoDenyFloor,
  submitPlanForReview,
} from '../../streaming/plan-auto-approve';
import { holdOrParkQuestion } from '../../streaming/question-hold-park';
import { ignoreBackgroundTasks } from '../../streaming/subagent-task-status';

/** What a session's callbacks read that holds for the session's whole life. The last two are
 * injected because the executor owns the permission prompt and the abort-reason map. */
export interface ClaudeSessionScope {
  chatId: string;
  subChatId: string;
  project: { id: string } | null;
  projectPath: string;
  permissionProjectPath: string;
  agents: Record<string, { tools?: string[]; disallowedTools?: string[] }>;
  validateToolPermission: typeof validateToolPermission;
  abortSources: Map<string, string>;
}

/** The session these callbacks were built for: null until it exists, never a later session. */
interface ClaudeSessionRef {
  readonly current: ClaudeSession | null;
}

type ActiveTurn = () => ClaudeTurnContext | null;
type ToolVerdict = Awaited<ReturnType<typeof validateToolPermission>>;

const NO_ACTIVE_TURN = 'No turn is active on this session; no tools may run.';
const PLAN_SUBMITTED = 'Plan submitted — awaiting user approval; no tools may run.';
/** Frink's question and plan-review flows answer these whatever a hook decides. */
const OWN_FLOW_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** A session's SDK callbacks. Every per-turn read goes through the turn attached to the session
 * they were built for; with no turn attached, tools are denied and Stop allows. */
export function buildClaudeSessionCallbacks(scope: ClaudeSessionScope, session: ClaudeSessionRef) {
  const activeTurn: ActiveTurn = () => session.current?.currentTurn ?? null;
  const stopHook = createClaudeStopHook(activeTurn, scope.subChatId, session);
  const allowlistOnlyHook = createSubagentAllowlistHook({
    agents: scope.agents,
    project: scope.project,
    projectPath: scope.projectPath,
    markDenied: (id, reason) => activeTurn()?.deniedToolIdsWithMessages.set(id, reason),
  });
  const userPromptSubmitReminderHook = async (...hookArgs: unknown[]) => {
    const reminders = activeTurn()?.pendingReminders ?? [];
    if (reminders.length === 0) return {};
    const delegate = buildUserPromptSubmitReminderHook(reminders) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    return delegate(...hookArgs);
  };
  return {
    stopHook,
    canUseTool: createCanUseTool(scope, session),
    hooks: {
      PreToolUse: [
        // No matcher: MCP calls must pass Frink's allow/deny rules before Claude's Auto reviewer.
        { hooks: [createPreToolUseHook(scope, activeTurn) as any] },
        // Every tool, sub-agent calls only: the per-agent allowlist backstop.
        { hooks: [allowlistOnlyHook as any] },
      ],
      // Enforces frink_task_signal on a turn that owes one, and records pending harness work.
      Stop: [{ hooks: [stopHook as any] }],
      // Delivers the active turn's operator reminders as an in-conversation system message.
      UserPromptSubmit: [{ hooks: [userPromptSubmitReminderHook as any] }],
    },
  };
}

/** Frink's permission gate for gated built-in tools and every MCP call. */
function createPreToolUseHook(scope: ClaudeSessionScope, activeTurn: ActiveTurn) {
  return async (
    hookInput: PreToolUseHookInput,
    toolUseId: string,
    options: { signal: AbortSignal },
  ) => {
    const turn = activeTurn();
    let user = NO_HOOKS;
    const denyToolUse = (reason: string) => {
      turn?.deniedToolIdsWithMessages.set(toolUseId, reason);
      return preToolUseOutput(user, {
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      });
    };
    if (!turn) return denyToolUse(NO_ACTIVE_TURN);

    // The user's own hooks run first, so every check below judges the input they leave.
    user = await runPreToolUseHooks(turn.execution.userHooks, hookInput, options);
    if (turn.planSubmissionHalt()) return denyToolUse(PLAN_SUBMITTED);
    if (user.deny !== undefined) return denyToolUse(user.deny);
    const toolName = hookInput.tool_name;
    const toolInput = (hookInput.tool_input || {}) as Record<string, unknown>;
    const finalInput = user.updatedInput ?? toolInput;

    // Auto mode can resolve a tool before canUseTool runs, but a PreToolUse deny always wins.
    const burstDeny = denyPlanTransitionInWakeBurst(toolName, turn);
    if (burstDeny) return denyToolUse(burstDeny.message);
    if (toolName === 'ExitPlanMode' && turn.planTerminalsLocked) {
      const submitted = submitPlanForReview(finalInput, turn, scope.subChatId);
      if (submitted) return denyToolUse(submitted);
    }

    const verdict = await judgeToolCall(scope, turn, toolName, finalInput, hookFor(toolName, user));
    if (verdict.allowed === null) {
      return preToolUseOutput(user, { updatedInput: user.updatedInput });
    }
    if (!verdict.allowed) return denyToolUse(verdict.message);
    return preToolUseOutput(user, { permissionDecision: 'allow', updatedInput: finalInput });
  };
}

function hookFor(toolName: string, hooks: PreToolUseHooks): HookPermission | undefined {
  return OWN_FLOW_TOOLS.has(toolName) ? undefined : hooks.permission;
}

/** Frink's answer for one call; `null` leaves it to Claude, as for a tool Frink has no rules for
 * and no hook decided on. */
async function judgeToolCall(
  scope: ClaudeSessionScope,
  turn: ClaudeTurnContext,
  toolName: string,
  toolInput: Parameters<typeof validateToolPermission>[1],
  hook: HookPermission | undefined,
): Promise<ToolVerdict> {
  const registersNode = toolName === 'mcp__frink_dynamic_chat__frink_register_node';
  if (registersNode && hook?.decision !== 'ask') return { allowed: true };
  if (!hook && !isClaudePermissionGatedTool(toolName) && !toolName.startsWith('mcp__')) {
    return { allowed: null };
  }
  const { permissionProjectPath } = scope;
  const permissionPathOverride = resolveToolPermissionPath(
    toolName,
    toolInput,
    scope.projectPath,
    permissionProjectPath,
  );
  return scope.validateToolPermission(
    toolName,
    toolInput,
    permissionProjectPath,
    scope.chatId,
    scope.subChatId,
    `Tool: ${toolName}`,
    permissionPathOverride,
    turn.execution.isFlowTurn,
    turn.autoReviewTools,
    undefined,
    undefined,
    undefined,
    undefined,
    hook,
  );
}

/** Stop hook judged on the active turn: a turn owing frink_task_signal continues (≤2 retries), a
 * turn with no task never blocks, and `lastPendingWork` feeds the wake pump. */
function createClaudeStopHook(
  activeTurn: ActiveTurn,
  subChatId: string,
  session: ClaudeSessionRef,
): TaskStopHook {
  // With no turn attached there is nothing to continue, so Stop allows.
  const isAborted = (): boolean => activeTurn()?.isAborted() ?? true;
  const hook = createTaskStopHook({
    hasSignal: async () => {
      const turn = activeTurn();
      if (!turn) return true;
      const { execution } = turn;
      return (
        !execution.taskSignalReady ||
        !execution.signalTaskId ||
        !turnOwesTerminalSignal(execution.isPlanMode, execution.flowPlanAutoApprove, turn) ||
        (await hasLatestTaskSignalFor(execution.executionContextId, turn.planSubmitted)) ||
        // The handler refused a dead target and disarmed the tool — nothing left to chase.
        (await isTaskSignalDisarmedFor(execution.executionContextId))
      );
    },
    isAborted,
    onDroppedFollowers: (taskIds) => {
      // A draining or ended session shares its successor's key, so only a live one may write.
      const loop = session.current?.loop;
      if (loop && !loop.closeExpected && !loop.stopped) ignoreBackgroundTasks(subChatId, taskIds);
    },
    onAllow: async () => {
      const turn = activeTurn();
      if (!turn?.execution.taskSignalReady || !turn.execution.signalTaskId) return;
      const { execution } = turn;
      // The plan machinery owns a plan turn's end; a quiet-end marker here would block plan_ready.
      const mode = execution.isPlanMode ? 'plan' : 'agent';
      if (suppressQuietEndForPlanTurn(turn, mode, hook.lastPendingWork)) return;
      await markQuietEndIfUnsignaled(
        execution.executionContextId,
        isAborted,
        execution.signalTaskId,
      );
    },
  });
  return hook;
}

/** Plan-mode denial, task-signal persistence, AskUserQuestion, and the MCP rule re-check.
 * Sub-agent allowlisting lives in the PreToolUse backstop: only a hook sees the calling agent. */
function createCanUseTool(scope: ClaudeSessionScope, session: ClaudeSessionRef): CanUseTool {
  const { chatId, subChatId, permissionProjectPath } = scope;
  return async (toolName, toolInput, options) => {
    const asking = session.current;
    if (!asking?.currentTurn) return { behavior: 'deny', message: NO_ACTIVE_TURN };
    const turn = asking.currentTurn;
    if (turn.planSubmissionHalt()) return { behavior: 'deny', message: PLAN_SUBMITTED };

    const { execution } = turn;
    if (execution.taskSignalReady && execution.signalTaskId && toolName.startsWith('mcp__')) {
      const signalDeny = await recordTaskSignalFromToolCall({
        toolName,
        toolInput,
        signalTaskId: execution.signalTaskId,
        planTerminalsLocked: turn.planTerminalsLocked,
        subChatId,
      });
      if (signalDeny) return signalDeny;
    }

    if (toolName === 'AskUserQuestion') {
      const emitChunk = createTurnChunkEmitter({
        turn,
        liveParts: buildPartsFromChunks(turn.lastCollectedChunks),
        chatId,
        subChatId,
        sendChunk: execution.sendChunk,
      });
      return holdOrParkQuestion({
        toolUseID: options.toolUseID,
        toolInput,
        chatId,
        subChatId,
        signalTaskId: execution.signalTaskId,
        isFlowTurn: execution.isFlowTurn,
        emitChunk,
        abortController: execution.abortController,
        abortSources: scope.abortSources,
        waitForSettlement: turn.waitForExecutionSettlement,
        questionSession: asking,
      });
    }

    // Registration is transport-only. Other MCP calls re-check v2 rules, never prompting: the
    // PreToolUse hook owns the card, as only a hook's deny reason reaches the model (sc-1357).
    if (toolName.startsWith('mcp__')) {
      if (toolName === 'mcp__frink_dynamic_chat__frink_register_node') {
        return { behavior: 'allow', updatedInput: toolInput };
      }
      const permResult = await scope.validateToolPermission(
        toolName,
        toolInput,
        permissionProjectPath,
        chatId,
        subChatId,
        undefined,
        undefined,
        execution.isFlowTurn,
        true,
      );
      if (permResult.allowed === null) {
        if (isPlanAutoDenyFloorActive(turn)) {
          return { behavior: 'deny', message: 'Provider review was not available' };
        }
        return { behavior: 'allow', updatedInput: toolInput };
      }
      if (!permResult.allowed) return { behavior: 'deny', message: permResult.message };
      // Fully resolved here: the plan-auto deny floor below is for the non-MCP ask bucket only.
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Planning phase only: an abstained ask-bucket tool reaching here means the during-plan
    // reviewer is inactive, so it is denied rather than silently allowed.
    const planDeny = planAutoDenyFloor(
      turn.planAutoReview,
      turn.autoReviewTools,
      turn.planSubmitted,
      toolName,
    );
    if (planDeny) return planDeny;
    // Everything else is allowed: the PreToolUse hook already ran the permission checks.
    return { behavior: 'allow', updatedInput: toolInput };
  };
}
