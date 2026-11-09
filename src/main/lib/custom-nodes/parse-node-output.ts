/**
 * Shared output parsing utilities for custom node scripts.
 *
 * Used by:
 * - flow-step-executor.ts (actual flow execution)
 * - frink_register_node test param (isolated script testing via MCP)
 */

/** Skip JSON.parse for stdout exceeding 1MB (performance guard). */
export const MAX_STDOUT_PARSE_BYTES = 1_048_576;

/** Truncated _rawStdout fallback when JSON.parse fails. */
export const MAX_RAW_FALLBACK_BYTES = 4096;

/** Max stderr chars surfaced in the MCP test result (enough for agent debugging). */
const MAX_TEST_STDERR_CHARS = 1000;

/**
 * Max serialized chars for parsedOutput in the MCP test result.
 * Prevents large script outputs (e.g. hundreds of PRs) from injecting thousands
 * of tokens into the agent context on every test iteration (sc-584 context bloat).
 */
export const MAX_PARSED_OUTPUT_CHARS = 8192;

/**
 * Attempt to parse stdout as a JSON object.
 * Returns the parsed object or null if stdout is not a valid plain JSON object.
 *
 * Rules (must stay aligned with signal-bridge.ts parseStructuredStdout):
 * - Skip if stdout exceeds MAX_STDOUT_PARSE_BYTES (performance guard)
 * - Must be a non-null plain object (not array, not primitive)
 * - Returns null for any parse failure
 */
export function parseStructuredStdout(stdout: string): Record<string, unknown> | null {
  if (stdout.length === 0 || stdout.length > MAX_STDOUT_PARSE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

type NodeTestResult = {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnMessage?: string;
  stdout: string;
  stderr: string;
  parsedOutput: Record<string, unknown> | null;
  durationMs: number;
  warning: string;
};

/**
 * Build the testResult payload for the frink_register_node test param response.
 * Applies the same stdout parsing as flow-step-executor.ts, with size-capped output.
 */
export function buildTestResult(
  result: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut?: boolean;
    cancelled?: boolean;
    spawnMessage?: string;
  },
  durationMs: number,
): NodeTestResult {
  const parsed = parseStructuredStdout(result.stdout);
  const parsedStr = parsed !== null ? JSON.stringify(parsed) : null;
  const parsedOutput =
    parsedStr !== null && parsedStr.length <= MAX_PARSED_OUTPUT_CHARS ? parsed : null;
  const isTruncated = parsed !== null && parsedOutput === null;

  const baseWarning =
    'Staged tests and Flow runs use the same bundled Node.js execution path. Tests use real credentials and may make external changes.';
  const warning = isTruncated
    ? `${baseWarning} parsedOutput omitted — serialized output exceeds ${MAX_PARSED_OUTPUT_CHARS} chars; inspect stdout directly.`
    : baseWarning;

  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    cancelled: result.cancelled ?? false,
    ...(result.spawnMessage ? { spawnMessage: result.spawnMessage } : {}),
    stdout: result.stdout.slice(0, MAX_RAW_FALLBACK_BYTES),
    stderr: result.stderr.slice(0, MAX_TEST_STDERR_CHARS),
    parsedOutput,
    durationMs,
    warning,
  };
}

// `KeyError: 'x'`, `Error [ERR_X]: …`, `fatal: …`, `error[E0425]: …`: the keyword followed by a colon.
const CAUSE_LINE = /(error|exception|fatal)\b(\s*\[[^\]]*\])?:/i;
const PYTHON_TRACEBACK_HEADER = 'Traceback (most recent call last):';
const BARE_PYTHON_EXCEPTION = /^[\w.]*(Error|Exception)$/; // `raise ValueError` prints just `ValueError`

const isCause = (line: string) => CAUSE_LINE.test(line) && !line.startsWith('at ');

const indentOf = (line: string) => line.length - line.trimStart().length;
const lastCause = (lines: string[]) => [...lines].reverse().find(isCause);

/** Python prints the exception at its traceback header's margin, below the deeper-indented frames. */
function findCause(rawLines: string[]): string | undefined {
  const trimmed = rawLines.map((line) => line.trim());
  const header = trimmed.lastIndexOf(PYTHON_TRACEBACK_HEADER);
  if (header < 0) return lastCause(trimmed);
  const margin = indentOf(rawLines[header]);
  const atMargin = rawLines
    .slice(header + 1)
    .filter((line) => indentOf(line) <= margin)
    .map((line) => line.trim());
  const pythonCause = (line: string) => isCause(line) || BARE_PYTHON_EXCEPTION.test(line);
  if (atMargin.length === 0) {
    // A nested exception group draws its exceptions inside a `|` box; a cut-off traceback has none.
    const boxed = trimmed
      .slice(header + 1)
      .filter((line) => line.startsWith('|'))
      .map((line) => line.slice(1).trim());
    return [...boxed].reverse().find(pythonCause);
  }
  return [...atMargin].reverse().find(pythonCause) ?? atMargin.at(-1);
}

/** One-line stderr summary: the cause line first, then the first line as context; else the first line. */
export function summarizeStderr(stderr: string): string {
  const rawLines = stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const first = rawLines[0]?.trim() ?? '';
  if (rawLines.length <= 1) return first;

  const cause = findCause(rawLines) ?? first;
  if (cause === first || first === PYTHON_TRACEBACK_HEADER) return cause;
  return `${cause} — ${first}`;
}
