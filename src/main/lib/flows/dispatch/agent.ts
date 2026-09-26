/**
 * agent block dispatcher (LOCAL).
 *
 * Creates a `tasks` row linked to flow_run_id + node_run_id and returns
 * `awaiting_input` so the engine pauses. The task poller picks it up,
 * `handleClaimedTask` opens a sub-chat in the renderer (UI parity:
 * thinking stream + tool use visible), and the Claude SDK session runs
 * via the socket executor (`handleRemoteExecute`).
 *
 * `task-completion-watcher.ts` polls for terminal flow-linked tasks and
 * calls `signal-bridge.mapTaskToNodeOutput` + `advanceFlowRun` to resume
 * the flow.
 *
 * Identity (projectId / chatId / subChatId / worktree / startMode) is resolved
 * from the flow's upstream `start_task` node_run (findLatestCompletedStartTaskRun),
 * not the immediate predecessor — so condition/agent nodes in between are
 * transparent and multi-agent chains work. Every agent makes its own task row but
 * runs continue_chat in the start_task's chat (continuity via shared chatId). The chat is
 * linked (chats.taskId) to the FIRST agent's task only — guarded null, so the sidebar task
 * icon/badge track that task. Diverges from cloud, which creates one task per flow at start_task.
 *
 * Scope (v1):
 * - Needs a completed `start_task` ancestor in the run for projectId / chatId.
 * - `fireAndForget` not yet supported (always creates linked task).
 * - Multi-start_task converging merges (CEO-DAG) resolve the latest completed
 *   start_task — per-branch disambiguation is out of scope.
 */

import { eq } from 'drizzle-orm';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { getDatabase } from '../../db';
import { linkChatToTask } from '../../db/repos/chats';
import { getVersion } from '../../db/repos/flow-versions';
import { getFlowById } from '../../db/repos/flows';
import {
  listNodeRunsForFlowRun,
  resolveUpstreamStartTaskContext,
  type StartTaskContext,
} from '../../db/repos/node-runs';
import { createTask } from '../../db/repos/tasks';
import { flowRuns } from '../../db/schema';
import { getTaskPoller } from '../../task-poller';
import { buildVariables } from '../block-context';
import { findUpstreamNodeIds } from '../graph';
import {
  MODE_TO_START_MODE,
  resolveSessionResumeSeed,
  type SessionResumeSeed,
} from '../rerun/session-resume';
import { renderTemplate } from '../template-utils';
import type { Dispatcher } from './types';

const MAX_FLOW_CHAIN_DEPTH = 5;

/**
 * The chat trigger card is only surfaced when the agent's text actually references
 * `{{trigger.*}}`.
 */
const FLOW_TEMPLATE_USES_TRIGGER = /\{\{\s*trigger\./;

/**
 * Deliberate re-run into a surviving session: the session already holds these
 * instructions plus the partial work, so an unframed re-send reads as a contradiction
 * to the agent. One directive line marks it as a redo.
 */
const RERUN_INTO_SESSION_FRAMING =
  "This step is being re-run from its instructions. Disregard this session's previous attempt at it and start the step over.\n\n---\n\n";

type AgentConfig = {
  instructions?: string;
  agentInstructions?: string;
  fireAndForget?: boolean;
  model?: string;
  /**
   * Per-node agent mode. Overrides the inherited start_task startMode for THIS node's turn ONLY
   * (never mutates the shared upstream context, so sibling agents keep their inherited mode).
   * Omitted → inherit the start_task mode. (Local dispatch is always local-execution, so `debug`
   * is fine here; the cloud dispatcher hard-errors `debug` — no off-machine ingest server.)
   */
  mode?: ChatMode;
  /** Plan mode only: auto-approve the plan (skipReview) so the flow advances without a human gate. */
  autoApprove?: boolean;
};

function readBriefing(graphSettings: unknown): string | undefined {
  if (graphSettings === null || typeof graphSettings !== 'object') return undefined;
  const briefing = (graphSettings as { briefing?: unknown }).briefing;
  return typeof briefing === 'string' && briefing.trim().length > 0 ? briefing.trim() : undefined;
}

/** Trim-guarded string read: empty/whitespace/non-string → undefined (matches cloud `readString`). */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function loadFlowMeta(
  flowRunId: string,
): Promise<{ flowId: string; flowName: string; briefing?: string } | null> {
  const db = getDatabase();
  const [run] = await db.select().from(flowRuns).where(eq(flowRuns.id, flowRunId)).limit(1);
  if (!run) return null;
  const version = await getVersion(db, run.flowVersionId);
  if (!version) return null;
  const flow = await getFlowById(db, version.flowId);
  if (!flow) return null;
  const briefing = readBriefing((version.graph as { settings?: unknown } | null)?.settings);
  return { flowId: flow.id, flowName: flow.name, briefing };
}

/**
 * Continuation seed + restart framing for a terminal-resume dispatch. Both absent for
 * engine advances (loop/fan-out iterations carry no resumeKind). BOTH key on the same
 * two-half session gate — the surviving session must hold THIS node's turn of THIS run:
 * 'continuation' continues it; 'redispatch' re-instructs it, framed as a deliberate redo
 * so the agent doesn't reconcile a contradiction. A session last driven by a different
 * node or run gets neither (framing there would falsely disown unrelated work).
 */
async function resolveResumePresentation(
  db: ReturnType<typeof getDatabase>,
  ctx: Parameters<Dispatcher>[0],
  chatId: string,
  // Wider than TriggerStartMode: the inherited value is the start_task node_run's
  // persisted output, an untyped string.
  configuredStartMode: string | undefined,
): Promise<{ resume: SessionResumeSeed | null; framingPrefix: string }> {
  const seed = ctx.resumeKind
    ? await resolveSessionResumeSeed(db, {
        chatId,
        flowRunId: ctx.flowRunId,
        nodeId: ctx.node.id,
        configuredStartMode,
      })
    : null;
  return {
    resume: ctx.resumeKind === 'continuation' ? seed : null,
    framingPrefix:
      ctx.resumeKind === 'redispatch' && seed !== null ? RERUN_INTO_SESSION_FRAMING : '',
  };
}

/**
 * Effective model mirrors cloud's net precedence (engine.ts + node-dispatch.ts): agent
 * override → upstream start_task model → flow settings.defaultModel. All are PICKER ids;
 * the task-executor `shouldForwardTaskModel` gate + the renderer transport convert
 * picker→CLI downstream. The agent's "[inherited]" UI placeholder only shows the flow
 * default, but runtime correctly prefers an upstream start_task model (cosmetic-only).
 */
function resolveEffectiveModel(
  config: AgentConfig,
  startTaskModel: string | null | undefined,
  parsedGraph: Parameters<Dispatcher>[0]['parsedGraph'],
): string | undefined {
  return (
    nonEmptyString(config.model) ??
    nonEmptyString(startTaskModel) ??
    nonEmptyString(parsedGraph.settings?.defaultModel)
  );
}

/**
 * Flow-level execution consent, attached only to provider-backed agent tasks (shell and
 * custom-node dispatchers never receive it). Both flags are emitted on EVERY dispatch, never
 * only-when-true: each seeds a persisted per-chat atom, so an omitted flag would leave whatever a
 * previous run put there — silently applying one flow's policy to another flow's run.
 *
 * The defaults are deliberately opposite. Auto is ON when unset, so graphs saved before it existed
 * keep working; Fast is OFF when unset, because it bills a 2-2.5x credit multiplier and must never
 * arrive by inheritance.
 */
function flowExecutionFlags(settings: Parameters<Dispatcher>[0]['parsedGraph']['settings']): {
  autoReviewTools: boolean;
  codexFastMode: boolean;
} {
  return {
    autoReviewTools: settings?.autoReviewTools !== false,
    codexFastMode: settings?.codexFastMode === true,
  };
}

/**
 * Reuse the start_task's worktree for every agent node (task-executor/index.ts
 * resolveWorktreePathForTask), or explicitly opt out — without the latter it defaults to true.
 */
type AgentWorktreeConfig =
  | {
      executionOverride: {
        worktreePath: string;
        branch?: string;
        baseBranch?: string;
        reuseWorktree: true;
      };
    }
  | { startInWorktree: false };

function resolveAgentWorktreeConfig(stc: StartTaskContext): AgentWorktreeConfig {
  return stc.worktreePath
    ? {
        executionOverride: {
          worktreePath: stc.worktreePath,
          ...(stc.branch ? { branch: stc.branch } : {}),
          ...(stc.baseBranch ? { baseBranch: stc.baseBranch } : {}),
          reuseWorktree: true,
        },
      }
    : { startInWorktree: false };
}

export const dispatchAgent: Dispatcher = async (ctx) => {
  const config = (ctx.node.config ?? {}) as AgentConfig;
  const rawInstructions = config.instructions?.trim();
  if (!rawInstructions) {
    return { type: 'error', message: 'agent missing instructions' };
  }

  const meta = await loadFlowMeta(ctx.flowRunId);
  if (!meta) return { type: 'error', message: 'agent: flow run / version missing' };

  // Identity (projectId/chat/worktree/startMode) comes from the flow's upstream
  // start_task node_run, NOT the immediate predecessor; it's invariant down the chain (every agent runs
  // continue_chat in the start_task's chat + worktree). ctx.previousOutput is kept only
  // for templating below ({{previous.summary}}) — it never carries chat ids.
  const db = getDatabase();
  const stc = await resolveUpstreamStartTaskContext(db, ctx.flowRunId, {
    nodeRunId: ctx.nodeRunId,
    upstreamNodeIds: findUpstreamNodeIds(ctx.parsedGraph, ctx.node.id),
  });
  if (!stc?.projectId) {
    return {
      type: 'error',
      message:
        'agent: no completed upstream start_task in this flow — an agent block needs a start_task ancestor that has run',
    };
  }
  const projectId = stc.projectId;

  if (!stc.chatId || !stc.subChatId) {
    return {
      type: 'error',
      message: 'agent: upstream start_task did not yield chatId/subChatId in its outputs',
    };
  }
  const chatId = stc.chatId;
  const subChatId = stc.subChatId;

  // The briefing rides the SESSION system-prompt channel (the executor injects `_config.flowBriefing`
  // once per session, prompt-cached) — NOT the per-turn message. It is rendered here
  // against a CONSTANT per-run context (`trigger` + `flow` only, no `previous.*`/`loop.*`) so the
  // shared context is byte-identical across every node/turn and never busts the system-prompt cache.
  const renderedBriefing = meta.briefing
    ? renderTemplate(
        meta.briefing,
        buildVariables({
          triggerContext: ctx.triggerContext,
          previousOutput: undefined,
          flowBriefing: meta.briefing,
        }),
      ).trim()
    : '';
  // Role + instructions render with `{{flow.briefing}}` → '' (the inline opt-in is retired now that
  // every agent gets the briefing via the system prompt; keeping it would double-count).
  const instructionVars = buildVariables({
    triggerContext: ctx.triggerContext,
    previousOutput: ctx.previousOutput,
    loopContext: ctx.loopContext,
    flowBriefing: '',
  });
  const rolePrefix = config.agentInstructions?.trim()
    ? `## Role\n\n${renderTemplate(config.agentInstructions, instructionVars)}\n\n---\n\n`
    : '';
  const renderedInstructions = renderTemplate(rawInstructions, instructionVars);
  const description = `${rolePrefix}${renderedInstructions}`;

  // triggerContext shape mirrors cloud agent dispatch — _config drives the
  // task-executor's chat creation path; _flowOriginId/_flowChainDepth bound
  // chained agents so we don't recurse indefinitely. Cloud uses
  // MAX_FLOW_CHAIN_DEPTH=5 in trigger-bridge.ts.
  const incomingDepth =
    typeof ctx.triggerContext?._flowChainDepth === 'number'
      ? ctx.triggerContext._flowChainDepth
      : 0;
  if (incomingDepth >= MAX_FLOW_CHAIN_DEPTH) {
    return {
      type: 'error',
      message: `agent: flow chain depth ${incomingDepth} exceeds MAX_FLOW_CHAIN_DEPTH (${MAX_FLOW_CHAIN_DEPTH}) — refusing to spawn another agent task`,
    };
  }
  // Per-node mode overrides the inherited start_task mode for THIS task only (no sibling leak).
  // autoApprove stays keyed on the CONFIGURED mode even under a continuation seed — the graph's
  // review semantics (skipReview → `done` not `plan_ready`) are invariant under resume.
  const configuredStartMode = config.mode ? MODE_TO_START_MODE[config.mode] : stc.startMode;
  const autoApproveSkipReview =
    configuredStartMode === 'plan' && config.autoApprove === true ? true : undefined;
  const flowFlags = flowExecutionFlags(ctx.parsedGraph.settings);
  const effectiveModel = resolveEffectiveModel(config, stc.model, ctx.parsedGraph);
  // Bubble parity with cloud node-dispatch: only surface the trigger card when the agent text
  // actually uses {{trigger.*}} (otherwise the rendered instructions already contain the data).
  // The briefing is excluded — it no longer rides the user message, so its {{trigger.*}} must not
  // flip the card on (the card mirrors the message, not the system prompt).
  const referencesTrigger =
    FLOW_TEMPLATE_USES_TRIGGER.test(rawInstructions) ||
    FLOW_TEMPLATE_USES_TRIGGER.test(config.agentInstructions ?? '');
  // A prior node_run for this node marks a deliberate re-dispatch (resume/retry paths mint a fresh
  // node_run; a heartbeat re-claim reuses the existing one). The flag rides _config so
  // createChatForTask sets the renderer's alreadySent-dedup bypass — without it the re-dispatched
  // prompt, already persisted as a user message in the reused continue_chat sub-chat, is silently
  // swallowed and the run never streams. Fan-out/loop iterations ≥2 of the same node also match:
  // safe (their prompts either differ, so the bypass is a no-op, or are identical, where the
  // bypass is equally required for the iteration to stream) — but it IS a proxy for intent, so
  // revisit if fan-out bodies ever get per-iteration sub-chats.
  const priorNodeRuns = await listNodeRunsForFlowRun(db, ctx.flowRunId);
  const isNodeRedispatch = priorNodeRuns.some(
    (nodeRun) => nodeRun.nodeId === ctx.node.id && nodeRun.id !== ctx.nodeRunId,
  );
  const { resume, framingPrefix } = await resolveResumePresentation(
    db,
    ctx,
    chatId,
    configuredStartMode,
  );
  const triggerContext: Record<string, unknown> = {
    // Carry the flow run's webhook envelope (source/eventType/fullContent/triggeredBy/timestamp/
    // sourceAccountId) onto the task so its trigger_context is a valid TriggerContext — this is what
    // the Work Queue "View original content" dialog reads. Cloud node-dispatch spreads
    // flowTriggerContext the same way; the overrides below replace the per-agent fields.
    ...(ctx.triggerContext ?? {}),
    _config: {
      blockType: 'agent',
      // Run the task IN the chat start_task provisioned. The task-executor adopts
      // an existing chat only via continue_chat (+continueChatId) or task.result;
      // without this it creates a fresh chat and orphans the start_task one.
      // Mirrors cloud createBatchMessageTask.
      executionMode: 'continue_chat',
      continueChatId: chatId,
      showTriggerCard: referencesTrigger,
      ...(isNodeRedispatch ? { isNodeRedispatch: true } : {}),
      // Session-level shared context: the executor injects this into the system-prompt channel once
      // per session (prompt-cached), so it is not re-shipped in every agent turn's transcript.
      ...(renderedBriefing ? { flowBriefing: renderedBriefing } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...flowFlags,
      // CONFIGURED plan/execute/debug mode — the task-executor reads _config.startMode to gate the
      // chat mode. Without this a plan-gated flow silently runs the agent in execute mode. Always
      // the static config: a continuation's clamped live mode rides resumeStartMode below and is
      // applied only when the claim lands on the pinned sub-chat.
      ...(configuredStartMode ? { startMode: configuredStartMode } : {}),
      ...(autoApproveSkipReview ? { skipReview: true } : {}),
      // Continuation-first Retry: flips the executor's prompt to the hidden continuation
      // nudge (resolveClaimResume) — the instructions in `description` are NOT re-sent.
      ...(resume?.config ?? {}),
      ...resolveAgentWorktreeConfig(stc),
    },
    _flowOriginId: ctx.flowRunId,
    _flowChainDepth: incomingDepth + 1,
    chatId,
    subChatId,
  };

  const task = await createTask(db, {
    projectId,
    // Title from the upstream start_task's resolved Task title (stc.label) so the Work Queue
    // row matches the chat name. Falls back to 'Flow: Agent' only for runs whose start_task
    // completed before stc.label existed.
    title: stc.label || 'Flow: Agent',
    description: `${framingPrefix}${description}`,
    source: 'flow',
    sourceId: ctx.nodeRunId, // idempotency: one task per node_run via partial unique
    requiresFilesystem: true,
    flowRunId: ctx.flowRunId,
    nodeRunId: ctx.nodeRunId,
    triggerContext,
  });

  // Link the chat to this task so the sidebar marks it as a task (the icon + status badge key off
  // chats.taskId / the linkedChatId join). One task per agent, so the guarded null means the
  // first agent in a chain wins and the chat tracks that task.
  await linkChatToTask(db, chatId, task.id);

  // Claim the just-created task immediately instead of waiting up to POLL_INTERVAL_MS
  // (5s) for the next poller tick — kills the visible gap between this node firing and
  // the agent chat coming alive. Safe: pokeNow() respects the poller's own guards.
  getTaskPoller().pokeNow();

  // Engine pauses here. task-completion-watcher will advance once the task
  // reaches a terminal status (signal-bridge.mapTaskToNodeOutput). `handoff` marks this as a wait
  // on the machine, not on the user — without it every node advance announces itself.
  return {
    type: 'awaiting_input',
    reason: 'agent task dispatched — awaiting completion',
    handoff: true,
  };
};
