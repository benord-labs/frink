import type { UIMessage } from 'ai';
import { z } from 'zod';
import { stripHiddenWakeMarker } from '../../../../../shared/lib/message-markers/hidden-wake-marker';
import {
  dispatchMetadataSchema,
  isPersonAuthoredMessage,
} from '../../../../../shared/lib/message-markers/person-authored';
import { stripMessageMarkers } from '../../../../../shared/lib/message-markers/strip-message-markers';
import { NARRATION_PART_TYPES } from '../../../../../shared/subagent-parts';
import type { ConversationTurn } from '../../../../../shared/types/execution';
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

const STEER_PART_TYPE = 'tool-Steer';
const steerInputSchema = z.object({ text: z.string().trim().min(1) });

/** A steer is a person's message the running turn took in, stored inside the assistant message. */
function steerTurn(part: HistoryPart): ConversationTurn[] {
  const input = steerInputSchema.safeParse(part.input);
  return input.success ? [{ role: 'user', content: input.data.text, personAuthored: true }] : [];
}

/** One stored message as replayed turns, flagged when a person wrote them; none when empty. Each
 * steer splits an assistant message and replays as the person's own turn. */
function historyTurn(
  role: 'user' | 'assistant',
  message: UIMessage,
  parts: HistoryPart[],
): ConversationTurn[] {
  const steerAt = role === 'assistant' ? parts.findIndex((p) => p.type === STEER_PART_TYPE) : -1;
  if (steerAt >= 0) {
    return [
      ...historyTurn(role, message, parts.slice(0, steerAt)),
      ...steerTurn(parts[steerAt]),
      ...historyTurn(role, message, parts.slice(steerAt + 1)),
    ];
  }
  const raw = parts.flatMap((part) => partHistoryText(part) ?? []).join('\n');
  const content = stripMessageMarkers(stripHiddenWakeMarker(raw));
  if (!content) return [];
  // Read before the markers go: they are what tell a person's turn from Frink's own. Metadata of
  // an unexpected shape counts as not a person's.
  const metadata = dispatchMetadataSchema.safeParse(message.metadata);
  const person =
    metadata.success && isPersonAuthoredMessage({ role, metadata: metadata.data, text: raw });
  return [person ? { role, content, personAuthored: true as const } : { role, content }];
}

/**
 * The transcript a fresh session is seeded with (every message but the one being sent): text, any
 * plan in full, one line per tool call, and each steer as the person's turn, so a handoff keeps
 * what was planned and done.
 * A compacted chat starts from its newest compaction's summary instead of re-inflating (sc-2281).
 */
export function buildTurnHistory(messages: UIMessage[], current?: UIMessage): ConversationTurn[] {
  const boundary = findCompactBoundary(messages, current);
  const head: ConversationTurn[] = boundary
    ? [
        {
          role: 'user',
          content: `[Earlier conversation was compacted. Summary:]\n\n${boundary.summary}`,
        },
      ]
    : [];
  const tail = messages.slice(boundary?.messageIndex ?? 0).flatMap((m, offset) => {
    const { role } = m;
    if (m === current || (role !== 'user' && role !== 'assistant')) return [];
    const parts = (m.parts ?? []) as HistoryPart[];
    // The boundary's own message keeps only what followed it (an auto-compact mid-turn).
    const kept = boundary && offset === 0 ? parts.slice(boundary.partIndex + 1) : parts;
    return historyTurn(role, m, kept);
  });
  return [...head, ...tail];
}
