/**
 * Unwrap MCP tool output from the wrappers Claude Code SDK / transform.ts can
 * produce. MCP tool results arrive as a content-block array
 * `[{ type: 'text', text: JSON_STRING }]`. After `JSON.parse` round-tripping
 * the array sometimes surfaces as an indexed object `{ '0': { type, text } }`.
 * Both shapes resolve to the parsed JSON payload here.
 */
const MAX_MCP_CONTENT_BLOCKS = 64;
const MAX_MCP_TEXT_LENGTH = 1_000_000;
const MAX_MCP_UNWRAP_DEPTH = 4;
const UNHANDLED_MCP_OUTPUT = Symbol('unhandled-mcp-output');

type ObjectRecord = Record<string, unknown>;
type UnwrapAttempt = unknown | typeof UNHANDLED_MCP_OUTPUT;
type RecordUnwrapper = (record: ObjectRecord, depth: number) => UnwrapAttempt;

const MCP_RECORD_UNWRAPPERS: RecordUnwrapper[] = [
  unwrapStructuredContentEnvelope,
  unwrapContentEnvelope,
  unwrapSingleTextBlock,
  unwrapIndexedContentBlocks,
];

export function unwrapMcpOutput(output: unknown): unknown {
  return unwrapMcpOutputAtDepth(output, 0);
}

function unwrapMcpOutputAtDepth(output: unknown, depth: number): unknown {
  if (output === undefined || output === null) return output;
  if (depth > MAX_MCP_UNWRAP_DEPTH) return output;

  if (Array.isArray(output)) return unwrapContentBlocksOrOriginal(output);
  if (typeof output === 'string') return tryParseJson(output);
  const record = asRecord(output);
  if (record) return unwrapMcpRecord(record, depth);

  return output;
}

function unwrapContentBlocksOrOriginal(blocks: unknown[]): unknown {
  const unwrapped = unwrapContentBlocks(blocks);
  return unwrapped === UNHANDLED_MCP_OUTPUT ? blocks : unwrapped;
}

function unwrapMcpRecord(record: ObjectRecord, depth: number): unknown {
  for (const unwrapRecord of MCP_RECORD_UNWRAPPERS) {
    const unwrapped = unwrapRecord(record, depth);
    if (unwrapped !== UNHANDLED_MCP_OUTPUT) return unwrapped;
  }
  return record;
}

/** Standard MCP CallToolResult envelope used by the Codex app-server. */
function unwrapStructuredContentEnvelope(record: ObjectRecord): UnwrapAttempt {
  const structuredContent = asRecord(record.structuredContent);
  return structuredContent && Object.keys(structuredContent).length > 0
    ? structuredContent
    : UNHANDLED_MCP_OUTPUT;
}

function unwrapContentEnvelope(record: ObjectRecord): UnwrapAttempt {
  return unwrapContentBlocks(record.content);
}

function unwrapSingleTextBlock(record: ObjectRecord): UnwrapAttempt {
  const text = directContentBlockText(record);
  return text === undefined ? UNHANDLED_MCP_OUTPUT : tryParseJson(text);
}

function unwrapIndexedContentBlocks(record: ObjectRecord): UnwrapAttempt {
  return '0' in record ? unwrapContentBlocks(Object.values(record)) : UNHANDLED_MCP_OUTPUT;
}

function unwrapContentBlocks(value: unknown): UnwrapAttempt {
  if (!Array.isArray(value)) return UNHANDLED_MCP_OUTPUT;
  const text = collectContentBlockText(value);
  return text === null ? UNHANDLED_MCP_OUTPUT : tryParseJson(text);
}

function collectContentBlockText(blocks: unknown[]): string | null {
  const parts: string[] = [];
  let remaining = MAX_MCP_TEXT_LENGTH;
  for (const block of blocks.slice(0, MAX_MCP_CONTENT_BLOCKS)) {
    const text = contentBlockText(block);
    if (text === undefined) continue;
    if (remaining <= 0) break;
    const boundedText = text.slice(0, remaining);
    parts.push(boundedText);
    remaining -= boundedText.length;
  }
  return parts.length > 0 ? parts.join('') : null;
}

function contentBlockText(value: unknown): string | undefined {
  const record = asObjectRecord(value);
  return record
    ? (directContentBlockText(record) ?? nestedContentBlockText(record.text))
    : undefined;
}

function directContentBlockText(record: ObjectRecord): string | undefined {
  return record.type === 'text' && typeof record.text === 'string' ? record.text : undefined;
}

function nestedContentBlockText(value: unknown): string | undefined {
  const record = asRecord(value);
  return record && typeof record.text === 'string' ? record.text : undefined;
}

function asObjectRecord(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as ObjectRecord) : undefined;
}

function asRecord(value: unknown): ObjectRecord | undefined {
  const record = asObjectRecord(value);
  return record && !Array.isArray(value) ? record : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Absolute POSIX, Windows drive or Windows UNC path of the file the CLI wrote the result to. */
const SAVED_FILE = String.raw`(?:\/|[A-Za-z]:[\\/]|\\\\[^\\\s][^\\\n]*\\[^\\\n]+\\)\S`;

/**
 * Whole-note shape the Claude CLI leaves in place of a result above its token cap: its prefix,
 * a saved-file path, and the clause the CLI always writes after that path.
 */
const SPILL_MARKERS: readonly RegExp[] = [
  new RegExp(
    String.raw`^Error: result \([^)]*\) exceeds maximum allowed tokens\. Output has been saved to ${SAVED_FILE}[^\n]*?\. Format: `,
  ),
  new RegExp(
    String.raw`^(?:<persisted-output>\s*)?Output too large \([^)]*\)\. Full output saved to:\s*${SAVED_FILE}[^\n]*\n\s*Preview \(`,
  ),
];

export function isSpilledToolResultText(text: string): boolean {
  const note = text.trimStart();
  return SPILL_MARKERS.some((marker) => marker.test(note));
}
