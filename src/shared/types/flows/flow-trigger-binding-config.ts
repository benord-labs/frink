/**
 * Canonical Zod schemas for `flow_trigger_bindings.config`, one per trigger type.
 * The types are derived via `z.infer` so the tRPC boundary and the renderer cannot drift.
 */
import { z } from 'zod';

const postTaskTriggerStateSchema = z.enum([
  'done',
  'completed',
  'failed',
  'cancelled',
  'needs_attention',
  'plan_ready',
  'all',
]);

export type PostTaskTriggerState = z.infer<typeof postTaskTriggerStateSchema>;

export const postTaskBindingConfigSchema = z.strictObject({
  triggerStates: z.array(postTaskTriggerStateSchema).min(1),
  filterBySource: z.array(z.string()).optional(),
});

export type PostTaskBindingConfig = z.infer<typeof postTaskBindingConfigSchema>;

/** A schedule's cron, timezone and skip rule live on its flow-graph node, so the binding carries none. */
export const scheduleBindingConfigSchema = z.strictObject({});

const BINDING_CONFIG_SCHEMAS = {
  post_task_trigger: postTaskBindingConfigSchema,
  schedule_trigger: scheduleBindingConfigSchema,
} as const;

export type BindingConfigTriggerType = keyof typeof BINDING_CONFIG_SCHEMAS;

export function isBindingConfigTriggerType(value: string): value is BindingConfigTriggerType {
  return Object.hasOwn(BINDING_CONFIG_SCHEMAS, value);
}

export function bindingConfigSchemaFor(
  triggerType: BindingConfigTriggerType,
): (typeof BINDING_CONFIG_SCHEMAS)[BindingConfigTriggerType] {
  return BINDING_CONFIG_SCHEMAS[triggerType];
}
