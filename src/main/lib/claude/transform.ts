/* eslint-disable max-lines, max-lines-per-function */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import log from 'electron-log';
import { SUBAGENT_TEXT_TOOL_NAME } from '../../../shared/subagent-parts';
import { createCompactionMapper, createContextUsageTracker } from './compaction';
import { createThinkingEmitter } from './thinking-emitter';
import type { MCPServer, MCPServerStatus, MessageMetadata, UIMessageChunk } from './types';

/**
 * Cap on the in-flight `accumulatedToolInput` buffer per tool call. A 300-line
 * `Edit` is ~50-100 KB; 2 MiB is comfortably above any legitimate single tool
 * input but bounds the heap when the SDK emits a malformed/never-closing
 * stream.
 */
const MAX_PARTIAL_TOOL_INPUT_BYTES = 2 * 1024 * 1024;
/** Above this, the salvage path emits truncated `_rawHead`/`_rawTail` instead of the full string. */
const MAX_SALVAGE_RAW_BYTES = 64 * 1024;

// Type definitions for incoming messages
type BaseMessage = {
  type: string;
  parent_tool_use_id?: string;
};

type SystemMessage = BaseMessage & {
  type: 'system';
  subtype?: 'init' | 'status' | 'compact_boundary';
  mcp_servers?: Array<{
    name: string;
    status: string;
    serverInfo?: {
      name: string;
      version: string;
      icons?: { src: string; mimeType?: string; sizes?: string[]; theme?: 'light' | 'dark' }[];
    };
    error?: string;
  }>;
  tools?: string[];
  plugins?: Array<{ name: string; path: string }>;
  skills?: string[];
  status?: string;
  /** Terminal outcome of a compaction; only `status` messages carry it. */
  compact_result?: 'success' | 'failed';
};

type StreamEventMessage = BaseMessage & {
  type: 'stream_event';
  event?: {
    type: string;
    content_block?: {
      type?: string;
      id?: string;
      name?: string;
    };
    delta?: {
      type?: string;
      text?: string;
      partial_json?: string;
      thinking?: string;
    };
  };
};

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

type AssistantMessage = BaseMessage & {
  type: 'assistant';
  message?: {
    content?: ContentBlock[];
  };
};

type UserMessage = BaseMessage & {
  type: 'user';
  message?: {
    content?: Array<{
      type: string;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
    }>;
  };
  tool_use_result?: unknown;
};

type ResultMessage = BaseMessage & {
  type: 'result';
  uuid?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
  session_id?: string;
  total_cost_usd?: number;
  subtype?: string;
};

// Type guards
function isSystemMessage(msg: unknown): msg is SystemMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'system';
}

function isStreamEventMessage(msg: unknown): msg is StreamEventMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'stream_event';
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'assistant';
}

function isUserMessage(msg: unknown): msg is UserMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'user';
}

function isResultMessage(msg: unknown): msg is ResultMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg && msg.type === 'result';
}

function hasParentToolUseId(msg: unknown): msg is BaseMessage & { parent_tool_use_id: string } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'parent_tool_use_id' in msg &&
    typeof (msg as { parent_tool_use_id?: unknown }).parent_tool_use_id === 'string'
  );
}

// Best-effort extraction of top-level "key": "value" pairs from a partial JSON string.
// Used to salvage `description`/`subagent_type` when a Task tool's input stream is
// truncated mid-field — enough to render the subagent card while the full input is
// still arriving via the assistant message repair path.
const PARTIAL_JSON_STRING_FIELD_RE = /"([a-zA-Z_][\w]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
function salvagePartialJsonFields(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  PARTIAL_JSON_STRING_FIELD_RE.lastIndex = 0;
  for (;;) {
    const m = PARTIAL_JSON_STRING_FIELD_RE.exec(raw);
    if (m === null) break;
    out[m[1]] = m[2];
  }
  return out;
}

export function createTransformer() {
  let textId: string | null = null;
  let textStarted: boolean = false;
  let started: boolean = false;
  let startTime: number | null = null;

  // Track streaming tool calls
  let currentToolCallId: string | null = null;
  let currentToolName: string | null = null;
  let accumulatedToolInput: string = '';

  // Track already emitted tool IDs to avoid duplicates
  // (tools can come via streaming AND in the final assistant message)
  const emittedToolIds = new Set<string>();

  // Track the last text block ID for final response marking
  // This is used to identify when there's a "final text" response after tools
  let lastTextId: string | null = null;

  // Track parent tool context for nested tools (e.g., Explore agent)
  let currentParentToolUseId: string | null = null;

  // Map original toolCallId -> composite toolCallId (for tool-result matching)
  const toolIdMapping = new Map<string, string>();

  /**
   * Composite toolCallIds emitted with partial/salvaged input. When an assistant
   * `tool_use` block arrives later with the full parsed input, these are allowed
   * to re-emit (supersede) instead of being deduped out by `emittedToolIds`.
   */
  const partialEmissions = new Set<string>();

  // Session-scoped SDK state: compaction cards (status->boundary) and context-window occupancy
  const mapCompaction = createCompactionMapper();
  const contextUsage = createContextUsageTracker();

  const thinking = createThinkingEmitter();
  // Tracks whether we already received streaming thinking deltas for the current message.
  // Some providers can deliver assistant final content before thinking content_block_stop.
  let sawThinkingDelta = false;

  const makeCompositeId = (originalId: string, parentId: string | null): string =>
    parentId ? `${parentId}:${originalId}` : originalId;

  const genId = () => `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  /**
   * Close the open text run. The run belongs to the root agent, so a subagent-scoped block must
   * never close it — a subagent firing a tool mid-sentence would split the root's paragraph at the
   * point of interruption. Guarding here covers every caller.
   */
  function* endTextBlock(): Generator<UIMessageChunk> {
    if (currentParentToolUseId) return;
    if (textStarted && textId) {
      yield { type: 'text-end', id: textId };
      // Track the last text ID for final response marking
      lastTextId = textId;
      textStarted = false;
      textId = null;
    }
  }

  // Helper to end current tool input
  function* endToolInput(): Generator<UIMessageChunk> {
    if (!currentToolCallId) return;

    const compositeId = currentToolCallId;
    const toolName = currentToolName || 'unknown';
    const raw = accumulatedToolInput;

    currentToolCallId = null;
    currentToolName = null;
    accumulatedToolInput = '';

    if (!raw) {
      emittedToolIds.add(compositeId);
      yield {
        type: 'tool-input-available',
        toolCallId: compositeId,
        toolName,
        input: {},
      };
      return;
    }

    try {
      const parsedInput: unknown = JSON.parse(raw);
      emittedToolIds.add(compositeId);
      yield {
        type: 'tool-input-available',
        toolCallId: compositeId,
        toolName,
        input: parsedInput,
      };
    } catch (e) {
      log.warn(
        '[transform] Partial tool input JSON, salvaging:',
        (e as Error).message,
        'partial:',
        raw.slice(0, 120),
      );
      // Emit immediately with salvaged top-level string fields so subagent Task cards
      // render with their subagent_type/description while the full input is repaired
      // via the assistant message path. Track the compositeId so the repair path can
      // recognise and supersede it instead of deduping it out.
      partialEmissions.add(compositeId);
      emittedToolIds.add(compositeId);
      const salvaged = salvagePartialJsonFields(raw);
      // Avoid echoing a giant raw buffer back through IPC + DB on every salvage.
      // Truncate large strings to head/tail slices for diagnostics; the full
      // input arrives later via the assistant message repair path anyway.
      const rawPayload =
        raw.length > MAX_SALVAGE_RAW_BYTES
          ? {
              _rawTruncated: true,
              _rawLength: raw.length,
              _rawHead: raw.slice(0, MAX_SALVAGE_RAW_BYTES / 2),
              _rawTail: raw.slice(-MAX_SALVAGE_RAW_BYTES / 2),
            }
          : { _raw: raw };
      yield {
        type: 'tool-input-available',
        toolCallId: compositeId,
        toolName,
        input: { ...salvaged, _partial: true, ...rawPayload },
      };
    }
  }

  return function* transform(msg: unknown): Generator<UIMessageChunk> {
    contextUsage.observe(/* SAFETY: both callers feed raw SDK frames */ msg as SDKMessage);
    // Track parent_tool_use_id for nested tools.
    // Subagent messages always carry parent_tool_use_id; root messages never do.
    // Reset per turn-level message so root tools emitted after a subagent finishes
    // don't inherit a stale parent and get mis-prefixed as composite children.
    // System messages (init/status/compact_boundary) are session-scoped and left alone.
    if (
      isAssistantMessage(msg) ||
      isUserMessage(msg) ||
      isResultMessage(msg) ||
      isStreamEventMessage(msg)
    ) {
      // The RAW parent id, never one resolved through toolIdMapping: a wake burst rebuilds the
      // transformer with an empty map, so resolving would key a call and its later result
      // differently and the result would match no card. Costs sub-subagent nesting, which flattens
      // to the immediate parent — the renderer has always treated grandchildren that way.
      currentParentToolUseId = hasParentToolUseId(msg) ? msg.parent_tool_use_id : null;
    }

    // Emit start once
    if (!started) {
      started = true;
      startTime = Date.now();
      yield { type: 'start' };
      yield { type: 'start-step' };
    }

    // Reset thinking state on new message start to prevent memory leaks
    if (isStreamEventMessage(msg) && msg.event?.type === 'message_start') {
      thinking.reset();
      sawThinkingDelta = false;
      emittedToolIds.delete('thinking-streamed');
    }

    // ===== STREAMING EVENTS (token-by-token) =====
    if (isStreamEventMessage(msg)) {
      const event = msg.event;
      if (!event) return;

      // The text channel belongs to the root agent alone. A subagent's streamed prose is dropped
      // here rather than routed onto it: it would hijack the root's run, which endTextBlock then
      // refuses to close, so it would flush onto the root's own timeline — and the consolidating
      // assistant message re-emits that prose as a nested SubagentText part regardless.
      if (!currentParentToolUseId) {
        // Text block start
        if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
          yield* endTextBlock();
          yield* endToolInput();
          textId = genId();
          yield { type: 'text-start', id: textId };
          textStarted = true;
        }

        // Text delta
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (!textStarted) {
            yield* endToolInput();
            textId = genId();
            yield { type: 'text-start', id: textId };
            textStarted = true;
          }
          yield { type: 'text-delta', id: textId || '', delta: event.delta.text || '' };
        }
      }

      // Content block stop
      if (event.type === 'content_block_stop') {
        if (textStarted) {
          yield* endTextBlock();
        }
        if (currentToolCallId) {
          yield* endToolInput();
        }
      }

      // Tool use start (streaming)
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        yield* endTextBlock();
        yield* endToolInput();

        const originalId = event.content_block.id || genId();
        currentToolCallId = makeCompositeId(originalId, currentParentToolUseId);
        currentToolName = event.content_block.name || 'unknown';
        accumulatedToolInput = '';

        // Store mapping for tool-result lookup
        toolIdMapping.set(originalId, currentToolCallId);

        // Emit tool-input-start for progressive UI
        yield {
          type: 'tool-input-start',
          toolCallId: currentToolCallId,
          toolName: currentToolName || 'unknown',
        };
      }

      // Tool input delta
      if (event.delta?.type === 'input_json_delta' && currentToolCallId) {
        const partialJson = event.delta.partial_json || '';
        // Cap the accumulator: a runaway partial-JSON stream (e.g. malformed
        // tool input that never closes) would otherwise pin unbounded heap
        // until the next tool boundary.
        if (accumulatedToolInput.length + partialJson.length <= MAX_PARTIAL_TOOL_INPUT_BYTES) {
          accumulatedToolInput += partialJson;
        } else if (accumulatedToolInput.length < MAX_PARTIAL_TOOL_INPUT_BYTES) {
          accumulatedToolInput += partialJson.slice(
            0,
            MAX_PARTIAL_TOOL_INPUT_BYTES - accumulatedToolInput.length,
          );
        }

        // Emit tool-input-delta for progressive UI
        yield {
          type: 'tool-input-delta',
          toolCallId: currentToolCallId,
          inputTextDelta: partialJson,
        };
      }

      // Thinking streams as tool-like chunks. Subagent deltas are dropped like its text: the emitter
      // mints a parentless id, and sawThinkingDelta would suppress the assistant path's thought.
      if (!currentParentToolUseId && event.delta?.type === 'thinking_delta') {
        const thinkingText = String(event.delta.thinking || '');
        sawThinkingDelta = true;
        for (const chunk of thinking.delta(thinkingText)) {
          yield chunk;
        }
      }

      // Thinking complete. A subagent's block stop must not close the ROOT's open thought.
      if (!currentParentToolUseId && event.type === 'content_block_stop' && thinking.isActive()) {
        const id = thinking.currentId();
        for (const chunk of thinking.complete()) {
          yield chunk;
        }
        // Track as emitted to skip duplicate from assistant message
        if (id) emittedToolIds.add(id);
        emittedToolIds.add('thinking-streamed');
      }
    }

    // ===== ASSISTANT MESSAGE (complete, often with tool_use) =====
    // When streaming is enabled, text arrives via stream_event, not here
    if (isAssistantMessage(msg) && msg.message?.content) {
      for (const block of msg.message.content) {
        // Handle thinking blocks from Extended Thinking
        // Skip if already emitted via streaming (thinking_delta)
        if (block.type === 'thinking' && block.thinking) {
          // Check if we already streamed this thinking block
          // We compare by checking if accumulated thinking matches
          const wasStreamed = emittedToolIds.has('thinking-streamed');

          if (wasStreamed || sawThinkingDelta) {
            continue;
          }

          // The "Thinking" tool name lets the UI render it like any other tool.
          const thinkingId = makeCompositeId(genId(), currentParentToolUseId);
          yield {
            type: 'tool-input-available',
            toolCallId: thinkingId,
            toolName: 'Thinking',
            input: { text: block.thinking },
            providerExecuted: true,
          };
          // Immediately mark as complete
          yield {
            type: 'tool-output-available',
            toolCallId: thinkingId,
            output: { completed: true },
          };
        }

        if (block.type === 'text') {
          yield* endToolInput();

          // A subagent's prose travels as a tool-shaped part, not text: nesting it under its card
          // requires an id, and the AI SDK's TextUIPart carries none. Same shape as Thinking above,
          // and settled on arrival because subagent text arrives as whole blocks, never as deltas.
          if (currentParentToolUseId) {
            const proseId = makeCompositeId(genId(), currentParentToolUseId);
            yield {
              type: 'tool-input-available',
              toolCallId: proseId,
              toolName: SUBAGENT_TEXT_TOOL_NAME,
              input: { text: block.text || '' },
              providerExecuted: true,
            };
            yield {
              type: 'tool-output-available',
              toolCallId: proseId,
              output: { completed: true },
            };
            continue;
          }

          // Only emit text if we're NOT already streaming (textStarted = false)
          // When includePartialMessages is true, text comes via stream_event
          if (!textStarted) {
            textId = genId();
            yield { type: 'text-start', id: textId };
            yield { type: 'text-delta', id: textId, delta: block.text || '' };
            yield { type: 'text-end', id: textId };
            // Track the last text ID for final response marking
            lastTextId = textId;
            textId = null;
          }
          // If textStarted is true, we're mid-stream - skip this duplicate
        }

        if (block.type === 'tool_use') {
          yield* endTextBlock();
          yield* endToolInput();

          if (!block.id) {
            continue;
          }

          // Prefer mapped composite ID from streaming (same lifecycle identity),
          // fallback to parent-based synthesis when no mapping exists.
          const compositeId =
            toolIdMapping.get(block.id) || makeCompositeId(block.id, currentParentToolUseId);

          // Skip if already emitted with a fully-parsed input via streaming.
          // If the streaming path only emitted a partial salvage, fall through and
          // let this full block.input supersede it with a second tool-input-available.
          const hadPartial = partialEmissions.has(compositeId) || partialEmissions.has(block.id);
          if (!hadPartial && (emittedToolIds.has(block.id) || emittedToolIds.has(compositeId))) {
            continue;
          }

          emittedToolIds.add(block.id);
          emittedToolIds.add(compositeId);

          // Store mapping for tool-result lookup
          toolIdMapping.set(block.id, compositeId);

          yield {
            type: 'tool-input-available',
            toolCallId: compositeId,
            toolName: block.name || 'unknown',
            input: block.input,
          };
          partialEmissions.delete(compositeId);
          partialEmissions.delete(block.id);
        }
      }
    }

    // ===== USER MESSAGE (tool results) =====
    if (isUserMessage(msg) && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          // The map is cold whenever a wake burst replaced the transformer between the call and its
          // result, so rebuild the composite from this result's own parent instead of falling back
          // to the raw id — which would match no card and leave a nested row pending forever.
          const rawId = block.tool_use_id || '';
          const compositeId =
            toolIdMapping.get(rawId) || makeCompositeId(rawId, currentParentToolUseId);

          if (block.is_error) {
            yield {
              type: 'tool-output-error',
              toolCallId: compositeId,
              errorText: String(block.content),
            };
          } else {
            // Try to parse structured data from block.content if it's JSON
            let output: unknown = msg.tool_use_result;
            if (!output && typeof block.content === 'string') {
              try {
                // Some tool results may have JSON embedded in the string
                const parsed = JSON.parse(block.content);
                if (parsed && typeof parsed === 'object') {
                  output = parsed;
                }
              } catch {
                // Not JSON, use raw content
              }
            }
            output = output || block.content;

            yield {
              type: 'tool-output-available',
              toolCallId: compositeId,
              output,
            };
          }
        }
      }
    }

    // ===== SYSTEM STATUS (compacting, etc.) =====
    if (isSystemMessage(msg)) {
      // Session init - extract MCP servers, plugins, tools
      if (msg.subtype === 'init') {
        // Map MCP servers with validated status type and additional info
        const mcpServers: MCPServer[] = (msg.mcp_servers || []).map(
          (s: {
            name: string;
            status: string;
            serverInfo?: {
              name: string;
              version: string;
              icons?: {
                src: string;
                mimeType?: string;
                sizes?: string[];
                theme?: 'light' | 'dark';
              }[];
            };
            error?: string;
          }) => ({
            name: s.name,
            status: (['connected', 'failed', 'pending', 'needs-auth'].includes(s.status)
              ? s.status
              : 'pending') as MCPServerStatus,
            ...(s.serverInfo && { serverInfo: s.serverInfo }),
            ...(s.error && { error: s.error }),
          }),
        );
        yield {
          type: 'session-init',
          tools: msg.tools || [],
          mcpServers,
          plugins: msg.plugins || [],
          skills: msg.skills || [],
        };
      }

      yield* mapCompaction(msg);
    }

    // ===== RESULT (final) =====
    if (isResultMessage(msg)) {
      yield* endTextBlock();
      yield* endToolInput();

      const inputTokens = msg.usage?.input_tokens;
      const outputTokens = msg.usage?.output_tokens;

      const modelUsage = msg.modelUsage
        ? Object.fromEntries(
            Object.entries(msg.modelUsage).map(([model, usage]) => [
              model,
              {
                inputTokens: usage.inputTokens || 0,
                outputTokens: usage.outputTokens || 0,
                cacheReadInputTokens: usage.cacheReadInputTokens || 0,
                cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
                costUSD: usage.costUSD || 0,
              },
            ]),
          )
        : undefined;

      const metadata: MessageMetadata = {
        sessionId: msg.session_id,
        sdkMessageUuid: msg.uuid,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : undefined,
        totalCostUsd: msg.total_cost_usd,
        durationMs: startTime ? Date.now() - startTime : undefined,
        resultSubtype: msg.subtype || 'success',
        finalTextId: lastTextId || undefined,
        modelUsage,
        ...contextUsage.snapshot(),
      };
      yield { type: 'message-metadata', messageMetadata: metadata };
      yield { type: 'finish-step' };
      yield { type: 'finish', messageMetadata: metadata };
    }
  };
}
