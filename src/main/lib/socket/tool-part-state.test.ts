import type { ToolUIPart } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ToolPartState } from '../../../shared/types/assistant-message';
import type { UIMessageChunk } from '../claude/types';
import { buildPartsFromChunks } from './claude-turn-context';

/** Pins that applyChunkToParts and the AI SDK's own reducer agree on the tool-part vocabulary. */

/** Compile-time: an SDK upgrade that renames or drops a state frink writes stops the build here. */
type WriterVocabularyIsSdkSubset = ToolPartState extends ToolUIPart['state'] ? true : never;
const _writerVocabularyIsSdkSubset: WriterVocabularyIsSdkSubset = true;

/**
 * The SDK's tool states, listed as values because the union exists only at type level. The
 * `satisfies` clause is what keeps this list honest — a member the SDK does not define fails tsc.
 */
const SDK_TOOL_STATES = [
  'input-streaming',
  'input-available',
  'approval-requested',
  'approval-responded',
  'output-available',
  'output-error',
  'output-denied',
] as const satisfies readonly ToolUIPart['state'][];

function toolInput(toolCallId: string, toolName: string): UIMessageChunk {
  return { type: 'tool-input-available', toolCallId, toolName, input: {} } as UIMessageChunk;
}

describe('applyChunkToParts tool-part state vocabulary', () => {
  it('reports a completed tool in the AI SDK vocabulary, not a renamed one', () => {
    const parts = buildPartsFromChunks([
      toolInput('call-1', 'Bash'),
      { type: 'tool-output-available', toolCallId: 'call-1', output: { stdout: 'ok' } },
    ] as UIMessageChunk[]);

    expect(parts[0]?.state).toBe('output-available');
  });

  it('reports a failed tool in the AI SDK vocabulary', () => {
    const parts = buildPartsFromChunks([
      toolInput('call-1', 'Bash'),
      { type: 'tool-output-error', toolCallId: 'call-1', errorText: 'boom' },
    ] as UIMessageChunk[]);

    expect(parts[0]?.state).toBe('output-error');
  });

  it('leaves a tool awaiting its output in a non-terminal state', () => {
    const parts = buildPartsFromChunks([toolInput('call-1', 'Read')] as UIMessageChunk[]);

    expect(parts[0]?.state).toBe('input-available');
  });

  it('never emits a state the installed SDK does not define', () => {
    // Every branch of the reducer that writes a state, folded in one pass.
    const parts = buildPartsFromChunks([
      toolInput('done', 'Bash'),
      { type: 'tool-output-available', toolCallId: 'done', output: { stdout: 'ok' } },
      toolInput('failed', 'Bash'),
      { type: 'tool-output-error', toolCallId: 'failed', errorText: 'boom' },
      toolInput('unfinished', 'Read'),
      toolInput('unfinished', 'Read'), // replayed input must not invent a state either
      toolInput('asked', 'AskUserQuestion'),
      { type: 'ask-user-question-result', toolUseId: 'asked', result: 'Skipped' },
    ] as UIMessageChunk[]);

    const written = parts.filter((p) => p.toolCallId).map((p) => p.state);
    expect(written.length).toBeGreaterThan(0);
    for (const state of written) {
      expect(SDK_TOOL_STATES).toContain(state);
    }
  });

  it('keeps a question closed-reason on `result`, which has no `output` to carry a bare string', () => {
    // `output` is typed as a record; the closed-reason payload is a plain string, so it rides
    // `result` instead. Dropping that field would blank the "Skipped"/"Timed out" line on reload.
    const parts = buildPartsFromChunks([
      toolInput('asked', 'AskUserQuestion'),
      { type: 'ask-user-question-result', toolUseId: 'asked', result: 'Skipped' },
    ] as UIMessageChunk[]);

    expect(parts[0]).toMatchObject({ state: 'output-available', result: 'Skipped' });
    expect(parts[0]?.output).toBeUndefined();
  });

  it('does not duplicate `output` into `result` for ordinary tools', () => {
    // The mirror was ~44% of the persisted transcript corpus and no reader needed it.
    const parts = buildPartsFromChunks([
      toolInput('call-1', 'Bash'),
      { type: 'tool-output-available', toolCallId: 'call-1', output: { stdout: 'ok' } },
    ] as UIMessageChunk[]);

    expect(parts[0]?.output).toEqual({ stdout: 'ok' });
    expect(parts[0]?.result).toBeUndefined();
  });
});
