/**
 * @deprecated Cloud client — flow_trigger_bindings (Railway).
 *
 * Local migration (Phase 2 finish-list #1) moved trigger-binding CRUD to
 * `src/main/lib/db/repos/flow-trigger-bindings.ts` + `routers/trigger-bindings.ts`.
 * This file is retained for type re-exports (`RawDbFlowTriggerBinding`,
 * `DbFlowTriggerBinding`, `FlowTriggerBindingType`) consumed by the
 * `integrations/adapters.ts` cloud-shape DTO; no runtime function survives here.
 */

import type { CamelKeyed } from '../../../shared/lib/case-converter';

/** Exported: tRPC / declaration emit names return types (TS4023). */
export type FlowTriggerBindingType = 'post_task_trigger' | 'schedule_trigger';

export type RawDbFlowTriggerBinding = {
  id: string;
  project_id: string | null;
  trigger_type: FlowTriggerBindingType;
  flow_id: string;
  config: Record<string, unknown>;
  is_active: boolean;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/** Exported: tRPC / declaration emit names return types (TS4023). */
export type DbFlowTriggerBinding = CamelKeyed<RawDbFlowTriggerBinding>;
