import type {
  MobileMessage,
  MobileMessagePart,
} from '@frink/shared/types/remote/mobile';

export type Tool = Extract<MobileMessagePart, { type: 'tool' }>;
export type Attachment = Extract<MobileMessagePart, { type: 'attachment' }>;
export type Group =
  | { type: 'text'; text: string }
  | { type: 'tools'; tools: Tool[] }
  | { type: 'steer'; text: string };

/** A message's body in reading order: prose, runs of tool steps (merged), and steered notes. */
export function contentGroups(message: MobileMessage): Group[] {
  const parts: MobileMessagePart[] = message.parts?.length
    ? message.parts
    : [{ type: 'text', text: message.text }];
  const groups: Group[] = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (part.type === 'tool') {
      if (last?.type === 'tools') last.tools.push(part);
      else groups.push({ type: 'tools', tools: [part] });
    } else if ((part.type === 'text' || part.type === 'steer') && part.text.trim())
      groups.push({ type: part.type, text: part.text });
  }
  return groups;
}

export function attachmentsOf(message: MobileMessage): Attachment[] {
  return (message.parts ?? []).filter((part): part is Attachment => part.type === 'attachment');
}

/** The prose a Copy action copies: every text group, never tool names or steers. */
export function copyText(groups: Group[]): string {
  return groups.flatMap((group) => (group.type === 'text' ? [group.text] : [])).join('\n\n');
}

// Plain words for the tools a reader meets most; anything else keeps the name it was given.
const TOOL_LABELS: Record<string, string> = {
  Bash: 'Running a command',
  Read: 'Reading a file',
  Edit: 'Editing files',
  Write: 'Editing files',
  MultiEdit: 'Editing files',
  Grep: 'Searching the code',
  Glob: 'Searching the code',
  WebFetch: 'Looking online',
  WebSearch: 'Looking online',
  TodoWrite: 'Updating the plan',
};

/** What a tool step is doing, for someone who has never seen a tool name. */
export function toolLabel(name: string): string {
  // Connected tools are `mcp__<server>__<tool>`; claude.ai connectors prefix the server name.
  const server = /^mcp__(.+?)__/.exec(name)?.[1];
  if (server) return `Using ${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}`;
  return TOOL_LABELS[name] ?? name;
}

const steps = (count: number) => `${count} ${count === 1 ? 'step' : 'steps'}`;

/**
 * One quiet line for a run of tool steps: "Working · Running a command" while one runs, otherwise
 * "Worked · 6 steps", naming failures and a stop so they are never hidden in the collapsed line.
 */
export function toolRunSummary(tools: Tool[]): {
  label: string;
  state: 'running' | 'failed' | 'stopped' | 'done';
} {
  const running = tools.findLast((tool) => tool.state === 'running');
  if (running) return { label: `Working · ${toolLabel(running.name)}`, state: 'running' };
  const failed = tools.filter((tool) => tool.state === 'failed').length;
  if (failed)
    return { label: `Worked · ${steps(tools.length)} · ${failed} failed`, state: 'failed' };
  if (tools.some((tool) => tool.state === 'interrupted'))
    return { label: `Stopped · ${steps(tools.length)}`, state: 'stopped' };
  return { label: `Worked · ${steps(tools.length)}`, state: 'done' };
}

export const TOOL_STATE_WORD: Record<Tool['state'], string> = {
  running: 'Working',
  completed: 'Done',
  failed: 'Failed',
  interrupted: 'Stopped',
  unknown: 'Status unavailable',
};
