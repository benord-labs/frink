/**
 * Shared trailing-part walk for the clean-stream classifiers. A turn that ends BECAUSE of a
 * usage limit or an API error puts that text in the final assistant text part; the same phrase
 * appearing earlier in the turn (or inside a tool result) is just the agent talking about it.
 * Anchoring on the trailing part is what separates the two.
 */

export type FinalPartLike = { type: string; text?: string };

/**
 * Text of the FINAL meaningful part, or null when the message ends on anything else — a tool
 * call, an empty parts list, or a non-text part. `step-start` and `reasoning` are skipped: they
 * routinely trail a turn without being its content.
 */
export function trailingTextPart(parts: ReadonlyArray<FinalPartLike>): string | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === 'step-start' || part.type === 'reasoning') continue;
    return part.type === 'text' && typeof part.text === 'string' ? part.text : null;
  }
  return null;
}
