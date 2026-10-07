import type { CanUseTool, UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { isClaudePermissionGatedTool, resolveToolPermissionPath } from '../../../permissions';
import { createSubagentAllowlistHook } from '../../../permissions/subagent-allowlist-hook';
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
import type { validateToolPermission } from '../../executor';
import { buildUserPromptSubmitReminderHook } from '../../operator-reminders';
import { consumeClaudeDelivery } from '../message-provenance/claude';
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
type PreToolUseInput = { hook_event_name: string; tool_name: string; tool_input: unknown };

const NO_ACTIVE_TURN = 'No turn is active on this session; no tools may run.';
const PLAN_SUBMITTED = 'Plan submitted — awaiting user approval; no tools may run.';

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
  const userPromptSubmitReminderHook = async (input: UserPromptSubmitHookInput) => {
    const turn = activeTurn();
    const reminders = turn?.pendingReminders ?? [];
    const provenance =
      session.current && turn?.messageProvenance
        ? consumeClaudeDelivery(session.current, input)
        : undefined;
    const texts = [...reminders, ...(provenance ? [provenance] : [])];
    return texts.length ? buildUserPromptSubmitReminderHook(texts)() : {};
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
  const { chatId, subChatId, projectPath, permissionProjectPath } = scope;
  return async (hookInput: PreToolUseInput, toolUseId: string) => {
    const turn = activeTurn();
    const denyToolUse = (reason: string) => {
      turn?.deniedToolIdsWithMessages.set(toolUseId, reason);
      return {
        hookSpecificOutput: {
          hookEventName: hookInput.hook_event_name,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reason,
        },
      };
    };
    if (!turn) return denyToolUse(NO_ACTIVE_TURN);

    const toolName = hookInput.tool_name;
    const toolInput = (hookInput.tool_input || {}) as Record<string, unknown>;
    if (turn.planSubmissionHalt()) return denyToolUse(PLAN_SUBMITTED);

    // Auto mode can resolve a tool before canUseTool runs, but a PreToolUse deny always wins.
    const burstDeny = denyPlanTransitionInWakeBurst(toolName, turn);
    if (burstDeny) return denyToolUse(burstDeny.message);
    if (toolName === 'ExitPlanMode' && turn.planTerminalsLocked) {
      const submitted = submitPlanForReview(toolInput, turn, subChatId);
      if (submitted) return denyToolUse(submitted);
    }

    const isRegisterNodeTransport = toolName === 'mcp__frink_dynamic_chat__frink_register_node';
    if (
      !isRegisterNodeTransport &&
      !isClaudePermissionGatedTool(toolName) &&
      !toolName.startsWith('mcp__')
    ) {
      return {};
    }
    if (!isRegisterNodeTransport) {
      const permissionPathOverride = resolveToolPermissionPath(
        toolName,
        toolInput,
        projectPath,
        permissionProjectPath,
      );
      const permResult = await scope.validateToolPermission(
        toolName,
        toolInput,
        permissionProjectPath,
        chatId,
        subChatId,
        `Tool: ${toolName}`,
        permissionPathOverride,
        turn.execution.isFlowTurn,
        turn.autoReviewTools,
      );
      if (permResult.allowed === null) return {};
      if (!permResult.allowed) return denyToolUse(permResult.message);
    }

    return {
      hookSpecificOutput: {
        hookEventName: hookInput.hook_event_name,
        permissionDecision: 'allow' as const,
        updatedInput: toolInput,
      },
    };
  };
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
