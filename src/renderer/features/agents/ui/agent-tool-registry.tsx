/* eslint-disable max-lines */
import {
  Database,
  Eye,
  FileCode2,
  FolderSearch,
  GitBranch,
  List,
  ListTodo,
  Minimize2,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  XCircle,
  SquareTerminal,
  Globe,
  FilePenLine,
  FilePlus,
  Brain,
  Search,
  Sparkles,
} from 'lucide-react';
import {
  getNumberValue,
  getStringValue,
  isSubagentTaskPart,
  partLifecycleState,
  reRootAtProjectDir,
  type ToolMeta,
} from './tool-registry-shared';

export { isSubagentTaskPart } from './tool-registry-shared';

import { formatMcpToolName, parseMcpToolFullName } from '../../../../shared/lib/mcp-tool-name';
import { TERMINAL_TOOL_PART_STATES } from '../../../../shared/types/assistant-message';
import { pickPlanningStatusMessage } from '../../../lib/agent-chat/planning/planning-status-message';
import { hasActiveTransport } from '../../../lib/stores/active-transport-registry';
import type { MessagePart } from '../stores/message-store';
import { STEER_TOOL_ENTRY } from './steer-card';
import { FLOWS_TOOL_ENTRIES } from './tool-registry-flows';

export { formatMcpToolName } from '../../../../shared/lib/mcp-tool-name';

import { getEditToolDenialState } from './agent-edit-permission';

// Regex patterns - hoisted to module level for performance
const LINE_CONTINUATION_REGEX = /\\\s*\n\s*/g;

/**
 * Human label for a subagent card/row. The native `Task` tool carries it in
 * `description`; the `Agent` tool may instead use `subagent_type` or `prompt`.
 * Returns '' when none is a non-empty string. Truncation is the caller's job.
 */
export function getSubagentLabel(input: Record<string, unknown> | undefined): string {
  return (
    getStringValue(input, 'description') ||
    getStringValue(input, 'subagent_type') ||
    getStringValue(input, 'prompt')
  );
}

/** Full "pattern in path" string for subtitleLong (Grep, Glob). No truncation. */
function subtitleLongPatternPath(part: MessagePart, pathKey: string): string {
  if (part.state === 'input-streaming') return '';
  const pattern = getStringValue(part.input, 'pattern');
  const pathVal = getStringValue(part.input, pathKey);
  return pathVal ? `${pattern} in ${pathVal}` : pattern;
}

// Helper to safely extract array values from Record<string, unknown>
function getArrayValue<T>(input: Record<string, unknown> | undefined, key: string): T[] {
  if (!input) return [];
  const value = input[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Slice of {@link ToolMeta} used by isolated chat planning/tool rows.
 * Keeps `title` as `(part: MessagePart) => string` — same as the full registry.
 */
type IsolatedChatToolRegistryEntry = Pick<ToolMeta, 'icon' | 'title' | 'titleShimmerVariant'>;

export type IsolatedChatToolRegistry = Record<string, IsolatedChatToolRegistryEntry> & {
  'tool-planning': IsolatedChatToolRegistryEntry;
};

export function getToolStatus(part: MessagePart, chatStatus?: string, subChatId?: string) {
  const state = partLifecycleState(part);
  const basePending = !TERMINAL_TOOL_PART_STATES.has(state ?? '');
  const isError =
    state === 'output-error' || (state === 'output-available' && part.output?.success === false);
  const isSuccess = state === 'output-available' && !isError;
  // Critical: if chat stopped streaming, pending tools should show as complete
  // Include "submitted" status - this is when request was sent but streaming hasn't started yet
  const isActivelyStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';
  let isPending = basePending && isActivelyStreaming;
  // Tool was in progress but chat stopped streaming (user interrupted)
  let isInterrupted = basePending && !isActivelyStreaming && chatStatus !== undefined;
  // Subagent Task cards are driven by the main process after the root stream's status flips to
  // 'ready' (a 5s heartbeat keeps the run alive), so we can't key their spinner off chatStatus.
  // But only keep spinning while the run is genuinely live — i.e. there is an active transport.
  // After a server/main-process restart the transport is gone and the run is dead, so a pending
  // card with no output is an orphan: fall through to the interrupted label instead of animating
  // forever. subChatId is only supplied at the top-level subagent-card call site.
  if (isSubagentTaskPart(part)) {
    if (basePending && !part.output && subChatId && hasActiveTransport(subChatId)) {
      isInterrupted = false;
      isPending = true;
    }
  }

  return { isPending, isError, isSuccess, isInterrupted };
}

/**
 * Resolve a part's type to a registry key. MCP tools arrive with a fully-qualified
 * name like `tool-mcp__frink_dynamic_chat__frink_flows_patch` but the registry
 * keys use the short form `tool-frink_flows_patch`. This strips the MCP server
 * prefix so lookups succeed for both built-in and MCP tools.
 */
export function resolveRegistryKey(partType: string): string {
  if (partType in AgentToolRegistry) return partType;
  const lastSep = partType.lastIndexOf('__');
  if (lastSep > 0) {
    const short = `tool-${partType.slice(lastSep + 2)}`;
    if (short in AgentToolRegistry) return short;
  }
  return partType;
}

// Utility to get clean display path (remove sandbox/worktree/absolute prefixes)
function getDisplayPath(filePath: string): string {
  if (!filePath) return '';
  const prefixes = ['/project/sandbox/repo/', '/project/sandbox/', '/project/'];
  for (const prefix of prefixes) {
    if (filePath.startsWith(prefix)) {
      return filePath.slice(prefix.length);
    }
  }
  const reRooted = reRootAtProjectDir(filePath);
  if (reRooted) return reRooted;
  // For other absolute paths, show last 3 segments to keep it short
  const parts = filePath.split('/');
  if (filePath.startsWith('/') && parts.length > 3) return parts.slice(-3).join('/');
  return filePath;
}

/** Format diff stats as colored HTML subtitle. */
function formatDiffSubtitle(added: number, removed: number): string {
  return `<span style="font-size: 11px; color: light-dark(#587C0B, #A3BE8C)">+${added}</span> <span style="font-size: 11px; color: light-dark(#AD0807, #AE5A62)">-${removed}</span>`;
}

// Utility to calculate diff stats (Claude Code CLI: old_string/new_string comparison)
function calculateDiffStats(oldString: string, newString: string) {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const maxLines = Math.max(oldLines.length, newLines.length);
  let addedLines = 0;
  let removedLines = 0;

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine !== undefined && newLine !== undefined) {
      if (oldLine !== newLine) {
        removedLines++;
        addedLines++;
      }
    } else if (oldLine !== undefined) {
      removedLines++;
    } else if (newLine !== undefined) {
      addedLines++;
    }
  }
  return { addedLines, removedLines };
}

/**
 * Subagent card entry — shared by the native `Task` tool and the `Agent` tool.
 * Current Claude Code names the subagent-spawning tool `Agent`; older/native flows
 * use `Task`. Both render the same collapsible "Running/Completed Subagent" card.
 * Hoisted above the registry literal so both keys can alias one definition.
 */
const subagentToolEntry: ToolMeta = {
  icon: Sparkles,
  title: (part) => {
    const isPending = part.state !== 'output-available' && part.state !== 'output-error';
    const isInputStreaming = part.state === 'input-streaming';
    if (isInputStreaming) return 'Preparing subagent';
    return isPending ? 'Running Subagent' : 'Completed Subagent';
  },
  subtitle: (part) => {
    // Don't show subtitle while input is still streaming
    if (part.state === 'input-streaming') return '';
    const label = getSubagentLabel(part.input);
    return label.length > 50 ? `${label.slice(0, 47)}...` : label;
  },
  variant: 'simple',
};

const agentToolRegistryDefinition = {
  'tool-Task': subagentToolEntry,
  'tool-Agent': subagentToolEntry,

  'tool-Grep': {
    icon: Search,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing search';
      if (isPending) return 'Grepping';

      // Handle different output modes:
      // - "files_with_matches" mode: numFiles > 0, filenames is populated
      // - "content" mode: numFiles = 0, but numLines > 0 and content has matches
      const mode = getStringValue(part.output, 'mode');
      const numFiles = getNumberValue(part.output, 'numFiles');
      const numLines = getNumberValue(part.output, 'numLines');

      if (mode === 'content') {
        // In content mode, numFiles is always 0, use numLines instead
        return numLines > 0 ? `Found ${numLines} matches` : 'No matches';
      }

      return numFiles > 0 ? `Grepped ${numFiles} files` : 'No matches';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const pattern = getStringValue(part.input, 'pattern');
      const path = getStringValue(part.input, 'path');

      if (path) {
        // Show "pattern in path"
        const combined = `${pattern} in ${path}`;
        return combined.length > 40 ? `${combined.slice(0, 37)}...` : combined;
      }

      return pattern.length > 40 ? `${pattern.slice(0, 37)}...` : pattern;
    },
    subtitleLong: (part) => subtitleLongPatternPath(part, 'path'),
    variant: 'simple',
  },

  'tool-Glob': {
    icon: FolderSearch,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing search';
      if (isPending) return 'Exploring files';

      const numFiles = getNumberValue(part.output, 'numFiles');
      return numFiles > 0 ? `Found ${numFiles} files` : 'No files found';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const pattern = getStringValue(part.input, 'pattern');
      const targetDir = getStringValue(part.input, 'target_directory');

      if (targetDir) {
        // Show "pattern in targetDir"
        const combined = `${pattern} in ${targetDir}`;
        return combined.length > 40 ? `${combined.slice(0, 37)}...` : combined;
      }

      return pattern.length > 40 ? `${pattern.slice(0, 37)}...` : pattern;
    },
    subtitleLong: (part) => subtitleLongPatternPath(part, 'target_directory'),
    variant: 'simple',
  },

  'tool-LS': {
    icon: FolderSearch,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing to list';
      if (isPending) return 'Listing files';

      const numFiles = getNumberValue(part.output, 'numFiles');
      return numFiles > 0 ? `Listed ${numFiles} files` : 'Listed files';
    },
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const dir =
        getStringValue(part.input, 'target_directory') || getStringValue(part.input, 'path');
      if (!dir) return '';
      const short = dir.split('/').pop() || dir;
      return short.length > 40 ? `${short.slice(0, 37)}...` : short;
    },
    variant: 'simple',
  },

  'tool-Read': {
    icon: Eye,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing to read';
      return isPending ? 'Reading' : 'Read';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const filePath = getStringValue(part.input, 'file_path');
      if (!filePath) return ''; // Don't show "file" placeholder during streaming
      return filePath.split('/').pop() || '';
    },
    tooltipContent: (part) => {
      if (part.state === 'input-streaming') return '';
      const filePath = getStringValue(part.input, 'file_path');
      return getDisplayPath(filePath);
    },
    variant: 'simple',
  },

  'tool-Edit': {
    icon: FilePenLine,
    title: (part) => {
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing edit';
      const filePath = getStringValue(part.input, 'file_path');
      if (!filePath) return 'Edit';
      return filePath.split('/').pop() || 'Edit';
    },
    // Note: Edit tools are rendered by AgentEditTool, not the generic AgentToolCall.
    // This subtitle is a fallback in case routing changes.
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      if (isPending) return '';

      // Claude Code CLI: diff stats from old_string/new_string in input
      const oldString = getStringValue(part.input, 'old_string');
      const newString = getStringValue(part.input, 'new_string');

      if (!oldString && !newString) {
        return '';
      }

      if (oldString !== newString) {
        const { addedLines, removedLines } = calculateDiffStats(oldString, newString);
        return formatDiffSubtitle(addedLines, removedLines);
      }

      return '';
    },
    variant: 'simple',
  },

  // Cloning indicator - shown while sandbox is being created
  'tool-cloning': {
    icon: GitBranch,
    title: () => 'Cloning repo',
    variant: 'simple',
  },

  // Planning indicator - shown when streaming starts but no content yet
  'tool-planning': {
    icon: Brain,
    title: (part) => pickPlanningStatusMessage(part),
    variant: 'simple',
    titleShimmerVariant: 'spectrum',
  },

  'tool-Write': {
    icon: FilePlus,
    title: (part) => {
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing to create';
      return 'Create';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const filePath = getStringValue(part.input, 'file_path');
      if (!filePath) return ''; // Don't show "file" placeholder during streaming
      return filePath.split('/').pop() || '';
    },
    variant: 'simple',
  },

  'tool-Delete': {
    icon: Trash2,
    title: (part) => {
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing to delete';
      if (getEditToolDenialState(part).permissionDenied) return 'Delete blocked';
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      // Reason: pre-existing clone; the icon-library swap only renamed identifiers inside it
      // fallow-ignore-next-line code-duplication
      return isPending ? 'Deleting' : 'Deleted';
    },
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const filePath = getStringValue(part.input, 'file_path');
      if (!filePath) return '';
      return filePath.split('/').pop() || '';
    },
    tooltipContent: (part) => {
      if (part.state === 'input-streaming') return '';
      const filePath = getStringValue(part.input, 'file_path');
      return getDisplayPath(filePath);
    },
    variant: 'simple',
  },

  'tool-Bash': {
    icon: SquareTerminal,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Generating command';
      return isPending ? 'Running command' : 'Ran command';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const command = getStringValue(part.input, 'command');
      if (!command) return '';
      // Normalize line continuations and show truncated command
      const normalized = command.replace(LINE_CONTINUATION_REGEX, ' ').trim();
      return normalized.length > 50 ? `${normalized.slice(0, 47)}...` : normalized;
    },
    subtitleLong: (part) => {
      if (part.state === 'input-streaming') return '';
      const command = getStringValue(part.input, 'command');
      if (!command) return '';
      return command.replace(LINE_CONTINUATION_REGEX, ' ').trim();
    },
    variant: 'simple',
  },

  'tool-WebFetch': {
    icon: Globe,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing fetch';
      return isPending ? 'Fetching' : 'Fetched';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const url = getStringValue(part.input, 'url');
      try {
        return new URL(url).hostname.replace('www.', '');
      } catch {
        return url.slice(0, 30);
      }
    },
    variant: 'simple',
  },

  'tool-WebSearch': {
    icon: Search,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const isInputStreaming = part.state === 'input-streaming';
      if (isInputStreaming) return 'Preparing search';
      return isPending ? 'Searching web' : 'Searched web';
    },
    subtitle: (part) => {
      // Don't show subtitle while input is still streaming
      if (part.state === 'input-streaming') return '';
      const query = getStringValue(part.input, 'query');
      return query.length > 40 ? `${query.slice(0, 37)}...` : query;
    },
    variant: 'collapsible',
  },
  'tool-ToolSearch': {
    icon: Search,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      if (part.state === 'input-streaming') return 'Preparing search';
      return isPending ? 'Searching tools' : 'Searched tools';
    },
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      const query = getStringValue(part.input, 'query');
      return query.length > 40 ? `${query.slice(0, 37)}...` : query;
    },
    subtitleLong: (part) => {
      if (part.state === 'input-streaming') return '';
      return getStringValue(part.input, 'query');
    },
    variant: 'simple',
  },

  // Planning tools
  'tool-TodoWrite': {
    icon: ListTodo,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const action = getStringValue(part.input, 'action') || 'update';
      if (isPending) {
        return action === 'add' ? 'Adding todo' : 'Updating todos';
      }
      return action === 'add' ? 'Added todo' : 'Updated todos';
    },
    subtitle: (part) => {
      const todos = getArrayValue<unknown>(part.input, 'todos');
      if (todos.length === 0) return '';
      return `${todos.length} ${todos.length === 1 ? 'item' : 'items'}`;
    },
    variant: 'simple',
  },

  // Task management tools
  'tool-TaskCreate': {
    icon: Plus,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Creating task' : 'Created task';
    },
    subtitle: (part) => {
      const subject = getStringValue(part.input, 'subject');
      return subject.length > 40 ? `${subject.slice(0, 37)}...` : subject;
    },
    variant: 'simple',
  },

  'tool-TaskUpdate': {
    icon: RefreshCw,
    title: (part) => {
      const status = getStringValue(part.input, 'status');
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      if (isPending) {
        if (status === 'in_progress') return 'Starting task';
        if (status === 'completed') return 'Completing task';
        if (status === 'deleted') return 'Deleting task';
        return 'Updating task';
      }
      if (status === 'in_progress') return 'Started task';
      if (status === 'completed') return 'Completed task';
      if (status === 'deleted') return 'Deleted task';
      return 'Updated task';
    },
    subtitle: (part) => {
      const subject = getStringValue(part.input, 'subject');
      const taskId = getStringValue(part.input, 'taskId');
      if (subject) {
        return subject.length > 40 ? `${subject.slice(0, 37)}...` : subject;
      }
      return taskId ? `#${taskId}` : '';
    },
    variant: 'simple',
  },

  'tool-TaskGet': {
    icon: Eye,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Getting task' : 'Got task';
    },
    subtitle: (part) => {
      const taskId = getStringValue(part.input, 'taskId');
      return taskId ? `#${taskId}` : '';
    },
    variant: 'simple',
  },

  'tool-TaskList': {
    icon: List,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const tasks = getArrayValue<unknown>(part.output, 'tasks');
      if (isPending) return 'Listing tasks';
      return `Listed ${tasks.length} tasks`;
    },
    subtitle: () => '',
    variant: 'simple',
  },

  'tool-PlanWrite': {
    icon: Brain,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const action = getStringValue(part.input, 'action') || 'create';
      const plan = part.input?.plan;
      const status =
        plan && typeof plan === 'object' && 'status' in plan && typeof plan.status === 'string'
          ? plan.status
          : undefined;
      if (isPending) {
        if (action === 'create') return 'Creating plan';
        if (action === 'approve') return 'Approving plan';
        if (action === 'complete') return 'Completing plan';
        return 'Updating plan';
      }
      if (status === 'awaiting_approval') return 'Plan ready for review';
      if (status === 'approved') return 'Plan approved';
      if (status === 'completed') return 'Plan completed';
      return action === 'create' ? 'Created plan' : 'Updated plan';
    },
    subtitle: (part) => {
      const plan = part.input?.plan;
      if (!plan || typeof plan !== 'object') return '';
      return 'title' in plan && typeof plan.title === 'string' ? plan.title : '';
    },
    variant: 'simple',
  },

  'tool-frink-plan': {
    icon: Brain,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      const status = getStringValue(part.input, 'status');
      if (isPending) return 'Creating plan';
      if (status === 'awaiting_approval') return 'Plan ready for review';
      if (status === 'approved') return 'Plan approved';
      if (status === 'completed') return 'Plan completed';
      return 'Plan';
    },
    subtitle: () => '',
    variant: 'simple',
  },

  // Notebook tools
  'tool-NotebookEdit': {
    icon: FileCode2,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      if (getEditToolDenialState(part).permissionDenied) return 'Notebook edit blocked';
      return isPending ? 'Editing notebook' : 'Edited notebook';
    },
    subtitle: (part) => {
      const filePath = getStringValue(part.input, 'file_path');
      if (!filePath) return '';
      return filePath.split('/').pop() || '';
    },
    variant: 'simple',
  },

  // Shell management tools
  'tool-BashOutput': {
    icon: Terminal,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Getting output' : 'Got output';
    },
    subtitle: (part) => {
      const pid = part.input?.pid;
      return pid !== undefined && pid !== null ? `PID: ${pid}` : '';
    },
    variant: 'simple',
  },

  'tool-KillShell': {
    icon: XCircle,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Stopping shell' : 'Stopped shell';
    },
    subtitle: (part) => {
      const pid = part.input?.pid;
      return pid !== undefined && pid !== null ? `PID: ${pid}` : '';
    },
    variant: 'simple',
  },

  // Memory MCP tool
  'tool-search_nodes': {
    icon: Search,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Searching memory' : 'Searched memory';
    },
    subtitle: (part) => {
      const query = getStringValue(part.input, 'query');
      return query.length > 40 ? `${query.slice(0, 37)}...` : query;
    },
    variant: 'simple',
  },
  'tool-frink_navigation_context': {
    icon: GitBranch,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Reading navigation context' : 'Read navigation context';
    },
    subtitle: () => 'Origin/current project + worktree trail',
    variant: 'simple',
  },
  'tool-requestSwitchProject': {
    icon: GitBranch,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Requesting project switch' : 'Project switch requested';
    },
    subtitle: (part) => getStringValue(part.input, 'project_id'),
    variant: 'simple',
  },

  // MCP tools
  'tool-ListMcpResources': {
    icon: Server,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Listing resources' : 'Listed resources';
    },
    subtitle: (part) => {
      const server = getStringValue(part.input, 'server');
      return server;
    },
    variant: 'simple',
  },

  'tool-ReadMcpResource': {
    icon: Database,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Reading resource' : 'Read resource';
    },
    subtitle: (part) => {
      const uri = getStringValue(part.input, 'uri');
      return uri.length > 30 ? `...${uri.slice(-27)}` : uri;
    },
    variant: 'simple',
  },

  // Frink Flows MCP tools
  // System tools
  'data-compact': {
    icon: Minimize2,
    title: (part) => {
      if (partLifecycleState(part) === 'output-error') return 'Compaction failed';
      // Automatic compaction is otherwise silent; naming it explains context the user never asked
      // to lose.
      return part.data?.trigger === 'auto' ? 'Auto-compacted' : 'Compacted';
    },
    variant: 'simple',
  },

  // Extended Thinking
  'tool-Skill': {
    icon: Sparkles,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Loading skill' : 'Loaded skill';
    },
    subtitle: (part) => {
      if (part.state === 'input-streaming') return '';
      return getStringValue(part.input, 'skill');
    },
    variant: 'simple',
  },

  'tool-Thinking': {
    icon: Sparkles,
    title: (part) => {
      const isPending = part.state !== 'output-available' && part.state !== 'output-error';
      return isPending ? 'Thinking...' : 'Thought';
    },
    subtitle: (part) => {
      const text = getStringValue(part.input, 'text');
      // Show first 50 chars as preview
      return text.length > 50 ? `${text.slice(0, 47)}...` : text;
    },
    subtitleLong: (part) => {
      const text = getStringValue(part.input, 'text');
      const maxLen = 300;
      return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    },
    variant: 'collapsible',
  },
} satisfies Record<string, ToolMeta> & { 'tool-planning': ToolMeta };

export const AgentToolRegistry: Record<string, ToolMeta> & { 'tool-planning': ToolMeta } = {
  ...agentToolRegistryDefinition,
  ...FLOWS_TOOL_ENTRIES,
  ...STEER_TOOL_ENTRY,
};

/** Same reference as {@link AgentToolRegistry}, typed for isolated chat (requires `tool-planning`). */
export const isolatedChatToolRegistry: IsolatedChatToolRegistry = AgentToolRegistry;

// ============================================================================
// MCP TOOL PARSING
// ============================================================================
// Unregistered MCP tools (anything matching `tool-mcp__<server>__<tool>` that
// is not in AgentToolRegistry) are rendered by AgentMcpToolCall. Tools that
// frink curates explicitly (e.g. tool-frink_flows_patch, tool-ListMcpResources)
// stay in the registry above and win via resolveRegistryKey precedence.

const TOOL_PART_PREFIX = 'tool-';

type McpToolCategory =
  | 'search'
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'send'
  | 'generate'
  | 'other';

export type McpToolInfo = {
  serverName: string;
  toolName: string;
  displayName: string;
  category: McpToolCategory;
};

export function parseMcpToolType(partType: string): McpToolInfo | null {
  if (!partType.startsWith(TOOL_PART_PREFIX)) return null;
  const parsed = parseMcpToolFullName(partType.slice(TOOL_PART_PREFIX.length));
  if (!parsed) return null;
  return {
    serverName: parsed.serverName,
    toolName: parsed.toolName,
    displayName: formatMcpToolName(parsed.toolName),
    category: categorizeMcpTool(parsed.toolName),
  };
}

function categorizeMcpTool(toolName: string): McpToolCategory {
  const lower = toolName.toLowerCase();
  if (lower.startsWith('search_') || lower.startsWith('query_')) return 'search';
  if (lower.startsWith('list_')) return 'list';
  if (lower.startsWith('get_') || lower.startsWith('fetch_') || lower.startsWith('retrieve_'))
    return 'get';
  if (lower.startsWith('create_') || lower.startsWith('add_') || lower.startsWith('draft_'))
    return 'create';
  if (lower.startsWith('update_') || lower.startsWith('modify_') || lower.startsWith('set_'))
    return 'update';
  if (lower.startsWith('delete_') || lower.startsWith('remove_')) return 'delete';
  if (lower.startsWith('send_')) return 'send';
  if (lower.startsWith('generate_')) return 'generate';
  return 'other';
}
