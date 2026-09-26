/**
 * Canonical Zod schema for flow graph `settings` (persisted JSON).
 * `FlowSettings` is derived via `z.infer` so tRPC and TypeScript cannot drift.
 *
 * generated mirror whose parity a sync test asserts.
 */
import { z } from 'zod';

const batchTriggerSchemaItem = z.object({
  key: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z_]\w*$/, 'Key must be a valid identifier (letters, digits, underscore)'),
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  description: z.string().max(200).optional(),
  example: z.string().max(200).optional(),
});

export type BatchTriggerSchemaItem = z.infer<typeof batchTriggerSchemaItem>;

export const flowSettingsShapeSchema = z.object({
  defaultModel: z
    .string()
    .optional()
    .describe("Default model PICKER id (e.g. 'opus-4.8', 'opus-4.8-max'), not the CLI value."),
  defaultProjectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Default project id (cuid2 locally; UUIDs from pre-migration cloud rows still accepted) for start_task and run_command nodes without an explicit projectId.',
    ),
  briefing: z
    .string()
    .max(10000)
    .optional()
    .describe(
      'Shared context (PRD, spec, checklist) delivered once per flow session as a system prompt to every agent in the flow — not repeated in each message, not referenced in instructions. Rendered against {{trigger.*}} only. Set via frink_flows_patch. ~2,500 tokens max.',
    ),
  pauseOnFailure: z
    .boolean()
    .optional()
    .describe(
      'When true, a node failure pauses the flow instead of terminating it immediately. The run can be resumed by retrying or skipping the failed node.',
    ),
  autoAcceptCompletedRuns: z
    .boolean()
    .optional()
    .describe(
      "When true, a successfully completed run finalizes its tasks straight to 'completed' (no review gate). Default off: finished work lands at 'done' (Ready for review) until the user accepts it.",
    ),
  autoReviewTools: z
    .boolean()
    .optional()
    .describe(
      'Whether eligible provider-backed Agent steps use the provider native Auto reviewer. Defaults to on when omitted. Direct run_command and custom-node steps are unaffected.',
    ),
  codexFastMode: z
    .boolean()
    .optional()
    .describe(
      "Whether Codex-backed Agent steps request the 'priority' (Fast) service tier, which bills 2-2.5x credits for lower latency. Defaults to OFF when omitted. Flow-level only — there is deliberately no per-node override, so an automation's cost policy stays visible across its whole graph. Ignored by non-Codex accounts and by Codex models with no priority tier.",
    ),
  maxBatchConcurrency: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Maximum concurrent agent executions per batch run. Defaults to the worker ceiling of 5 and can only cap below it, not above. Set via frink_flows_patch update_settings.',
    ),
  batchTriggerSchema: z
    .array(batchTriggerSchemaItem)
    .max(100)
    .optional()
    .describe(
      'Declared trigger variables for batch flows using manual_trigger. Each entry describes a {{trigger.<key>}} variable that the CEO agent will inject via frink_flows_define_stages triggerContext. Declaring variables here upgrades them from the generic "any key" note to clickable chips in the Available Variables panel. Set via frink_flows_patch update_settings.',
    ),
});

export type FlowSettings = z.infer<typeof flowSettingsShapeSchema>;

/** Use on `FlowGraph.settings`: the whole settings object may be absent. */
export const flowSettingsSchema = flowSettingsShapeSchema.optional();
