import { and, desc, eq } from 'drizzle-orm';
import {
  applyCurrentBatchIdForBriefingTransition,
  type GraphWithSettings,
} from '../../flows/apply-current-batch-id';
import type { getDatabase } from '../index';
import { type Flow, flows, flowTriggerBindings, flowVersions, type NewFlow } from '../schema';

type Db = ReturnType<typeof getDatabase>;

const COPY_SUFFIX = ' (copy)';
const MAX_FLOW_NAME_LENGTH = 200;
const TRAILING_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/;

export class FlowCopyNotFoundError extends Error {
  constructor() {
    super('Flow not found');
    this.name = 'FlowCopyNotFoundError';
  }
}

export class FlowCopyNoSavedVersionError extends Error {
  constructor() {
    super('Flow has no saved version');
    this.name = 'FlowCopyNoSavedVersionError';
  }
}

function copiedFlowName(name: string): string {
  const maxSourceLength = MAX_FLOW_NAME_LENGTH - COPY_SUFFIX.length;
  let sourceName = name.slice(0, maxSourceLength);
  if (TRAILING_HIGH_SURROGATE_RE.test(sourceName)) sourceName = sourceName.slice(0, -1);
  return `${sourceName}${COPY_SUFFIX}`;
}

function bindingScopeKey(binding: { triggerType: string; projectId: string | null }): string {
  return `${binding.triggerType}\0${binding.projectId ?? ''}`;
}

/**
 * Local SQLite flows repository.
 *
 * Mirrors the surface previously provided by `src/main/lib/cloud/flows.ts` over HTTP,
 * but against the local flows table. Cuid2 IDs (not Neon UUIDs).
 */

// fallow-ignore-next-line code-duplication -- every repository spells insert/select alike to keep its row type.
export async function createFlow(db: Db, input: NewFlow): Promise<Flow> {
  const [row] = await db.insert(flows).values(input).returning();
  return row;
}

export async function getFlowById(db: Db, id: string): Promise<Flow | null> {
  const [row] = await db.select().from(flows).where(eq(flows.id, id)).limit(1);
  return row ?? null;
}

export async function listFlows(db: Db, projectId?: string | null): Promise<Flow[]> {
  const scope =
    projectId === undefined || projectId === null
      ? eq(flows.isActive, true)
      : and(eq(flows.projectId, projectId), eq(flows.isActive, true));
  return db.select().from(flows).where(scope).orderBy(desc(flows.updatedAt));
}

// fallow-ignore-next-line code-duplication -- list/update stay per-table so each returns its own row type.
export async function updateFlow(
  db: Db,
  id: string,
  patch: Partial<Omit<Flow, 'id' | 'createdAt'>>,
): Promise<Flow | null> {
  const [row] = await db
    .update(flows)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(flows.id, id))
    .returning();
  return row ?? null;
}

export async function copyFlow(db: Db, input: { sourceFlowId: string }): Promise<{ id: string }> {
  return db.transaction(
    (tx) => {
      const source = tx
        .select()
        .from(flows)
        .where(and(eq(flows.id, input.sourceFlowId), eq(flows.isActive, true)))
        .limit(1)
        .all()[0];
      if (!source) throw new FlowCopyNotFoundError();

      const latestVersion = tx
        .select()
        .from(flowVersions)
        .where(eq(flowVersions.flowId, source.id))
        .orderBy(desc(flowVersions.versionNumber))
        .limit(1)
        .all()[0];
      if (!latestVersion) throw new FlowCopyNoSavedVersionError();

      const copiedGraph = structuredClone(latestVersion.graph) as GraphWithSettings;
      applyCurrentBatchIdForBriefingTransition(copiedGraph, undefined, undefined);
      const now = new Date();
      const copiedFlow = tx
        .insert(flows)
        .values({
          projectId: source.projectId,
          name: copiedFlowName(source.name),
          description: source.description,
          isActive: true,
          isEnabled: false,
          agentInvocable: source.agentInvocable,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: flows.id })
        .all()[0];

      tx.insert(flowVersions)
        .values({ flowId: copiedFlow.id, versionNumber: 1, graph: copiedGraph })
        .run();

      const sourceBindings = tx
        .select()
        .from(flowTriggerBindings)
        .where(eq(flowTriggerBindings.flowId, source.id))
        .orderBy(
          desc(flowTriggerBindings.isActive),
          desc(flowTriggerBindings.updatedAt),
          desc(flowTriggerBindings.createdAt),
        )
        .all();
      const copiedScopes = new Set<string>();
      for (const binding of sourceBindings) {
        const scopeKey = bindingScopeKey(binding);
        if (copiedScopes.has(scopeKey)) continue;
        copiedScopes.add(scopeKey);
        tx.insert(flowTriggerBindings)
          .values({
            flowId: copiedFlow.id,
            projectId: binding.projectId,
            triggerType: binding.triggerType,
            config: structuredClone(binding.config),
            isActive: false,
            lastError: null,
            lastErrorAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }

      return { id: copiedFlow.id };
    },
    { behavior: 'immediate' },
  );
}
