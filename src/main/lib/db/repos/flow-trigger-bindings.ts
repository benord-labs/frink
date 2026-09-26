/** Local flow_trigger_bindings repo: post-task and schedule triggers only, since a webhook trigger's
 * binding is its flow-graph node. A ticking schedule upserts a row so a user disable has one to flip. */

import { and, sql as drizzleSql, eq } from 'drizzle-orm';
import type { getDatabase } from '../index';
import {
  type FlowTriggerBinding,
  flowTriggerBindings,
  type NewFlowTriggerBinding,
} from '../schema';

type Db = ReturnType<typeof getDatabase>;

export type LocalTriggerType = 'post_task_trigger' | 'schedule_trigger';
const ALLOWED_TRIGGER_TYPES: ReadonlySet<string> = new Set([
  'post_task_trigger',
  'schedule_trigger',
]);

export class TriggerTypeNotSupportedError extends Error {
  constructor(public readonly triggerType: string) {
    super(
      `triggerType '${triggerType}' is not supported in local-only mode. Allowed: ${[...ALLOWED_TRIGGER_TYPES].join(', ')}.`,
    );
    this.name = 'TriggerTypeNotSupportedError';
  }
}

/** One active binding per (flow, project, trigger type), so re-enabling a second same-shape row fails. */
export class TriggerScopeAlreadyActiveError extends Error {
  constructor() {
    super('Another active trigger already covers this flow, project and trigger type');
    this.name = 'TriggerScopeAlreadyActiveError';
  }
}

const BINDING_SCOPE_TAKEN_REGEX = /flow_trigger_bindings_uq/i;

function assertTriggerTypeAllowed(t: string): asserts t is LocalTriggerType {
  if (!ALLOWED_TRIGGER_TYPES.has(t)) {
    throw new TriggerTypeNotSupportedError(t);
  }
}

export async function listForFlow(db: Db, flowId: string): Promise<FlowTriggerBinding[]> {
  return db.select().from(flowTriggerBindings).where(eq(flowTriggerBindings.flowId, flowId));
}

export async function listForProject(db: Db, projectId: string): Promise<FlowTriggerBinding[]> {
  return db.select().from(flowTriggerBindings).where(eq(flowTriggerBindings.projectId, projectId));
}

/**
 * Active rows of a given triggerType. Used by:
 * - schedule poller (`triggerType='schedule_trigger'`) before firing
 * - post-task fan-out (`triggerType='post_task_trigger'`) on each terminal task
 */
export async function listActiveForType(
  db: Db,
  triggerType: LocalTriggerType,
): Promise<FlowTriggerBinding[]> {
  return db
    .select()
    .from(flowTriggerBindings)
    .where(
      and(eq(flowTriggerBindings.triggerType, triggerType), eq(flowTriggerBindings.isActive, true)),
    );
}

export async function create(db: Db, input: NewFlowTriggerBinding): Promise<FlowTriggerBinding> {
  assertTriggerTypeAllowed(input.triggerType);
  const [row] = await db
    .insert(flowTriggerBindings)
    .values({ ...input, updatedAt: new Date() })
    .returning();
  return row;
}

export async function update(
  db: Db,
  id: string,
  patch: Partial<Pick<FlowTriggerBinding, 'config' | 'isActive'>> & {
    clearLastError?: boolean;
  },
): Promise<FlowTriggerBinding | null> {
  const set: Partial<FlowTriggerBinding> = { updatedAt: new Date() };
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (patch.clearLastError) {
    set.lastError = null;
    set.lastErrorAt = null;
  }
  try {
    const [row] = await db
      .update(flowTriggerBindings)
      .set(set)
      .where(eq(flowTriggerBindings.id, id))
      .returning();
    return row ?? null;
  } catch (error) {
    if (BINDING_SCOPE_TAKEN_REGEX.test(String(error))) throw new TriggerScopeAlreadyActiveError();
    throw error;
  }
}

export async function deleteBinding(db: Db, id: string): Promise<boolean> {
  const removed = await db
    .delete(flowTriggerBindings)
    .where(eq(flowTriggerBindings.id, id))
    .returning({ id: flowTriggerBindings.id });
  return removed.length > 0;
}

/**
 * Lazy-upsert for schedule_trigger bindings. Engine calls this when ticking a
 * schedule_trigger flow that has no binding row yet (legacy flow saved before
 * triggers migration). INSERTs an isActive=true row so the user can toggle.
 *
 * Concurrency: we INSERT inside a BEGIN IMMEDIATE transaction guarded by a
 * preliminary SELECT — the SQLite UNIQUE partial index on
 * (flow, COALESCE(project,''), type) WHERE is_active=1 enforces the
 * one-row invariant. On collision we return the existing row.
 */
export async function upsertScheduleBindingForFlow(
  db: Db,
  input: { flowId: string; projectId: string | null },
): Promise<FlowTriggerBinding> {
  return db.transaction(
    (tx) => {
      // SELECT does NOT filter on isActive — a previously-disabled binding
      // must be returned as-is so the caller can honour the user's disable.
      // Without this guard, the SELECT-then-INSERT fall-through would leave
      // the disabled row in place AND insert a fresh active one, silently
      // resurrecting the schedule. The partial UNIQUE index permits both
      // because it's WHERE is_active=1.
      const existing = tx
        .select()
        .from(flowTriggerBindings)
        .where(
          and(
            eq(flowTriggerBindings.flowId, input.flowId),
            eq(flowTriggerBindings.triggerType, 'schedule_trigger'),
            drizzleSql`COALESCE(${flowTriggerBindings.projectId}, '') = COALESCE(${input.projectId}, '')`,
          ),
        )
        .orderBy(drizzleSql`${flowTriggerBindings.createdAt} DESC`)
        .limit(1)
        .all();
      if (existing[0]) return existing[0];
      const inserted = tx
        .insert(flowTriggerBindings)
        .values({
          flowId: input.flowId,
          projectId: input.projectId,
          triggerType: 'schedule_trigger',
          config: null,
          isActive: true,
          updatedAt: new Date(),
        })
        .returning()
        .all();
      return inserted[0];
    },
    { behavior: 'immediate' },
  );
}
