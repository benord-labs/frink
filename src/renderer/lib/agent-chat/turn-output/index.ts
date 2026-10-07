type TurnPart = { type: string; text?: string };

/**
 * Whether a failed turn holds any model output (non-blank text or reasoning, or a tool call), so
 * its session received the prompt and can be continued; otherwise the turn must be retried.
 */
export function hasTurnOutput(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<TurnPart> } | null | undefined>,
): boolean {
  return messages.some((message) => message?.parts?.some(isOutputPart));
}

function isOutputPart(part: TurnPart): boolean {
  // A reasoning part opens empty before its first delta, so a blank one is not output yet.
  if (part.type === 'text' || part.type === 'reasoning') return Boolean(part.text?.trim());
  // Any tool part: `tool-<name>`, the persisted legacy `tool-invocation`, or `dynamic-tool`.
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}
