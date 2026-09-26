import type { ZodError, ZodType, z } from 'zod';
import { type McpToolResult, toolResult } from '../../tool-result';

/**
 * Per-session call budgets for the flow MCP tools.
 *
 * Each limiter is cleared per execution on turn teardown, so a long chat cannot
 * accumulate an unbounded number of tool calls against one flow.
 */
/**
 * A per-execution call counter, the shape every simple flow-tool rate limit
 * shares: count calls under a session key, refuse past the cap, and clear on
 * turn teardown. Six tools each carried an identical copy of the map/acquire/
 * reset trio before this. The `frink_flows_run` limiter is deliberately NOT
 * built on it — that one also tracks in-flight calls so concurrent runs cannot
 * race past the cap, and it stays in the tool module.
 */
function createSessionCallLimiter(max: number, globalKey: string) {
  const counts = new Map<string, number>();
  return {
    globalKey,
    max,
    tryAcquire(sessionKey: string): boolean {
      const count = counts.get(sessionKey) ?? 0;
      if (count >= max) return false;
      counts.set(sessionKey, count + 1);
      return true;
    },
    /** Clear counts for one execution, or all of them (from clearCurrentExecutionChat). */
    reset(executionId?: string): void {
      if (executionId === undefined) {
        counts.clear();
        return;
      }
      counts.delete(executionId);
    },
  };
}

type SessionCallLimiter = ReturnType<typeof createSessionCallLimiter>;

/** 20 get_run calls per session. Read-only, so no in-flight tracking needed. */
export const getRunLimiter = createSessionCallLimiter(20, '__global_get_run__');
export const resetFlowsGetRunCount = getRunLimiter.reset;
export const getBatchLimiter = createSessionCallLimiter(40, '__global_get_batch__');
export const resetFlowsGetBatchCount = getBatchLimiter.reset;
export const listTemplatesLimiter = createSessionCallLimiter(20, '__global_list_templates__');
export const resetFlowsListTemplatesCount = listTemplatesLimiter.reset;
/** 20 add_stage_runs calls per session. Each call adds up to 50 runs, so 1000 total per session. */
export const addStageRunsLimiter = createSessionCallLimiter(20, '__global_add_stage_runs__');
export const resetFlowsAddStageRunsCount = addStageRunsLimiter.reset;
/** 5 start_batch calls per session — should only be needed once; extra slots for retry/idempotency. */
export const startBatchLimiter = createSessionCallLimiter(5, '__global_start_batch__');
export const resetStartBatchCount = startBatchLimiter.reset;
/**
 * 20 define_stages calls per session, matching add_stage_runs. Staging is what
 * sizes a batch, and the consent card raised at start_batch quotes that size —
 * so an unbounded staging path would make the approved magnitude unstateable.
 */
export const defineStagesLimiter = createSessionCallLimiter(20, '__global_define_stages__');
export const resetDefineStagesCount = defineStagesLimiter.reset;
/**
 * 15 plugin tool-list calls per session — the only bound on a 15s vendor probe.
 * The renderer picker dedupes through React Query; an MCP caller cannot.
 */
export const listPluginToolsLimiter = createSessionCallLimiter(15, '__global_list_plugin_tools__');
export const resetListPluginToolsCount = listPluginToolsLimiter.reset;

/**
 * Parse tool arguments and take a session slot in one step.
 *
 * Returns the parsed data, or the refusal to hand straight back to the model.
 * Handlers that must run a check *before* spending a slot (the batch-consent
 * freeze, for one) parse and acquire separately instead.
 */
export function parseAndAcquire<Schema extends ZodType>(
  schema: Schema,
  args: Record<string, unknown>,
  executionId: string | undefined,
  limiter: SessionCallLimiter,
  limitMessage: string,
): { data: z.infer<Schema>; refusal?: never } | { data?: never; refusal: McpToolResult } {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { refusal: invalidArgsResult(parsed.error) };
  if (!limiter.tryAcquire(executionId ?? limiter.globalKey)) {
    return { refusal: toolResult(limitMessage, true) };
  }
  return { data: parsed.data };
}

/** The one wording every flow tool uses for a schema rejection. */
export function invalidArgsResult(error: ZodError): McpToolResult {
  return toolResult(
    `Invalid arguments: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    true,
  );
}
