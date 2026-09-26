/**
 * Collapse boundary for an assistant message, latched monotonically per message id.
 *
 * A wake burst appends to the SAME message, and its first tool part flips the text-after-tools
 * anchor false — without the latch the settled wait re-expands (and scroll-jumps) once per burst.
 * The high-water mark is read during render but only WRITTEN in an effect: React may replay or
 * discard render work, and a boundary persisted from a discarded render could collapse content
 * that never committed.
 *
 * Generic over the part shape so it depends on no feature-internal types.
 */
import { useEffect, useMemo, useRef } from 'react';

type CollapsiblePart = { type?: string; text?: string; toolCallId?: string };

/** Last text-after-tools index, or -1 while the message has no settled trailing text. */
function findFinalTextIndex(parts: readonly CollapsiblePart[]): number {
  let lastToolIndex = -1;
  let lastTextIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // A nested part (composite "parent:child" id) renders inside a subagent card, never in the
    // timeline, so it must not move the anchor: a subagent still working after the root answered
    // would otherwise hold the whole turn open, un-collapsed, until it finished.
    if (part.toolCallId?.includes(':')) continue;
    if (part.type?.startsWith('tool-')) lastToolIndex = i;
    if (part.type === 'text' && part.text?.trim()) lastTextIndex = i;
  }
  return lastToolIndex !== -1 && lastTextIndex > lastToolIndex ? lastTextIndex : -1;
}

export function useCollapseBoundary<P extends CollapsiblePart>(params: {
  messageId: string | undefined;
  parts: P[];
  /** Debounced streaming flag — collapse only once the turn is actually over. */
  stableIsStreaming: boolean;
  isLastMessage: boolean;
  /** Parts the collapse must never hide; rendered above the bar instead. Must be identity-stable. */
  isHoisted: (part: P) => boolean;
}): {
  shouldCollapse: boolean;
  collapseBeforeIndex: number;
  hoistedEntries: { index: number; part: P }[];
  collapsedStepParts: P[];
} {
  const { messageId, parts, stableIsStreaming, isLastMessage, isHoisted } = params;
  const highWaterRef = useRef({ msgId: messageId, index: -1 });

  const { shouldCollapse, collapseBeforeIndex } = useMemo(() => {
    const finalTextIndex = findFinalTextIndex(parts);
    const hasFinalText = finalTextIndex !== -1 && (!stableIsStreaming || !isLastMessage);
    // The latch counts only for the SAME message; a recycled component reading another message
    // starts fresh even before the effect below has run.
    const latched = highWaterRef.current.msgId === messageId ? highWaterRef.current.index : -1;
    const collapseBeforeIndex = Math.min(
      Math.max(hasFinalText ? finalTextIndex : -1, latched),
      parts.length - 1,
    );
    return { shouldCollapse: collapseBeforeIndex !== -1, collapseBeforeIndex };
  }, [parts, stableIsStreaming, isLastMessage, messageId]);

  useEffect(() => {
    highWaterRef.current = { msgId: messageId, index: collapseBeforeIndex };
  }, [messageId, collapseBeforeIndex]);

  /** Split the collapsed region: parts the bar hides vs parts hoisted above it (never hidden). */
  const { hoistedEntries, collapsedStepParts } = useMemo(() => {
    const hoisted: { index: number; part: P }[] = [];
    const steps: P[] = [];
    if (shouldCollapse && collapseBeforeIndex !== -1) {
      for (let i = 0; i < collapseBeforeIndex; i++) {
        const p = parts[i];
        if (isHoisted(p)) hoisted.push({ index: i, part: p });
        else steps.push(p);
      }
    }
    return { hoistedEntries: hoisted, collapsedStepParts: steps };
  }, [shouldCollapse, collapseBeforeIndex, parts, isHoisted]);

  return { shouldCollapse, collapseBeforeIndex, hoistedEntries, collapsedStepParts };
}
