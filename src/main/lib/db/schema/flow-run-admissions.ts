import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  FlowAdmissionPriorityClass,
  FlowAdmissionState,
} from '../../../../shared/lib/flow-admission';

type FlowRunsTable = typeof import('./index').flowRuns;

export function flowAdmissionQueueOrderKey(table: {
  queueOrder: AnySQLiteColumn;
  ticket: AnySQLiteColumn;
}) {
  return sql`coalesce(${table.queueOrder}, ${table.ticket})`;
}

export function defineFlowRunAdmissions(flowRuns: FlowRunsTable) {
  return sqliteTable(
    'flow_run_admissions',
    {
      ticket: integer('ticket').primaryKey({ autoIncrement: true }),
      flowRunId: text('flow_run_id')
        .notNull()
        .references(() => flowRuns.id, { onDelete: 'cascade' }),
      state: text('state').$type<FlowAdmissionState>().notNull().default('queued'),
      priorityClass: text('priority_class').$type<FlowAdmissionPriorityClass>().notNull(),
      queueOrder: integer('queue_order'),
      intentVersion: integer('intent_version').notNull(),
      intentJson: text('intent_json', { mode: 'json' }).notNull(),
      requestedAt: integer('requested_at', { mode: 'timestamp' })
        .notNull()
        .$defaultFn(() => new Date()),
      claimedAt: integer('claimed_at', { mode: 'timestamp' }),
      startedAt: integer('started_at', { mode: 'timestamp' }),
      settledAt: integer('settled_at', { mode: 'timestamp' }),
      error: text('error'),
    },
    (table) => [
      check(
        'flow_run_admissions_state_check',
        sql`${table.state} IN ('queued', 'claimed', 'active', 'releasing', 'released', 'failed', 'cancelled')`,
      ),
      check(
        'flow_run_admissions_priority_check',
        sql`${table.priorityClass} IN ('start', 'resume')`,
      ),
      index('flow_run_admissions_queue_idx')
        .on(table.priorityClass, flowAdmissionQueueOrderKey(table), table.ticket)
        .where(sql`${table.state} = 'queued'`),
      index('flow_run_admissions_occupied_idx')
        .on(table.state)
        .where(sql`${table.state} IN ('claimed', 'active', 'releasing')`),
      index('flow_run_admissions_live_ticket_idx')
        .on(table.ticket)
        .where(sql`${table.state} IN ('queued', 'claimed', 'active', 'releasing')`),
      index('flow_run_admissions_settled_idx')
        .on(table.settledAt, table.ticket)
        .where(
          sql`${table.state} IN ('released', 'failed', 'cancelled') AND ${table.settledAt} IS NOT NULL`,
        ),
      uniqueIndex('flow_run_admissions_live_run_uniq')
        .on(table.flowRunId)
        .where(sql`${table.state} IN ('queued', 'claimed', 'active', 'releasing')`),
    ],
  );
}
