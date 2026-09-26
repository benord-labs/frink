/**
 * DB row → cloud-shape DTO adapter for the trigger source group. Mirrors
 * `src/main/lib/flows/adapters.ts` so the renderer + 8 consumer files keep
 * compiling unchanged after the cloud → local migration.
 *
 * The cloud DTO type `RawDbFlowTriggerBinding` remains the renderer-facing
 * contract. This file's only job is shape + snake_case conversion.
 */

import type { FlowTriggerBindingType, RawDbFlowTriggerBinding } from '../cloud/trigger-bindings';
import type { FlowTriggerBinding } from '../db/schema';

function isoOr(d: Date | null | undefined, fallback: string): string {
  return d ? d.toISOString() : fallback;
}

export function toRawDbFlowTriggerBinding(row: FlowTriggerBinding): RawDbFlowTriggerBinding {
  const now = new Date().toISOString();
  const config =
    row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    project_id: row.projectId ?? null,
    trigger_type: row.triggerType as FlowTriggerBindingType,
    flow_id: row.flowId,
    config,
    is_active: row.isActive,
    last_error: row.lastError ?? null,
    created_at: isoOr(row.createdAt, now),
    updated_at: isoOr(row.updatedAt, now),
  };
}
