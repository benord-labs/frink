/**
 * @deprecated Cloud client — trigger rules (Railway).
 *
 * trigger_rules has no v1 local consumer (post_task + schedule both read
 * `flow_trigger_bindings` directly). Router stub at
 * `src/main/lib/trpc/routers/trigger-rules.ts` returns safe defaults for
 * read paths and throws PRECONDITION_FAILED for mutations.
 *
 * File retained for `DbTriggerRule` / `RawDbTriggerRuleRow` type imports
 * referenced by the renderer + adapters.
 */

/**
 * Domain-level trigger rule shape (declaration emit for tRPC outputs).
 */
export type DbTriggerRule = {
  id: string;
  userId: string;
  integrationId: string;
  name: string;
  description: string | null;
  eventType: string;
  conditions: Record<string, unknown>;
  action: 'create_task' | 'notify_only' | 'create_task_and_notify';
  actionConfig: Record<string, unknown>;
  notifyOnTrigger: boolean;
  isActive: boolean;
  /** Bound flow (optional); when set, matching triggers start a flow run instead of a bare task. */
  flowId: string | null;
  createdAt: string;
  updatedAt: string;
};
