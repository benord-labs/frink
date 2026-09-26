/**
 * Builds the "Using X, Y" summary string for attachment-only messages
 * (no typed text, but has images and/or text mentions).
 * Shared by isolated-message-group and agent-user-message-bubble.
 */
export function formatAttachmentSummaryLabel(
  imageCount: number,
  textMentions: ReadonlyArray<{ type: string }>,
): string {
  const parts: string[] = [];

  if (imageCount > 0) {
    parts.push(imageCount === 1 ? 'image' : `${imageCount} images`);
  }

  const quoteCount = textMentions.filter((m) => m.type === 'quote' || m.type === 'pasted').length;
  // 'diff' (diff-viewer gesture) and 'code' (editor-selection gesture) are both a code
  // selection to the user, so they share one counter and pluralise together.
  const codeCount = textMentions.filter((m) => m.type === 'diff' || m.type === 'code').length;

  if (quoteCount > 0) {
    parts.push(quoteCount === 1 ? 'selected text' : `${quoteCount} text selections`);
  }
  if (codeCount > 0) {
    parts.push(codeCount === 1 ? 'code selection' : `${codeCount} code selections`);
  }

  return parts.length > 0 ? `Using ${parts.join(', ')}` : '';
}
