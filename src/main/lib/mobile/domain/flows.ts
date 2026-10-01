import type {
  MobileFlow,
  MobileRequest,
  MobileResponses,
  MobileRun,
  MobileRunNode,
} from '../../../../shared/types/remote/mobile';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbFlowRunWithNodeRuns, DbNodeRun } from '../../../../shared/types/flow-run';
import type { DbFlow } from '../../cloud/flows';
import {
  findUnapprovedPlanPart,
  hasCurrentUnapprovedPlan,
  type PlanMessageLike,
} from '../../../../shared/types/plan';
import { flowRunDisplayStatus } from '../../../../shared/lib/flows/run-display-status';
import { getDatabase } from '../../db';
import { getVersion } from '../../db/repos/flow-versions';
import { getSubChatById, safeParseMessages, type SubChatHydrated } from '../../db/repos/sub-chats';
import { parseResultRecord } from '../../db/repos/tasks';
import {
  activeFlowRunForSubChatId,
  latestFlowTaskForSubChatId,
} from '../../db/repos/task-queries/subchat-driver';
import { flowRuns, flowVersions, subChats, tasks } from '../../db/schema';
import { flowResumeActionToken, resumeSnapshotForNode } from '../../flows/rerun/resume-snapshot';
import { MobileApiError, mobileCallers, record, requireExecutionReady, text } from './context';
import { projectMobileFlowDefinition } from './projections';

const MAX_FLOWS = 200;
/** The desktop run list's own cap, which is also the phone's largest window. */
const MAX_RUNS = 100;

/** The live run's state as the desktop list shows it. A paused run that is not working is parked
 *  on a person (an approval, a plan, or a failed step to retry or skip), so it reads as a wait. */
function liveStatus(flow: DbFlow): string | null {
  if (!flow.latest_run_status) return null;
  const status = flowRunDisplayStatus(
    flow.latest_run_status,
    flow.latest_run_active_task_status,
    flow.latest_run_admission_state,
  );
  return status === 'paused' ? 'awaiting_input' : status;
}

function flowProjection(flow: DbFlow, lastRun: MobileFlow['lastRun']): MobileFlow {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description ?? '',
    enabled: flow.is_enabled,
    trigger: flow.trigger_type ?? 'manual_trigger',
    latestRunId: flow.latest_run_id ?? null,
    status: liveStatus(flow),
    lastRun,
  };
}

/** The newest run of any status per Flow; the list's live status covers only active runs. */
async function lastRuns(flowIds: string[]): Promise<Map<string, MobileFlow['lastRun']>> {
  if (!flowIds.length) return new Map();
  const db = getDatabase();
  const ranked = db
    .select({
      flowId: flowVersions.flowId,
      id: flowRuns.id,
      status: flowRuns.status,
      at: sql<Date>`coalesce(${flowRuns.completedAt}, ${flowRuns.startedAt}, ${flowRuns.createdAt})`
        .mapWith(flowRuns.createdAt)
        .as('at'),
      rank: sql<number>`row_number() over (partition by ${flowVersions.flowId} order by ${flowRuns.createdAt} desc, ${flowRuns.id} desc)`.as(
        'rank',
      ),
    })
    .from(flowRuns)
    .innerJoin(flowVersions, eq(flowVersions.id, flowRuns.flowVersionId))
    .where(inArray(flowVersions.flowId, flowIds))
    .as('ranked');
  const rows = await db.select().from(ranked).where(eq(ranked.rank, 1));
  return new Map(
    rows.map((row) => [row.flowId, { id: row.id, status: row.status, at: row.at.toISOString() }]),
  );
}

export async function readMobileFlows(): Promise<MobileFlow[]> {
  const flows = (await mobileCallers.flows.list()).slice(0, MAX_FLOWS);
  const runs = await lastRuns(flows.map((flow) => flow.id));
  return flows.map((flow) => flowProjection(flow, runs.get(flow.id) ?? null));
}

export async function readMobileFlow({
  id,
  runLimit = 20,
}: Omit<Extract<MobileRequest, { type: 'flow' }>, 'type'>): Promise<MobileResponses['flow']> {
  const [flow, runs, last] = await Promise.all([
    mobileCallers.flows.get({ id }),
    // One extra row tells whether more exist. At the 100-run cap the phone cannot widen further.
    mobileCallers.flows.listRuns({ flowId: id, limit: Math.min(runLimit + 1, MAX_RUNS) }),
    lastRuns([id]),
  ]);
  return {
    flow: flowProjection(flow, last.get(id) ?? null),
    definition: projectMobileFlowDefinition(flow.graph, flow.version_number),
    runs: {
      items: runs.slice(0, runLimit).map((run) => ({
        id: run.id,
        status: run.status,
        createdAt: run.created_at,
        startedAt: run.started_at,
        completedAt: run.completed_at,
      })),
      hasMore: runs.length > runLimit,
    },
  };
}

async function currentPlanText(subChatId: string) {
  const subChat = await getSubChatById(getDatabase(), subChatId);
  return { text: planTextForSubChat(subChat), messages: subChat?.messages ?? [] };
}

// Reason: Small parser validates stored assistant text before showing a plan.
// fallow-ignore-next-line complexity
function planTextForSubChat(subChat: Pick<SubChatHydrated, 'mode' | 'messages'> | null): string {
  const messages = (subChat?.messages ?? []) as PlanMessageLike[];
  if (!hasCurrentUnapprovedPlan(messages, subChat?.mode === 'plan')) return '';
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const plan = findUnapprovedPlanPart([...(message.parts ?? [])].reverse());
    if (plan) return plan.planContext?.planText ?? '';
  }
  return '';
}

type DriverTask = {
  id: string;
  result?: unknown;
  flowRunId: string | null;
  nodeRunId: string | null;
  status: string;
};

// Reason: Keep the distinct Flow-state eligibility rules in one policy.
// fallow-ignore-next-line complexity
function nodeActions(
  run: DbFlowRunWithNodeRuns,
  node: DbNodeRun,
  planText: string,
  task: DriverTask | null,
): MobileRunNode['actions'] {
  if (run.status !== 'paused') return [];
  if (node.block_type === 'approval') return node.status === 'awaiting_input' ? ['approve'] : [];
  if (node.status === 'failed' || node.status === 'blocked') return ['skip'];
  if (
    node.status !== 'awaiting_input' ||
    node.block_type !== 'agent' ||
    node.node_output?.signal ||
    !planText
  )
    return [];
  return task?.flowRunId === run.id && task.nodeRunId === node.id && task.status === 'plan_ready'
    ? ['approve', 'skip']
    : [];
}

async function nodeChatLinks(nodes: DbNodeRun[]) {
  if (!nodes.length) return new Map<string, { chatId: string; subChatId: string | null }>();
  const rows = await getDatabase()
    .select({ nodeRunId: tasks.nodeRunId, result: tasks.result })
    .from(tasks)
    .where(
      and(
        eq(tasks.source, 'flow'),
        inArray(
          tasks.nodeRunId,
          nodes.map((node) => node.id),
        ),
      ),
    );
  const links = new Map<string, { chatId: string; subChatId: string | null }>();
  for (const row of rows) {
    const result = parseResultRecord(row.result);
    const chatId = typeof result.chatId === 'string' ? result.chatId : null;
    if (row.nodeRunId && chatId)
      links.set(row.nodeRunId, {
        chatId,
        subChatId: typeof result.subChatId === 'string' ? result.subChatId : null,
      });
  }
  return links;
}

async function nodePlans(subChatIds: string[]) {
  const plans = new Map<string, { text: string; messages: unknown[]; task: DriverTask | null }>();
  if (!subChatIds.length) return plans;
  const db = getDatabase();
  const rows = await db
    .select({
      id: subChats.id,
      mode: subChats.mode,
      messages: subChats.messages,
      task: {
        id: tasks.id,
        result: tasks.result,
        flowRunId: tasks.flowRunId,
        nodeRunId: tasks.nodeRunId,
        status: tasks.status,
      },
      runId: sql<string | null>`(${activeFlowRunForSubChatId(db, sql`${subChats.id}`)})`,
    })
    .from(subChats)
    .leftJoin(tasks, eq(tasks.id, latestFlowTaskForSubChatId(db, sql`${subChats.id}`)))
    .where(inArray(subChats.id, subChatIds));
  for (const row of rows) {
    const messages = safeParseMessages(row.id, row.messages);
    plans.set(row.id, {
      messages,
      text: planTextForSubChat({
        ...row,
        messages,
      }),
      task: row.runId && row.task?.flowRunId === row.runId ? row.task : null,
    });
  }
  return plans;
}

export async function readMobileRun(id: string): Promise<MobileRun> {
  const run = await mobileCallers.flows.getRun({ runId: id });
  const version = await getVersion(getDatabase(), run.flow_version_id);
  if (!version) throw new MobileApiError(404, 'Flow version not found.');
  const flow = await mobileCallers.flows.get({ id: version.flowId });
  const links = await nodeChatLinks(run.nodeRuns);
  const plans = await nodePlans([
    ...new Set(
      run.nodeRuns.flatMap((node) => {
        const subChatId = links.get(node.id)?.subChatId;
        return subChatId && ['awaiting_input', 'blocked', 'failed'].includes(node.status)
          ? [subChatId]
          : [];
      }),
    ),
  ]);
  // Reason: Keep plan visibility and action snapshots derived from the same node projection.
  // fallow-ignore-next-line complexity
  const nodes = run.nodeRuns.map((node): MobileRunNode => {
    const link = links.get(node.id);
    const plan = link?.subChatId ? plans.get(link.subChatId) : null;
    const planText =
      node.block_type === 'agent' && node.status === 'awaiting_input' ? (plan?.text ?? '') : '';
    const snapshot = resumeSnapshotForNode(
      node,
      run.nodeRuns,
      plan?.task
        ? { id: plan.task.id, status: plan.task.status, result: plan.task.result ?? null }
        : undefined,
      link?.subChatId && plan ? { subChatId: link.subChatId, messages: plan.messages } : undefined,
    );
    return {
      id: node.id,
      label: run.graph?.nodes.find((entry) => entry.id === node.node_id)?.label ?? node.block_type,
      chatId: link?.chatId ?? null,
      subChatId: link?.subChatId ?? null,
      status: node.status,
      detail:
        planText ||
        text(
          record(node.node_output?.outputs).summary,
          text(
            node.node_output?.error?.message,
            text(run.graph?.nodes.find((entry) => entry.id === node.node_id)?.config?.message),
          ),
        ),
      actions:
        snapshot.attemptIds.at(-1) === node.id
          ? nodeActions(run, node, planText, plan?.task ?? null)
          : [],
      actionToken: flowResumeActionToken(snapshot),
      startedAt: node.started_at,
      completedAt: node.completed_at,
    };
  });
  return {
    id: run.id,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    flowId: flow.id,
    flowName: flow.name,
    nodes,
  };
}

export async function resumeMobileNode(input: Extract<MobileRequest, { type: 'resumeNode' }>) {
  requireExecutionReady();
  const run = await mobileCallers.flows.getRun({ runId: input.runId });
  const node = run.nodeRuns.find((entry) => entry.id === input.nodeRunId);
  const link = node && (await mobileCallers.tasks.getFlowChatForNodeRun({ nodeRunId: node.id }));
  const plan = link?.subChatId ? await currentPlanText(link.subChatId) : null;
  const task = link?.subChatId
    ? (
        await mobileCallers.tasks.getDrivingTaskForSubChat({
          subChatId: link.subChatId,
          fallbackTaskId: null,
        })
      ).task
    : null;
  if (!node || !nodeActions(run, node, plan?.text ?? '', task).includes(input.action)) {
    throw new MobileApiError(409, 'This step changed. Refresh the Flow before continuing.');
  }
  const expectedSnapshot = resumeSnapshotForNode(
    node,
    run.nodeRuns,
    task ? { id: task.id, status: task.status, result: task.result ?? null } : undefined,
    link?.subChatId && plan ? { subChatId: link.subChatId, messages: plan.messages } : undefined,
  );
  if (
    expectedSnapshot.attemptIds.at(-1) !== node.id ||
    flowResumeActionToken(expectedSnapshot) !== input.actionToken
  ) {
    throw new MobileApiError(409, 'This step changed. Refresh the Flow before continuing.');
  }
  await mobileCallers.flows.resumeRun({
    runId: input.runId,
    nodeRunId: node.id,
    action: input.action,
    expectedSnapshot,
  });
  return { ok: true as const };
}
