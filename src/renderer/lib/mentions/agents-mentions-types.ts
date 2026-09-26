export type FileMentionOption = {
  id: string; // file:owner/repo:path/to/file.tsx or folder:owner/repo:path/to/folder or skill:skill-name or tool:mcp-tool-name
  label: string; // filename or folder name or skill name or tool name
  path: string; // full path or skill description
  repository: string;
  truncatedPath?: string; // directory path for inline display or skill description
  additions?: number; // for changed files
  deletions?: number; // for changed files
  type?: 'file' | 'folder' | 'skill' | 'agent' | 'category' | 'tool' | 'briefing'; // entry type (default: file)
  // Extended data for rich tooltips (skills/agents/tools)
  description?: string; // skill/agent/tool description
  tools?: string[]; // agent allowed tools
  model?: string; // agent model
  source?: 'user' | 'project'; // skill/agent source
  mcpServer?: string; // MCP server name for tools
};

// Mention ID prefixes
export const MENTION_PREFIXES = {
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  FILE: 'file:',
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  FOLDER: 'folder:',
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  SKILL: 'skill:',
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  AGENT: 'agent:',
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  TOOL: 'tool:', // MCP tools
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  QUOTE: 'quote:', // Selected text from assistant messages
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  DIFF: 'diff:', // Selected text from diff sidebar
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  PASTED: 'pasted:', // Large pasted text saved as files
  // biome-ignore lint/style/useNamingConvention: enum-style constant object keys
  BRIEFING: 'briefing:', // Flow briefing (format: briefing:<flowId>:<base64Name>:<base64Text>)
} as const;

/** Strips characters that would break the `@[type:preview:payload]` mention grammar. Lives here,
 * not in the editor component, so pure modules can sanitize a preview without importing React. */
export const MENTION_PREVIEW_SANITIZE_REGEX = /[:[\]]/g;
