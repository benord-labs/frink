import { z } from 'zod';

/** Line parsing for the transcripts Claude Code and Codex write, one JSON object per line. Pure:
 * reading files and remembering where a read stopped live in `reader.ts`. */

export type UsageProvider = 'claude' | 'codex';

/** One model response's tokens. `inputTokens` is new input only: cache reads and writes are
 * earlier context being sent again, so they are never counted as usage. */
export type UsageRecord = {
  provider: UsageProvider;
  timestampMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The API response this record belongs to when the transcript can repeat it; null when the
   * record is unique by construction. */
  dedupeKey: string | null;
  /** `skill:<name>` / `mcp:<server>` for integrations the user's setup provides. */
  tools: string[];
};

/** Lines without one of these substrings can't affect usage, so they are never JSON-parsed. A
 * quote inside a JSON string value is escaped, so string content never matches by accident. */
export const USAGE_LINE_MARKERS: Record<UsageProvider, string[]> = {
  claude: ['"usage"'],
  codex: ['"session_meta"', '"turn_context"', '"token_count"'],
};

/** Frink's own MCP plumbing, present in every chat: not an integration the user added. */
const INTERNAL_MCP_SERVERS = new Set(['frink_dynamic_chat']);

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7/i;

/** Missing, malformed or negative counts read as 0. */
const tokenCount = z
  .number()
  .catch(0)
  .transform((n) => Math.max(0, n));

const optionalString = z.string().optional().catch(undefined);

const claudeLine = z.object({
  type: z.literal('assistant'),
  timestamp: z.string(),
  requestId: optionalString,
  message: z.object({
    id: optionalString,
    model: z.string().min(1),
    usage: z.object({ input_tokens: tokenCount, output_tokens: tokenCount }),
    content: z.array(z.unknown()).catch([]),
  }),
});

const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  name: z.string(),
  input: z.unknown(),
});
const skillInput = z.object({ skill: z.string().min(1) });

const codexUsage = z.object({
  input_tokens: tokenCount,
  cached_input_tokens: tokenCount,
  output_tokens: tokenCount,
});

const codexLine = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_meta'),
    payload: z.object({
      id: optionalString,
      originator: z.unknown().optional(),
      source: z.unknown().optional(),
    }),
  }),
  z.object({
    type: z.literal('turn_context'),
    payload: z.object({
      model: z.string().min(1).optional().catch(undefined),
      turn_id: optionalString,
    }),
  }),
  z.object({
    type: z.literal('event_msg'),
    timestamp: z.string(),
    payload: z.object({
      type: z.literal('token_count'),
      info: z
        .object({ last_token_usage: codexUsage, total_token_usage: z.unknown().optional() })
        .nullable()
        .catch(null),
    }),
  }),
]);

/** What a Codex rollout's earlier lines established, carried to the next line (and across
 * incremental reads, so it is persisted with the read position). */
export const codexStateSchema = z.object({
  /** The rollout's own id, only when it is a time-ordered UUIDv7 (see `parseCodexLine`). */
  sessionId: z.string().nullable(),
  /** The model of the turn in progress; null before the rollout's own first turn. */
  model: z.string().nullable(),
  /** Fingerprint of the previous token_count event, to count a repeated event once. */
  lastUsage: z.string().nullable(),
});
export type CodexState = z.infer<typeof codexStateSchema>;

export function initialCodexState(): CodexState {
  return { sessionId: null, model: null, lastUsage: null };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timestampOf(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** `skill:<name>` for the Skill tool, `mcp:<server>` for an MCP tool, else null. */
function toolOf(block: unknown): string | null {
  const use = toolUseBlock.safeParse(block);
  if (!use.success) return null;
  const { name, input } = use.data;
  if (name === 'Skill') {
    const skill = skillInput.safeParse(input);
    return skill.success ? `skill:${skill.data.skill}` : null;
  }
  const server = /^mcp__(.+?)__/.exec(name)?.[1];
  return server && !INTERNAL_MCP_SERVERS.has(server) ? `mcp:${server}` : null;
}

/** A Claude Code assistant line. A response spans one line per content block, each repeating its
 * usage: every line is a record (its tools count) and the shared dedupeKey counts tokens once. */
export function parseClaudeLine(line: string): UsageRecord | null {
  const parsed = claudeLine.safeParse(parseJson(line));
  if (!parsed.success) return null;
  const { timestamp, requestId, message } = parsed.data;
  const timestampMs = timestampOf(timestamp);
  if (timestampMs === null) return null;
  const tools = message.content.map(toolOf).filter((tool): tool is string => tool !== null);
  return {
    provider: 'claude',
    timestampMs,
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    dedupeKey: message.id || requestId ? `${message.id ?? ''}:${requestId ?? ''}` : null,
    tools,
  };
}

/** Who started a Codex rollout, judged from its first line. */
export function parseCodexOrigin(firstLine: string): { fromFrink: boolean; subagent: boolean } {
  const parsed = codexLine.safeParse(parseJson(firstLine));
  if (!parsed.success || parsed.data.type !== 'session_meta') {
    return { fromFrink: false, subagent: false };
  }
  const { originator, source } = parsed.data.payload;
  return {
    fromFrink: originator === 'frink',
    subagent: typeof source === 'object' && source !== null && 'subagent' in source,
  };
}

/** One Codex rollout line, updating `state`. `first` marks the file's first line, the only
 * session_meta that describes this rollout. */
export function parseCodexLine(
  line: string,
  state: CodexState,
  first: boolean,
): UsageRecord | null {
  const parsed = codexLine.safeParse(parseJson(line));
  if (!parsed.success) return null;
  const event = parsed.data;
  if (event.type === 'session_meta') {
    const id = event.payload.id;
    if (first && id && UUID_V7.test(id)) state.sessionId = id.toLowerCase();
    return null;
  }
  if (event.type === 'turn_context') {
    const { model, turn_id: turnId } = event.payload;
    // Forks first replay ancestor turns, already counted there. Ids are time-ordered UUIDv7, so a
    // turn older than this rollout is a replay; clearing the model skips its usage.
    const replayed = state.sessionId !== null && !!turnId && turnId.toLowerCase() < state.sessionId;
    if (replayed) state.model = null;
    else if (model) state.model = model;
    return null;
  }
  const info = event.payload.info;
  if (!info) return null;
  // Codex can write the same token_count twice in a row; the cumulative total tells them apart.
  const fingerprint = JSON.stringify(info.total_token_usage ?? info.last_token_usage);
  const repeated = fingerprint === state.lastUsage;
  state.lastUsage = fingerprint;
  const timestampMs = timestampOf(event.timestamp);
  if (repeated || !state.model || timestampMs === null) return null;
  const usage = info.last_token_usage;
  // Codex's input count includes the cached portion.
  const inputTokens = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
  if (inputTokens + usage.output_tokens === 0) return null;
  return {
    provider: 'codex',
    timestampMs,
    model: state.model,
    inputTokens,
    outputTokens: usage.output_tokens,
    dedupeKey: null,
    tools: [],
  };
}
