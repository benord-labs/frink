/**
 * NOTE: This file is mirrored between `src/shared/lib/trigger-bubble-marker.ts` and
 * TODO: If serverless build constraints ever allow it, consolidate to a single implementation.
 */
import type { TriggerContext } from '../types/trigger-context';
import { coerceTriggerSummary, type TriggerSummary } from './trigger-summary';

export const TRIGGER_BUBBLE_MARKER = '<!--TRIGGER_BUBBLE:';
const TRIGGER_BUBBLE_END = '-->';

export type TriggerBubbleParseResult = {
  /** Display model; `coerceTriggerSummary` maps legacy chat-history payloads so this is never empty-by-shape. */
  triggerData: TriggerSummary | null;
  triggerContext: TriggerContext | null;
  fullPrompt: string;
};

type TriggerBubbleMarkerPayload = {
  /** A `TriggerSummary` (current) or a legacy `TriggerBubbleData` blob — normalized on parse. */
  uiData: unknown;
  triggerContext?: TriggerContext;
};

export function parseTriggerBubbleMessage(message: string): TriggerBubbleParseResult {
  if (!message.startsWith(TRIGGER_BUBBLE_MARKER)) {
    return { triggerData: null, triggerContext: null, fullPrompt: message };
  }

  const endIndex = message.indexOf(TRIGGER_BUBBLE_END);
  if (endIndex === -1) {
    return { triggerData: null, triggerContext: null, fullPrompt: message };
  }

  try {
    const jsonStr = message.slice(TRIGGER_BUBBLE_MARKER.length, endIndex);
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const payload = isMarkerPayload(parsed) ? parsed : { uiData: parsed };
    const fullPrompt = message.slice(endIndex + TRIGGER_BUBBLE_END.length).trim();
    return {
      triggerData: coerceTriggerSummary(payload.uiData),
      triggerContext: (payload.triggerContext as TriggerContext | undefined) ?? null,
      fullPrompt,
    };
  } catch {
    return { triggerData: null, triggerContext: null, fullPrompt: message };
  }
}

/**
 * Build the marker prefix carrying the display `summary` (+ optional triggerContext). The caller
 * appends the actual prompt body (the rendered task description) after this.
 */
export function buildTriggerBubbleMessage(
  summary: TriggerSummary,
  triggerContext?: TriggerContext,
): string {
  // Escape the delimiter sequence in JSON to prevent premature marker closure;
  // JSON.parse() decodes it back when parsing in the renderer.
  const payload: TriggerBubbleMarkerPayload = { uiData: summary };
  if (triggerContext) {
    payload.triggerContext = triggerContext;
  }
  const jsonData = JSON.stringify(payload).replace(/-->/g, '--\\u003e');
  return `${TRIGGER_BUBBLE_MARKER}${jsonData}${TRIGGER_BUBBLE_END}\n\n`;
}

function isMarkerPayload(value: Record<string, unknown>): value is TriggerBubbleMarkerPayload {
  return typeof value === 'object' && value !== null && 'uiData' in value;
}
