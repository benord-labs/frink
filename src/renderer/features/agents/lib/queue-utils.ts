/**
 * Queue utilities for managing message queue in agents chat
 * Adapted from canvas chat queue implementation
 */

import type { ApprovedPlanContext } from '../../../../shared/types/plan';
import type { UploadedFile, UploadedImage } from '../hooks/use-agents-file-upload';

type QueuedImage = {
  id: string;
  url: string;
  mediaType: string;
  filename?: string;
  base64Data?: string;
};

type QueuedFile = {
  id: string;
  url: string;
  filename: string;
  mediaType?: string;
  size?: number;
};

// Text context selected from assistant messages
export type SelectedTextContext = {
  id: string;
  text: string;
  sourceMessageId: string;
  preview: string; // Truncated for display (~50 chars)
  createdAt: Date;
};

type QueuedTextContext = {
  id: string;
  text: string;
  sourceMessageId: string;
};

// Text context selected from diff sidebar
export type DiffTextContext = {
  id: string;
  text: string;
  filePath: string;
  lineNumber?: number;
  lineType?: 'old' | 'new';
  preview: string; // Truncated for display
  createdAt: Date;
};

type QueuedDiffTextContext = {
  id: string;
  text: string;
  filePath: string;
  lineNumber?: number;
  lineType?: 'old' | 'new';
};

// Code selection context from Monaco editor
export type CodeSelectionContext = {
  id: string;
  text: string;
  filePath: string;
  fileName: string;
  language: string;
  startLine: number;
  endLine: number;
  preview: string; // Truncated for display
  createdAt: Date;
};

// Large paste saved to the session's pasted/ dir; drained as a `pasted:` mention.
type QueuedPastedText = {
  id: string;
  filePath: string;
  filename: string;
  size: number;
  preview: string;
};

type QueuedCodeSelectionContext = {
  id: string;
  text: string;
  filePath: string;
  fileName: string;
  language: string;
  startLine: number;
  endLine: number;
};

/**
 * Marks prompts enqueued by the flow/task pipeline rather than typed by the user. Carried into the
 * outgoing UIMessage `metadata` so the send path can tell a flow-dispatched node prompt from a
 * manual chat reply (a manual reply to a parked flow plan means approve-then-execute; a flow
 * prompt never does — see decision `flow-agent-node-mode`).
 */
export const FLOW_DISPATCH_SOURCE = 'flow-dispatch' as const;

export type AgentQueueItem = {
  id: string;
  message: string; // Serialized value with @[id] tokens for mentions
  images?: QueuedImage[];
  files?: QueuedFile[];
  textContexts?: QueuedTextContext[];
  diffTextContexts?: QueuedDiffTextContext[];
  codeSelectionContexts?: QueuedCodeSelectionContext[];
  pastedTexts?: QueuedPastedText[];
  timestamp: Date;
  status: 'pending' | 'processing';
  source?: typeof FLOW_DISPATCH_SOURCE;
  /** Task id of the machine dispatch that enqueued this prompt — rides metadata → send payload
   * so main binds the turn's mode to the dispatching task (`sub-chat-mode-ownership`). */
  dispatchTaskId?: string;
  /** Internal Work Queue recovery turn. Queue UI must not expose user mutation controls for it. */
  approvedPlanContext?: ApprovedPlanContext;
  /** Queued only because main was finalizing a turn whose stream had closed: it goes out the
   * moment main settles, without the spacing between queued turns. */
  sendOnSettle?: true;
};

export function isInternalQueueItem(item: AgentQueueItem | undefined): boolean {
  return item?.approvedPlanContext !== undefined;
}

export function generateQueueId(): string {
  return `queue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function createQueueItem(
  id: string,
  message: string,
  images?: QueuedImage[],
  files?: QueuedFile[],
  textContexts?: QueuedTextContext[],
  diffTextContexts?: QueuedDiffTextContext[],
  codeSelectionContexts?: QueuedCodeSelectionContext[],
  pastedTexts?: QueuedPastedText[],
): AgentQueueItem {
  return {
    id,
    message,
    images: images && images.length > 0 ? images : undefined,
    files: files && files.length > 0 ? files : undefined,
    textContexts: textContexts && textContexts.length > 0 ? textContexts : undefined,
    diffTextContexts:
      diffTextContexts && diffTextContexts.length > 0 ? diffTextContexts : undefined,
    codeSelectionContexts:
      codeSelectionContexts && codeSelectionContexts.length > 0 ? codeSelectionContexts : undefined,
    pastedTexts: pastedTexts && pastedTexts.length > 0 ? pastedTexts : undefined,
    timestamp: new Date(),
    status: 'pending',
  };
}

export function removeQueueItem(queue: AgentQueueItem[], itemId: string): AgentQueueItem[] {
  return queue.filter((item) => item.id !== itemId);
}

// Helper to convert UploadedImage to QueuedImage
export function toQueuedImage(img: UploadedImage): QueuedImage {
  return {
    id: img.id,
    url: img.url,
    mediaType: img.mediaType || 'image/png',
    filename: img.filename,
    base64Data: img.base64Data,
  };
}

// Helper to convert UploadedFile to QueuedFile
export function toQueuedFile(file: UploadedFile): QueuedFile {
  return {
    id: file.id,
    url: file.url,
    filename: file.filename,
    mediaType: file.type,
    size: file.size,
  };
}

// Helper to convert SelectedTextContext to QueuedTextContext
export function toQueuedTextContext(ctx: SelectedTextContext): QueuedTextContext {
  return {
    id: ctx.id,
    text: ctx.text,
    sourceMessageId: ctx.sourceMessageId,
  };
}

export function toQueuedDiffTextContext(ctx: DiffTextContext): QueuedDiffTextContext {
  return {
    id: ctx.id,
    text: ctx.text,
    filePath: ctx.filePath,
    lineNumber: ctx.lineNumber,
    lineType: ctx.lineType,
  };
}

export function toQueuedPastedText(pasted: QueuedPastedText): QueuedPastedText {
  return {
    id: pasted.id,
    filePath: pasted.filePath,
    filename: pasted.filename,
    size: pasted.size,
    preview: pasted.preview,
  };
}

// Helper to convert CodeSelectionContext to QueuedCodeSelectionContext
export function toQueuedCodeSelectionContext(
  ctx: CodeSelectionContext,
): QueuedCodeSelectionContext {
  return {
    id: ctx.id,
    text: ctx.text,
    filePath: ctx.filePath,
    fileName: ctx.fileName,
    language: ctx.language,
    startLine: ctx.startLine,
    endLine: ctx.endLine,
  };
}

// Helper to create a truncated preview from text
export function createTextPreview(text: string, maxLength: number = 50): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
