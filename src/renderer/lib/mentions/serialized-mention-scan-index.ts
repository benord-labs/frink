/**
 * Shared index math for serialized `@[id]` mention tokens (see agents-mentions-editor `buildMentionsInto`).
 */

import { MENTION_TOKEN_PATTERN_SRC } from '../../../shared/lib/mentions/mention-grammar';

/** Exclusive end offset in `serialized` for one `RegExpExecArray` mention match. */
export function serializedMentionMatchEndIndex(match: RegExpExecArray): number {
  return (match.index ?? 0) + (match[0]?.length ?? 0);
}

/**
 * Character offset in `serialized` immediately after the last `@[...]` token.
 * Mirrors the mention scan loop that advances with `currentMatch` (not the next `exec` result).
 */
export function getSerializedMentionScanLastIndex(serialized: string): number {
  const re = new RegExp(MENTION_TOKEN_PATTERN_SRC, 'g');
  re.lastIndex = 0;
  let lastIndex = 0;
  let match = re.exec(serialized);
  while (match !== null) {
    const currentMatch = match;
    match = re.exec(serialized);
    lastIndex = serializedMentionMatchEndIndex(currentMatch);
  }
  return lastIndex;
}
