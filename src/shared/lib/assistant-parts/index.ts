/**
 * Pure assistant chunk -> message-parts reducer shared by Electron main and renderer.
 *
 * Main uses it to build persistence/final snapshots; the observer renderer uses the exact same
 * state machine for delta-only local IPC. Keep provider- and process-specific filtering above this
 * boundary so an ordered chunk sequence always reduces to the same parts in both processes.
 */

export type AssistantPartShape = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  errorText?: string;
  id?: string;
  data?: unknown;
};

export type AssistantPartsState<TPart extends AssistantPartShape = AssistantPartShape> = {
  parts: TPart[];
  toolPartsById: Map<string, TPart>;
  currentText: string;
};

export type AssistantChunkShape = { type: string };

export function createAssistantPartsState<
  TPart extends AssistantPartShape = AssistantPartShape,
>(): AssistantPartsState<TPart> {
  return { parts: [], toolPartsById: new Map<string, TPart>(), currentText: '' };
}

// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- AssistantPartShape is this module's generic bound, declared above and used by every helper here; renaming it is a separate refactor.
function flushOpenText<TPart extends AssistantPartShape>(state: AssistantPartsState<TPart>): void {
  if (!state.currentText) return;
  state.parts.push({ type: 'text', text: state.currentText } as TPart);
  state.currentText = '';
}

function applyToolInput<TPart extends AssistantPartShape>(
  state: AssistantPartsState<TPart>,
  chunk: AssistantChunkShape,
): void {
  const inputChunk = chunk as AssistantChunkShape & {
    toolCallId?: unknown;
    toolName?: unknown;
    input?: unknown;
  };
  if (typeof inputChunk.toolCallId !== 'string' || typeof inputChunk.toolName !== 'string') return;
  // Nested tool parts render inside their parent Agent card and must not split root prose.
  if (!inputChunk.toolCallId.includes(':')) flushOpenText(state);
  const existing = state.toolPartsById.get(inputChunk.toolCallId);
  if (existing) {
    existing.input = inputChunk.input;
    existing.type = `tool-${inputChunk.toolName}`;
    existing.toolName = inputChunk.toolName;
    if (existing.state !== 'output-available' && existing.state !== 'output-error') {
      existing.state = 'input-available';
    }
    return;
  }
  const part = {
    type: `tool-${inputChunk.toolName}`,
    toolName: inputChunk.toolName,
    toolCallId: inputChunk.toolCallId,
    input: inputChunk.input,
    state: 'input-available',
  } as TPart;
  state.parts.push(part);
  state.toolPartsById.set(inputChunk.toolCallId, part);
}

function applyToolOutput<TPart extends AssistantPartShape>(
  state: AssistantPartsState<TPart>,
  chunk: AssistantChunkShape,
): void {
  const outputChunk = chunk as AssistantChunkShape & { toolCallId?: unknown; output?: unknown };
  if (typeof outputChunk.toolCallId !== 'string') return;
  const part = state.toolPartsById.get(outputChunk.toolCallId);
  if (!part) return;
  part.output = outputChunk.output;
  part.state = 'output-available';
}

function applyToolError<TPart extends AssistantPartShape>(
  state: AssistantPartsState<TPart>,
  chunk: AssistantChunkShape,
): void {
  const errorChunk = chunk as AssistantChunkShape & {
    toolCallId?: unknown;
    errorText?: unknown;
    permissionDenied?: unknown;
  };
  if (typeof errorChunk.toolCallId !== 'string') return;
  const part = state.toolPartsById.get(errorChunk.toolCallId);
  if (!part) return;
  if (typeof errorChunk.errorText === 'string') part.errorText = errorChunk.errorText;
  part.state = 'output-error';
  if (errorChunk.permissionDenied === true) {
    part.output = { permissionDenied: true, error: errorChunk.errorText };
  }
}

function applyQuestionResult<TPart extends AssistantPartShape>(
  state: AssistantPartsState<TPart>,
  chunk: AssistantChunkShape,
): void {
  const resultChunk = chunk as AssistantChunkShape & { toolUseId?: unknown; result?: unknown };
  if (typeof resultChunk.toolUseId !== 'string') return;
  const part = state.toolPartsById.get(resultChunk.toolUseId);
  if (!part) return;
  part.result = resultChunk.result;
  part.state = 'output-available';
}

/**
 * Compaction is a single part that settles in place, keyed by `id` — the same upsert the AI SDK
 * performs for a `data-` chunk on the renderer side, so the live and persisted transcripts agree.
 *
 * Folded here rather than left to the renderer alone because this reducer builds what gets SAVED:
 * without it the card would exist only until the window reloads, and a compacted chat would look
 * untouched on the next open.
 */
function applyCompaction(
  state: AssistantPartsState,
  chunk: { type: string; id?: string; transient?: boolean; data?: unknown },
): void {
  // Mirrors the SDK, which fires listeners for a transient data chunk but keeps no part for it.
  if (!chunk.id || chunk.transient) return;
  const existing = state.parts.find((part) => part.type === 'data-compact' && part.id === chunk.id);
  if (existing) {
    existing.data = chunk.data;
    return;
  }
  flushOpenText(state);
  state.parts.push({ type: 'data-compact', id: chunk.id, data: chunk.data });
}

/** Mutates one fresh-per-stream state in O(1) for the hot streaming path. */
export function applyAssistantChunkToParts<TPart extends AssistantPartShape>(
  state: AssistantPartsState<TPart>,
  chunk: AssistantChunkShape,
): void {
  switch (chunk.type) {
    case 'start-step':
      flushOpenText(state);
      state.parts.push({ type: 'step-start' } as TPart);
      break;
    case 'text-start':
    case 'text-end':
      flushOpenText(state);
      break;
    case 'text-delta': {
      const delta = (chunk as AssistantChunkShape & { delta?: unknown }).delta;
      if (typeof delta === 'string') state.currentText += delta;
      break;
    }
    case 'tool-input-available':
      applyToolInput(state, chunk);
      break;
    case 'tool-output-available':
      applyToolOutput(state, chunk);
      break;
    case 'tool-output-error':
      applyToolError(state, chunk);
      break;
    case 'ask-user-question-result':
      applyQuestionResult(state, chunk);
      break;
    case 'data-compact':
      applyCompaction(state, chunk);
      break;
  }
}

export function assistantPartsStateFromChunks<TPart extends AssistantPartShape>(
  chunks: AssistantChunkShape[],
): AssistantPartsState<TPart> {
  const state = createAssistantPartsState<TPart>();
  for (const chunk of chunks) applyAssistantChunkToParts(state, chunk);
  flushOpenText(state);
  return state;
}

/** Restore a seed and preserve whether its trailing text run was still open. */
export function assistantPartsStateFromSnapshot<TPart extends AssistantPartShape>(
  parts: TPart[],
  textOpen: boolean,
): AssistantPartsState<TPart> {
  const state = createAssistantPartsState<TPart>();
  state.parts = [...parts];
  if (textOpen) {
    const last = state.parts.at(-1);
    if (last?.type === 'text' && typeof last.text === 'string') {
      state.currentText = last.text;
      state.parts.pop();
    }
  }
  for (const part of state.parts) {
    if (typeof part.toolCallId === 'string') state.toolPartsById.set(part.toolCallId, part);
  }
  return state;
}

export function assistantPartsSnapshot<TPart extends AssistantPartShape>(
  state: AssistantPartsState<TPart>,
): TPart[] {
  return state.currentText
    ? [...state.parts, { type: 'text', text: state.currentText } as TPart]
    : state.parts;
}
