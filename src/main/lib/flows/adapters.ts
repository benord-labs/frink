/**
 * Drizzle row → cloud-shaped DTO adapters.
 *
 * Renderer code was written against the cloud HTTP response shapes (snake_case,
 * created_at as ISO strings, etc). Local Drizzle returns camelCase JS objects
 * with `Date` for timestamps. Adapters live here so each tRPC procedure returns
 * the same shape the renderer already consumes — no renderer changes required.
 */

import type {
  DbBriefingStash,
  DbFlow,
  DbFlowVersion,
  DbFlowWithLatestVersion,
} from '../cloud/flows';
import type { DbFlowRun, DbFlowRunWithNodeRuns, DbNodeRun } from '../../../shared/types/flow-run';
import type {
  BatchPlanTemplate,
  BriefingStash,
  Flow,
  FlowRun,
  FlowVersion,
  NodeRun,
} from '../db/schema';

const isoOrNull = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

const isoOr = (d: Date | null | undefined, fallback: string): string =>
  d ? d.toISOString() : fallback;

type AdmissionMeta = {
  admissionState: NonNullable<DbFlowRun['admission_state']>;
  queuePosition: number | null;
  requestedAt: Date;
};

export type DbFlowDto = DbFlow;

export function toDbFlow(
  row: Flow,
  meta: {
    nodeCount?: number | null;
    triggerType?: string | null;
    latestRun?: { id: string; status: string; activeTaskStatus?: string | null } | null;
    latestRunAdmission?: AdmissionMeta | null;
  } = {},
): DbFlowDto {
  const now = new Date().toISOString();
  return {
    id: row.id,
    project_id: row.projectId ?? null,
    name: row.name,
    description: row.description ?? null,
    is_active: row.isActive,
    is_enabled: row.isEnabled,
    agent_invocable: row.agentInvocable,
    created_at: isoOr(row.createdAt, now),
    updated_at: isoOr(row.updatedAt, now),
    node_count: meta.nodeCount ?? null,
    trigger_type: meta.triggerType ?? null,
    latest_run_id: meta.latestRun?.id ?? null,
    latest_run_status: meta.latestRun?.status ?? null,
    latest_run_active_task_status: meta.latestRun?.activeTaskStatus ?? null,
    latest_run_admission_state: meta.latestRunAdmission?.admissionState ?? null,
    latest_run_queue_position: meta.latestRunAdmission?.queuePosition ?? null,
    latest_run_admission_requested_at: isoOrNull(meta.latestRunAdmission?.requestedAt),
    latest_batch_id: null,
    batch_run_count: null,
    batch_active_count: null,
  };
}

export type DbFlowWithLatestVersionDto = DbFlowWithLatestVersion;

export function toDbFlowWithLatestVersion(
  row: Flow,
  version: FlowVersion | null,
  meta: { nodeCount?: number | null; triggerType?: string | null } = {},
): DbFlowWithLatestVersionDto {
  const base = toDbFlow(row, meta);
  return {
    ...base,
    latest_version_id: version?.id ?? null,
    version_number: version?.versionNumber ?? null,
    graph: (version?.graph as DbFlowWithLatestVersion['graph']) ?? null,
    version_created_at: version ? isoOrNull(version.createdAt) : null,
    current_batch_id:
      (version?.graph as { settings?: { currentBatchId?: string } } | null)?.settings
        ?.currentBatchId ?? null,
  };
}

export type DbFlowVersionDto = DbFlowVersion;

export function toDbFlowVersion(row: FlowVersion): DbFlowVersionDto {
  return {
    id: row.id,
    flow_id: row.flowId,
    version_number: row.versionNumber,
    graph: row.graph as DbFlowVersion['graph'],
    created_at: isoOr(row.createdAt, new Date().toISOString()),
  };
}

export type DbFlowRunDto = DbFlowRun;

export function toDbFlowRun(
  row: FlowRun,
  activeTaskStatus: string | null = null,
  admission: AdmissionMeta | null = null,
): DbFlowRunDto {
  return {
    id: row.id,
    flow_version_id: row.flowVersionId,
    status: row.status,
    active_task_status: activeTaskStatus,
    admission_state: admission?.admissionState ?? null,
    queue_position: admission?.queuePosition ?? null,
    admission_requested_at: isoOrNull(admission?.requestedAt),
    trigger_context: (row.triggerContext as Record<string, unknown> | null) ?? null,
    idempotency_key: row.idempotencyKey ?? null,
    batch_id: row.batchId ?? null,
    started_at: isoOrNull(row.startedAt),
    completed_at: isoOrNull(row.completedAt),
    created_at: isoOr(row.createdAt, new Date().toISOString()),
  };
}

export function toDbFlowRunSnapshot(
  row: FlowRun,
  snapshot:
    | {
        runStatus: string;
        startedAt: Date | null;
        completedAt: Date | null;
        admission: AdmissionMeta | null;
      }
    | undefined,
): DbFlowRunDto {
  if (!snapshot) return toDbFlowRun(row);
  return toDbFlowRun(
    {
      ...row,
      status: snapshot.runStatus,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
    },
    null,
    snapshot.admission,
  );
}

type DbNodeRunDto = DbNodeRun;

function toDbNodeRun(row: NodeRun): DbNodeRunDto {
  return {
    id: row.id,
    flow_run_id: row.flowRunId,
    node_id: row.nodeId,
    block_type: row.blockType,
    status: row.status,
    node_output: (row.nodeOutput as Record<string, unknown> | null) ?? null,
    attempt_number: row.attemptNumber,
    started_at: isoOrNull(row.startedAt),
    completed_at: isoOrNull(row.completedAt),
    created_at: isoOr(row.createdAt, new Date().toISOString()),
    lane_index: row.laneIndex ?? null,
    parent_fan_out_node_run_id: row.parentFanOutNodeRunId ?? null,
  };
}

export type DbFlowRunWithNodeRunsDto = DbFlowRunWithNodeRuns;

export function toDbFlowRunWithNodeRuns(
  run: FlowRun,
  nodeRuns: NodeRun[],
  graph: unknown | null,
  admission: AdmissionMeta | null = null,
): DbFlowRunWithNodeRunsDto {
  return {
    ...toDbFlowRun(run, null, admission),
    nodeRuns: nodeRuns.map(toDbNodeRun),
    graph: graph as DbFlowRunWithNodeRuns['graph'],
  };
}

export type DbBriefingStashDto = DbBriefingStash;

export function toDbBriefingStash(row: BriefingStash): DbBriefingStashDto {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    content_preview: row.content.slice(0, 120),
    source_flow_id: row.sourceFlowId ?? null,
    source_flow_name: row.sourceFlowName ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

type BatchPlanTemplateStage = {
  stageNumber: number;
  name: string | null;
  dependsOn: number[];
};

export type DbBatchPlanTemplateDto = {
  id: string;
  name: string;
  stages: BatchPlanTemplateStage[];
  schema_version: number;
  source_flow_id: string | null;
  created_at: string;
  updated_at: string;
};

export function toDbBatchPlanTemplate(row: BatchPlanTemplate): DbBatchPlanTemplateDto {
  return {
    id: row.id,
    name: row.name,
    stages: (row.stages as BatchPlanTemplateStage[]) ?? [],
    schema_version: row.schemaVersion,
    source_flow_id: row.sourceFlowId ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
