import type { ToolCallContent, ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';
import { z } from 'zod';

/** The ACP tool kinds that act on one file, as the tool names Frink's rules and cards use. */
export const PATH_TOOL_BY_KIND = new Map<ToolKind, string>([
  ['read', 'Read'],
  ['edit', 'Edit'],
  ['delete', 'Delete'],
]);

/** The one command shape Frink puts to its rules: any other key could change what runs. */
const commandInputSchema = z.strictObject({ command: z.string().trim().min(1) });
const keyedInputSchema = z.looseObject({});

/** A later report that carries no diff keeps the diffs already known for the call. */
function mergeContent(
  known: ToolCallContent[] | null | undefined,
  update: ToolCallContent[] | null | undefined,
): ToolCallContent[] | null | undefined {
  if (!update) return known;
  if (update.some((entry) => entry.type === 'diff')) return update;
  return [...(known ?? []).filter((entry) => entry.type === 'diff'), ...update];
}

/** Folds one report about a tool call into what is known of it; ACP sends only changed fields. */
export function rememberToolCall(
  toolCalls: Map<string, ToolCallUpdate>,
  update: ToolCallUpdate,
): ToolCallUpdate {
  const known = toolCalls.get(update.toolCallId);
  const toolCall: ToolCallUpdate = {
    toolCallId: update.toolCallId,
    title: update.title ?? known?.title,
    kind: update.kind ?? known?.kind,
    status: update.status ?? known?.status,
    content: mergeContent(known?.content, update.content),
    locations: update.locations?.length ? update.locations : known?.locations,
    rawInput: update.rawInput ?? known?.rawInput,
  };
  toolCalls.set(update.toolCallId, toolCall);
  return toolCall;
}

/** True when a report describes a step of its own yet names no kind, so no earlier kind may fill in. */
export function describesStepWithoutKind(update: ToolCallUpdate): boolean {
  if (update.kind) return false;
  return Boolean(
    update.title || update.rawInput != null || update.locations?.length || update.content?.length,
  );
}

/** True when the call says it runs a command, by its kind or by a `command` key in its input. */
export function namesCommand(toolCall: ToolCallUpdate): boolean {
  const input = keyedInputSchema.safeParse(toolCall.rawInput);
  return toolCall.kind === 'execute' || (input.success && 'command' in input.data);
}

/** The shell command in the call's own input when that is all the input holds. */
export function toolCallCommand(toolCall: ToolCallUpdate): string | undefined {
  const parsed = commandInputSchema.safeParse(toolCall.rawInput);
  return parsed.success ? parsed.data.command : undefined;
}

/** Every file the call names, from its locations and from the diffs it carries. */
export function toolCallPaths(toolCall: ToolCallUpdate): string[] {
  const located = (toolCall.locations ?? []).map((location) => location.path);
  const diffed = (toolCall.content ?? []).flatMap((entry) =>
    entry.type === 'diff' ? [entry.path] : [],
  );
  return [...new Set([...located, ...diffed])];
}
