import { useAtomValue } from 'jotai';
import { Wrench } from 'lucide-react';
import { memo } from 'react';
import { runningSubagentToolIdsAtom } from '../../../../lib/stores/active-transport-registry';
import type { MessagePart } from '../../stores/message-store';
import { AgentToolCall } from '../agent-tool-call';
import { getToolStatus } from '../agent-tool-registry';

/**
 * Input keys a tool may carry a human label under, in preference order. Deliberately generic — this
 * card exists precisely for tools nothing knows the shape of.
 */
const SUBTITLE_KEYS = ['description', 'prompt', 'path', 'query', 'command'] as const;

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const UNDERSCORE = /_/g;
const WHITESPACE = /\s+/;
const MAX_SUBTITLE_LENGTH = 60;

/**
 * Turn a machine tool name into a readable phrase: `SubagentStarted` → `Subagent started`,
 * `codex_imageGeneration` → `Codex image generation`.
 */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(CAMEL_BOUNDARY, '$1 $2')
    .replace(UNDERSCORE, ' ')
    .trim()
    .split(WHITESPACE);
  const [first, ...rest] = words;
  if (!first) return name;
  return [
    first.charAt(0).toUpperCase() + first.slice(1),
    ...rest.map((word) => word.toLowerCase()),
  ].join(' ');
}

/** First stringy, human-meaningful value the tool input carries, truncated for the card. */
export function firstSubtitle(input: Record<string, unknown> | undefined): string | undefined {
  for (const key of SUBTITLE_KEYS) {
    const value = input?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.length > MAX_SUBTITLE_LENGTH
        ? `${value.slice(0, MAX_SUBTITLE_LENGTH - 3)}...`
        : value;
    }
  }
  return undefined;
}

/**
 * Fallback card for a tool part that no registry entry and no MCP parser claims.
 *
 * The previous fallback was a bare text line carrying no state at all, so any tool Frink had not been
 * taught about rendered as inert grey text — indistinguishable whether it was running, finished or
 * failed. Every unmapped provider tool lands here, so this is the renderer-side half of "an unknown
 * tool must still fail VISIBLY": it gets the same shimmer-while-pending treatment as a known tool.
 */
export const AgentGenericToolCall = memo(function AgentGenericToolCall({
  part,
  chatStatus,
}: {
  part: MessagePart;
  chatStatus?: string;
}) {
  const { isPending: statusPending, isError } = getToolStatus(part, chatStatus);
  // A background launch (e.g. Workflow) settles its part at launch; main's task tracker is the truth.
  const taskRunning = useAtomValue(runningSubagentToolIdsAtom).has(part.toolCallId ?? '');
  const isPending = statusPending || taskRunning;
  const toolName = part.toolName ?? part.type?.replace('tool-', '') ?? 'Tool';
  // AgentToolCall does not render its isError prop, so a failure has to reach the reader through the
  // subtitle or it is invisible — the same "written but never read" trap this card exists to close.
  const subtitle = part.errorText ?? firstSubtitle(part.input);
  return (
    <AgentToolCall
      icon={Wrench}
      title={humanizeToolName(toolName)}
      subtitle={subtitle}
      isPending={isPending}
      isError={isError}
    />
  );
});
