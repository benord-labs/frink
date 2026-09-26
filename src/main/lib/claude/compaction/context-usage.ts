import type { ModelUsage, SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const SYNTHETIC_MODEL = '<synthetic>';
const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

/** The main model's window, else the largest one reported. */
function contextWindowFor(
  modelUsage: Record<string, ModelUsage>,
  model: string | undefined,
): number | undefined {
  const exact = model ? modelUsage[model]?.contextWindow : undefined;
  return (
    exact || Math.max(0, ...Object.values(modelUsage).map((u) => u.contextWindow)) || undefined
  );
}

// A real main-thread API call. Subagents run in their own context, and the CLI's `<synthetic>`
// stand-ins (interrupts, errors) report zero usage.
function isMainThreadCall(msg: SDKMessage): msg is SDKAssistantMessage {
  return (
    msg.type === 'assistant' &&
    !msg.parent_tool_use_id &&
    msg.message.model !== SYNTHETIC_MODEL &&
    Boolean(msg.message.usage)
  );
}

// The shortest TTL this call wrote: 5m blocks follow 1h blocks and hold the newest messages, so they
// expire first. Undefined when the call wrote nothing (a pure cache read keeps its original TTL).
function cacheTtlWritten(msg: SDKAssistantMessage): number | undefined {
  const written = msg.message.usage.cache_creation;
  if (written?.ephemeral_5m_input_tokens) return FIVE_MINUTES_MS;
  if (written?.ephemeral_1h_input_tokens) return ONE_HOUR_MS;
  return undefined;
}

// A pure cache read keeps its original TTL; a call that neither read nor wrote used none.
function nextCacheTtl(msg: SDKAssistantMessage, previous: number | undefined): number | undefined {
  return cacheTtlWritten(msg) ?? (msg.message.usage.cache_read_input_tokens ? previous : undefined);
}

/** A call's whole prompt: fresh input plus what it read from and wrote to the cache. */
function promptTokens(usage: SDKAssistantMessage['message']['usage']): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

// Occupancy is the LAST main-thread call's prompt (fresh + cached input), reset by compaction.
// The result's `usage` sums the whole turn — that is spend, not how full the window is.
export function createContextUsageTracker() {
  let tokens: number | undefined;
  let window: number | undefined;
  let model: string | undefined;
  // Prompt-cache TTL anchor: the cache refreshes when a request is read, so a call's first frame
  // (one call can emit several frames seconds apart) is the closest observable time.
  let cacheTtlMs: number | undefined;
  let lastCallAt: number | undefined;
  let lastCallId: string | undefined;

  return {
    observe(msg: SDKMessage): void {
      if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        tokens = msg.compact_metadata.post_tokens;
        cacheTtlMs = undefined; // compaction rewrites the prompt, so the cached prefix is gone
        lastCallAt = undefined;
      } else if (isMainThreadCall(msg)) {
        // Once per call: its frames repeat the call's usage, so a later frame never re-decides it.
        if (msg.message.id !== lastCallId) {
          lastCallId = msg.message.id;
          lastCallAt = Date.now();
          cacheTtlMs = nextCacheTtl(msg, cacheTtlMs);
        }
        tokens = promptTokens(msg.message.usage);
        model = msg.message.model;
      } else if (msg.type === 'result' && msg.modelUsage) {
        window = contextWindowFor(msg.modelUsage, model);
      }
    },

    /** Context fields for the turn's result metadata; `observe` has already seen the result.
     *  `promptCacheExpiresAt` is an upper bound (epoch ms): a model or thinking change also goes cold. */
    snapshot() {
      const promptCacheExpiresAt =
        cacheTtlMs && lastCallAt !== undefined ? lastCallAt + cacheTtlMs : undefined;
      return { contextTokens: tokens, contextWindow: window, promptCacheExpiresAt };
    },
  };
}
