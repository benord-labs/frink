import { describe, expect, it } from 'vitest';
import { describeActivity, streamPartSchema } from './activity';

describe('describeActivity', () => {
  it.each([
    [{ type: 'tool-Bash', input: { command: 'bun test' } }, 'Running a command'],
    [{ type: 'tool-Edit', input: { file_path: '/repo/src/checkout.ts' } }, 'Editing checkout.ts'],
    [{ type: 'tool-Edit', input: {} }, 'Editing files'],
    [{ type: 'tool-Edit', input: 'not an object' }, 'Editing files'],
    [{ type: 'tool-Read', input: { file_path: 'README.md' } }, 'Reading README.md'],
    [{ type: 'tool-NotebookEdit', input: { notebook_path: '/a/b.ipynb' } }, 'Editing b.ipynb'],
    [{ type: 'tool-Grep', input: { pattern: 'x' } }, 'Searching the code'],
    [{ type: 'tool-WebSearch' }, 'Searching the web'],
    [{ type: 'tool-Task' }, 'Running a helper agent'],
    [{ type: 'tool-mcp__linear__create_issue' }, 'Using a connected tool'],
    [{ type: 'tool-codex_unknown_item' }, 'Working'],
    [{ type: 'reasoning' }, 'Thinking'],
    [{ type: 'text', text: 'Done' }, 'Writing a reply'],
    [undefined, 'Working'],
    ['not a part', 'Working'],
  ])('describes %j as %s', (part, expected) => {
    expect(describeActivity(streamPartSchema.safeParse(part).data)).toBe(expected);
  });
});
