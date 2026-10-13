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
