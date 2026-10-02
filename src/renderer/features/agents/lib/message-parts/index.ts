import type { UIMessage } from 'ai';
import { stripMessageMarkers } from '../../../../../shared/lib/message-markers/strip-message-markers';
import { NARRATION_PART_TYPES } from '../../../../../shared/subagent-parts';
import { isFrinkPlanMessagePartType, stripPlanFrontmatter } from '../../../../../shared/types/plan';

/**
 * Extract text content from a UIMessage
 */
export function extractText(message: UIMessage | undefined): string {
  if (!message) return '';

  const parts = message.parts || [];
  const textParts = parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text);

  return textParts.join('\n');
}

/** Image payload for building message parts (base64 + MIME type) */
export type ExtractedImage = {
  data: string;
  mimeType: string;
  filename?: string;
};

/** An image part ready for the userMessage — inline base64 */
export type ResolvedImagePart = {
  mimeType: string;
  data: string;
};

/**
 * Extract base64 images from a UIMessage.
 * Handles both SDK-style parts (type 'file' with mimeType + data) and UI-style
 * parts (type 'data-image' with data.base64Data + data.mediaType) so images
 * are sent to the agent and persisted to Neon.
 */
export function extractImages(message: UIMessage | undefined): ExtractedImage[] {
  if (!message) return [];

  const parts = message.parts || [];
  const images: ExtractedImage[] = [];

  for (const part of parts) {
    if (part.type === 'file' && 'mimeType' in part && 'data' in part) {
      const mimeType = part.mimeType as string;
      const data = part.data as string;
      if (mimeType?.startsWith('image/') && data) {
        images.push({ data, mimeType });
      }
    } else if (part.type === 'data-image' && part.data && typeof part.data === 'object') {
      const d = part.data as { base64Data?: string; mediaType?: string; filename?: string };
      const data = d.base64Data;
      const mimeType = d.mediaType || 'image/png';
      if (data && mimeType.startsWith('image/')) {
        images.push({ data, mimeType, filename: d.filename });
      }
    }
  }

  return images;
}

/** Display src for a persisted `data-image` part: its `url` is a session-scoped `blob:` URL (dead
 * after reload, empty for task dispatches), so the always-persisted inline base64 wins. */
export function dataImageSrc(
  data: { url?: string; base64Data?: string; mediaType?: string } | undefined,
): string {
  if (data?.base64Data) return `data:${data.mediaType || 'image/png'};base64,${data.base64Data}`;
  return data?.url || '';
}

type HistoryTurn = { role: 'user' | 'assistant'; content: string };
type ToolPartLike = { type: string; input?: unknown };

const TOOL_PART_PREFIX = 'tool-';
const TOOL_HINT_MAX_CHARS = 80;

/** A tool call as one line: its name and the first line of its first string input. */
function toolTrailLine(part: ToolPartLike): string {
  const values = part.input && typeof part.input === 'object' ? Object.values(part.input) : [];
  const hint = values.find((v): v is string => typeof v === 'string')?.split('\n')[0];
  const name = part.type.slice(TOOL_PART_PREFIX.length);
  return hint ? `[${name}] ${hint.slice(0, TOOL_HINT_MAX_CHARS)}` : `[${name}]`;
}

function partHistoryText(part: ToolPartLike & { text?: string }): string | null {
  if (part.type === 'text') return part.text ?? null;
  if (NARRATION_PART_TYPES.has(part.type)) return null;
  if (isFrinkPlanMessagePartType(part.type)) {
    const planText = (part.input as { planText?: unknown } | undefined)?.planText;
    return typeof planText === 'string'
      ? `<plan>\n${stripPlanFrontmatter(planText)}\n</plan>`
      : null;
  }
  return part.type.startsWith(TOOL_PART_PREFIX) ? toolTrailLine(part) : null;
}

type HistoryPart = ToolPartLike & { text?: string; data?: unknown };
type CompactData = { state?: string; summary?: unknown; partial?: boolean } | undefined;

/** The newest settled, summarised, non-partial compaction; null keeps the history whole. */
function findCompactBoundary(messages: UIMessage[], current?: UIMessage) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] === current) continue;
    const parts = (messages[i].parts ?? []) as HistoryPart[];
    for (let j = parts.length - 1; j >= 0; j--) {
      const data = parts[j].data as CompactData;
      if (parts[j].type !== 'data-compact' || data?.state !== 'output-available') continue;
      if (typeof data.summary === 'string' && data.summary.trim() && !data.partial) {
        return { messageIndex: i, partIndex: j, summary: data.summary };
      }
    }
  }
  return null;
}

/**
 * The transcript a fresh session is seeded with (every message but the one being sent): text, any
 * plan in full, and one line per tool call, so a handoff keeps what was planned and done.
 * A compacted chat starts from its newest compaction's summary instead of re-inflating (sc-2281).
 */
export function buildTurnHistory(messages: UIMessage[], current?: UIMessage): HistoryTurn[] {
  const boundary = findCompactBoundary(messages, current);
  const head: HistoryTurn[] = boundary
    ? [
        {
          role: 'user',
          content: `[Earlier conversation was compacted. Summary:]\n\n${boundary.summary}`,
        },
      ]
    : [];
  const tail = messages.slice(boundary?.messageIndex ?? 0).flatMap((m, offset) => {
    if (m === current || (m.role !== 'user' && m.role !== 'assistant')) return [];
    const parts = (m.parts ?? []) as HistoryPart[];
    // The boundary's own message keeps only what followed it (an auto-compact mid-turn).
    const kept = boundary && offset === 0 ? parts.slice(boundary.partIndex + 1) : parts;
    const content = stripMessageMarkers(
      kept.flatMap((part) => partHistoryText(part) ?? []).join('\n'),
    );
    return content ? [{ role: m.role, content }] : [];
  });
  return [...head, ...tail];
}
