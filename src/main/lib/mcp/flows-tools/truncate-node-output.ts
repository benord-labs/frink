/**
 * Truncate node_output.outputs to prevent context overflow when drilling into a specific node.
 *
 * Context: node_output.outputs can be very large:
 * - run_command stores _rawStdout (unbounded)
 * - http_request stores response body (up to 256KB)
 * - custom nodes store arbitrary JSON stdout
 *
 * For string values (e.g. _rawStdout): tail-truncates (keeps last N chars) because
 * the end of stdout is more useful for debugging than the beginning.
 */

const MAX_OUTPUT_BYTES = 8192;

export type TruncatedNodeOutput = {
  outputs: Record<string, unknown>;
  truncated: boolean;
  fullSizeBytes: number;
};

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj) ?? '{}';
  } catch {
    return '{}';
  }
}

export function truncateNodeOutput(
  outputs: Record<string, unknown>,
  maxBytes = MAX_OUTPUT_BYTES,
): TruncatedNodeOutput {
  const fullJson = safeStringify(outputs);
  const fullSizeBytes = byteLength(fullJson);

  if (fullSizeBytes <= maxBytes) {
    return { outputs, truncated: false, fullSizeBytes };
  }

  // Build a truncated version by tail-truncating large string values
  const truncatedOutputs: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value === 'string') {
      const valueBytes = byteLength(value);
      const budget = Math.floor(maxBytes / Math.max(Object.keys(outputs).length, 1));
      if (valueBytes > budget) {
        // Keep last `budget` bytes (rough char approximation for UTF-8 ASCII)
        const keepChars = Math.floor(budget * 0.9);
        const tail = value.slice(-keepChars);
        truncatedOutputs[key] = `[truncated — showing last ${tail.length} chars]\n${tail}`;
      } else {
        truncatedOutputs[key] = value;
      }
    } else {
      truncatedOutputs[key] = value;
    }
  }

  const truncatedJson = safeStringify(truncatedOutputs);
  if (byteLength(truncatedJson) <= maxBytes) {
    return { outputs: truncatedOutputs, truncated: true, fullSizeBytes };
  }

  // Still too large after per-field truncation: return a minimal summary
  return {
    outputs: {
      _truncated: true,
      _message: `Output too large to display (${fullSizeBytes} bytes, max ${maxBytes} bytes). Use the Flows page → Run history to view the full output.`,
    },
    truncated: true,
    fullSizeBytes,
  };
}
