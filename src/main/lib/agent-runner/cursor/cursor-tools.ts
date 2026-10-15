/** How Frink's gate reads one tool in Cursor's pre-tool hook; any other tool is refused. */
export type CursorToolRule = {
  question?: 'Bash' | 'Edit' | 'Read';
  /** Every input key the tool may send; a call with any other key is refused. */
  keys: readonly string[];
};

/** The tools Cursor's hook names, keyed by its tool_name. Glob calls arrive as Grep. */
export const CURSOR_HOOK_TOOLS = {
  Shell: { question: 'Bash', keys: ['command', 'cwd', 'timeout'] },
  Write: { question: 'Edit', keys: ['file_path', 'content'] },
  Delete: { question: 'Edit', keys: ['file_path'] },
  Read: { question: 'Read', keys: ['file_path'] },
  Grep: { question: 'Read', keys: ['pattern', 'file_path', 'glob', 'output_mode'] },
  ReadLints: { question: 'Read', keys: ['file_path'] },
} satisfies Readonly<Record<string, CursorToolRule>>;

/** A run tool as its hook sees it: the hook tool, input-key renames and any input it always has. */
export type CursorStreamTool = {
  tool: string;
  keys: Record<string, string>;
  input?: Record<string, string>;
};

/** Each tool Cursor may offer, as its run names it, mapped to its hook tool and input keys. */
export const CURSOR_STREAM_TOOLS = {
  shell: { tool: 'Shell', keys: { command: 'command', workingDirectory: 'cwd' } },
  read: { tool: 'Read', keys: { path: 'file_path' } },
  edit: { tool: 'Write', keys: { path: 'file_path' } },
  delete: { tool: 'Delete', keys: { path: 'file_path' } },
  grep: { tool: 'Grep', keys: { path: 'file_path', glob: 'glob' } },
  // The hook sees a glob call as a Grep for nothing that returns file names only.
  glob: {
    tool: 'Grep',
    keys: { targetDirectory: 'file_path', globPattern: 'glob' },
    input: { pattern: '', output_mode: 'files_with_matches' },
  },
  readLints: { tool: 'ReadLints', keys: { paths: 'file_path' } },
  // Kept in memory by Cursor and never seen by a hook.
  updateTodos: null,
  readTodos: null,
} satisfies Readonly<Record<string, CursorStreamTool | null>>;

/** The only tools a Cursor agent is offered: every one Frink's gate can ask about. */
export const CURSOR_TOOL_NAMES = Object.keys(CURSOR_STREAM_TOOLS);
