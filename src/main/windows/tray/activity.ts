import { basename } from 'node:path';
import { z } from 'zod';

/** The newest part of a reply, as far as the status line reads it; anything else is "Working". */
export const streamPartSchema = z.object({
  type: z.string(),
  input: z
    .object({ file_path: z.string(), notebook_path: z.string(), path: z.string() })
    .partial()
    .optional()
    .catch(undefined),
});

type StreamPart = z.infer<typeof streamPartSchema>;

const FILE_TOOLS = new Map<string, [withFile: string, withoutFile: string]>([
  ['Edit', ['Editing', 'Editing files']],
  ['MultiEdit', ['Editing', 'Editing files']],
  ['Write', ['Writing', 'Writing files']],
  ['NotebookEdit', ['Editing', 'Editing a notebook']],
  ['Read', ['Reading', 'Reading files']],
]);

const TOOLS = new Map<string, string>([
  ['Bash', 'Running a command'],
  ['Grep', 'Searching the code'],
  ['Glob', 'Searching the code'],
  ['LS', 'Looking through folders'],
  ['WebFetch', 'Reading a web page'],
  ['WebSearch', 'Searching the web'],
  ['Task', 'Running a helper agent'],
  ['Agent', 'Running a helper agent'],
  ['TodoWrite', 'Planning the work'],
]);

/** What an agent is doing right now, in plain words, from the newest part of its reply. */
export function describeActivity(part: StreamPart | undefined): string {
  if (part?.type === 'reasoning') return 'Thinking';
  if (part?.type === 'text') return 'Writing a reply';
  if (!part?.type.startsWith('tool-')) return 'Working';
  const tool = part.type.slice('tool-'.length);
  const fileTool = FILE_TOOLS.get(tool);
  if (fileTool) {
    const path = part.input?.file_path ?? part.input?.notebook_path ?? part.input?.path;
    return path ? `${fileTool[0]} ${basename(path)}` : fileTool[1];
  }
  if (tool.startsWith('mcp__')) return 'Using a connected tool';
  return TOOLS.get(tool) ?? 'Working';
}
