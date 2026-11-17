import fs from 'node:fs';
import log from 'electron-log';
import { z } from 'zod';
import { flowChangeStringValue } from '../../../../shared/lib/flows/flow-change-text';
import { spilledToolResultPath, unwrapMcpOutput } from '../../../../shared/lib/mcp-output';
import {
  FRINK_OWNED_MCP_SERVERS,
  parseMcpToolFullName,
} from '../../../../shared/lib/mcp-tool-name';
import { isSessionToolResultPath } from '../../permissions/v2/check-edit';
import { claudeSessionConfigDir } from '../session-plan-paths';
import type { UIMessageChunk } from '../types';

const FLOW_PATCH_TOOL = 'frink_flows_patch';
const MAX_SPILL_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The receipt fields the Flow-change card reads, parsed at the file boundary. Unlisted keys (the
 * agent-facing message) are dropped; nested shapes are re-validated by the renderer as usual.
 */
const spilledReceiptSchema = z.object({
  status: z.enum(['success', 'partial']),
  persistence: z.enum(['saved', 'unchanged']).optional(),
  flowId: z.string().min(1),
  versionId: z.string().optional(),
  versionNumber: z.number().optional(),
  name: z.string().optional(),
  graph: z.unknown().optional(),
  flowChange: z.unknown().optional(),
  applied: z.unknown().optional(),
  failed: z.unknown().optional(),
  skipped: z.unknown().optional(),
  retryOps: z.unknown().optional(),
  templateWarnings: z.unknown().optional(),
  webhookSetup: z.unknown().optional(),
});

type SpilledReceipt = z.infer<typeof spilledReceiptSchema>;

type ToolOutputChunk = Extract<
  UIMessageChunk,
  { type: 'tool-output-available' | 'tool-output-error' }
>;

function isFlowPatchTool(toolName: string | undefined): boolean {
  if (toolName === FLOW_PATCH_TOOL) return true;
  const parsed = toolName ? parseMcpToolFullName(toolName) : null;
  return parsed?.toolName === FLOW_PATCH_TOOL && FRINK_OWNED_MCP_SERVERS.has(parsed.serverName);
}

function spillNoteText(chunk: ToolOutputChunk): string | undefined {
  if (chunk.type === 'tool-output-error') return chunk.errorText;
  return flowChangeStringValue(unwrapMcpOutput(chunk.output));
}

/** Realpath of the saved file when it sits in this chat's own tool-results folder, else undefined. */
function sessionSpillFile(savedPath: string, subChatId: string): string | undefined {
  const sessionRoot = claudeSessionConfigDir(subChatId);
  if (!sessionRoot) return undefined;
  try {
    const realFile = fs.realpathSync.native(savedPath);
    const realRoot = fs.realpathSync.native(sessionRoot);
    return isSessionToolResultPath(realFile, realRoot) ? realFile : undefined;
  } catch {
    return undefined;
  }
}

function readReceipt(file: string): SpilledReceipt | undefined {
  if (fs.statSync(file).size > MAX_SPILL_FILE_BYTES) return undefined;
  const body = unwrapMcpOutput(JSON.parse(fs.readFileSync(file, 'utf8')));
  return spilledReceiptSchema.safeParse(body).data;
}

/** Swaps a frink_flows_patch spill note for its saved receipt; persisted, so replay outlives the file. */
export function recoverSpilledFlowPatchChunk(
  chunk: UIMessageChunk,
  context: { subChatId: string; toolName: string | undefined },
): UIMessageChunk {
  if (chunk.type !== 'tool-output-available' && chunk.type !== 'tool-output-error') return chunk;
  if (!isFlowPatchTool(context.toolName)) return chunk;
  const savedPath = spilledToolResultPath(spillNoteText(chunk) ?? '');
  if (!savedPath) return chunk;
  const file = sessionSpillFile(savedPath, context.subChatId);
  if (!file) {
    log.warn('[spilled-flow-patch] Spill file is outside the chat tool-results folder');
    return chunk;
  }
  try {
    const receipt = readReceipt(file);
    if (receipt)
      return { type: 'tool-output-available', toolCallId: chunk.toolCallId, output: receipt };
  } catch {
    // A truncated or unreadable file falls through: the card keeps the unread note.
  }
  log.warn('[spilled-flow-patch] Spill file held no readable receipt');
  return chunk;
}

/** Tool name for a call id, read back from the tool-input chunks already in this message. */
export function toolNameInChunks(
  chunks: readonly UIMessageChunk[],
  toolCallId: string,
): string | undefined {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (
      (chunk?.type === 'tool-input-available' || chunk?.type === 'tool-input-start') &&
      chunk.toolCallId === toolCallId
    ) {
      return chunk.toolName;
    }
  }
  return undefined;
}
