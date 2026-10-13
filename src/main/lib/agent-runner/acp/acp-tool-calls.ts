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

/** What is known of one tool call, beyond the fields of its latest report. */
export type KnownToolCall = ToolCallUpdate & {
  /** The title of the agent's first report on the call, which names the tool it runs. */
  tool?: string;
  /** The directory the call's own input says its command runs in. */
  workdir?: string;
};

/** Where a report came from: a new call, a later report on it, or a permission request. */
export type ReportSource = 'tool_call' | 'tool_call_update' | 'request';

/** The keys of the call's input, or nothing when the input is not an object. */
export function inputKeys(toolCall: ToolCallUpdate): string[] | undefined {
  const input = keyedInputSchema.safeParse(toolCall.rawInput);
  return input.success ? Object.keys(input.data) : undefined;
}

/** One string field of the call's input. */
export function inputText(toolCall: ToolCallUpdate, key: string): string | undefined {
  const input = z.object({ [key]: z.string() }).safeParse(toolCall.rawInput);
  return input.success ? input.data[key] : undefined;
}

/** The input, tool and directory known of a call; an empty input says nothing new. */
function rememberInput(
  update: ToolCallUpdate,
  known: Partial<KnownToolCall>,
  source: ReportSource,
): Pick<KnownToolCall, 'rawInput' | 'tool' | 'workdir'> {
  const saysNothing = inputKeys(update)?.length === 0;
  return {
    rawInput: saysNothing ? known.rawInput : (update.rawInput ?? known.rawInput),
    tool: known.tool ?? (source === 'request' ? undefined : (update.title ?? undefined)),
    workdir: inputText(update, 'workdir') ?? known.workdir,
  };
}

/**
 * Folds one report about a tool call into what is known of it; ACP sends only changed fields.
 * A new call on a known id starts over.
 */
export function rememberToolCall(
  toolCalls: Map<string, KnownToolCall>,
  update: ToolCallUpdate,
  source: ReportSource = 'tool_call_update',
): KnownToolCall {
  const known = source === 'tool_call' ? undefined : toolCalls.get(update.toolCallId);
  const toolCall: KnownToolCall = {
    toolCallId: update.toolCallId,
    title: update.title ?? known?.title,
    kind: update.kind ?? known?.kind,
    status: update.status ?? known?.status,
    content: mergeContent(known?.content, update.content),
    locations: update.locations?.length ? update.locations : known?.locations,
    ...rememberInput(update, known ?? {}, source),
  };
  // A request's locations name what it asks about, such as a folder, not what the call touches.
  const kept = source === 'request' ? { ...toolCall, locations: known?.locations } : toolCall;
  toolCalls.set(update.toolCallId, kept);
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
  return toolCall.kind === 'execute' || inputKeys(toolCall)?.includes('command') === true;
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
