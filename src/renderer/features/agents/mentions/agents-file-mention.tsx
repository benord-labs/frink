import mcpLogo from '@iconify-icons/simple-icons/modelcontextprotocol';
import { iconifyComponent } from '@/lib/utils/iconify-component';
/* eslint-disable max-lines, max-lines-per-function */
import { keepPreviousData } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { ChevronRight, FileText, Bot, Files, Loader2, ToolCase, FolderOpen } from 'lucide-react';
import { createElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';
import {
  isGlobalSearchNonFileSubpage as checkGlobalSearchNonFileSubpage,
  computeBriefingsHookLoading,
} from '@/lib/mentions/agents-file-mention-search-helpers';
import type { FileMentionOption } from '@/lib/mentions/agents-mentions-types';
import { MENTION_PREFIXES } from '@/lib/mentions/agents-mentions-types';
import { encodeForMentionToken } from '@/lib/mentions/briefing-base64';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip';
import { sessionInfoAtom } from '../../../lib/atoms';
import { api } from '../../../lib/mock-api';
import { trpc } from '../../../lib/trpc';
import { overlayGlass } from '@/lib/overlay-styles';
import { cn } from '../../../lib/utils';

const OriginalMCPIcon = iconifyComponent(mcpLogo);

export { getFileIconByExtension } from '@/lib/mentions/agents-file-mention-icons';

// Regex patterns (moved to module scope for performance)
const HEIGHT_CLASS_REGEX = /h-3\b/;
const WIDTH_CLASS_REGEX = /w-3\b/;
const WHITESPACE_REGEX = /\s+/;
const WHITESPACE_GLOBAL_REGEX = /\s+/g;
const FILE_EXT_REGEX = /\.[^.]+$/;
const UNDERSCORE_GLOBAL_REGEX = /_/g;
const WORD_BOUNDARY_CAPITALIZE_REGEX = /\b\w/g;

type ChangedFile = {
  filePath: string;
  displayPath: string;
  additions: number;
  deletions: number;
};

type AgentsFileMentionProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (mention: FileMentionOption) => void;
  searchText: string;
  position: { top: number; left: number };
  teamId?: string;
  repository?: string;
  sandboxId?: string;
  branch?: string; // For fetching files from specific branch via GitHub API
  projectPath?: string; // For fetching files from local project directory (desktop)
  /** UUID of the project this chat is associated with (used for briefing queries) */
  projectId?: string;
  changedFiles?: ChangedFile[]; // Files changed in current sub-chat (shown at top)
  // Subpage navigation state
  showingFilesList?: boolean;
  showingSkillsList?: boolean;
  showingAgentsList?: boolean;
  showingToolsList?: boolean;
  showingBriefingsList?: boolean;
};

// Category navigation options (shown on root view)
const CATEGORY_OPTIONS: FileMentionOption[] = [
  { id: 'files', label: 'Files & Folders', type: 'category', path: '', repository: '' },
  { id: 'skills', label: 'Skills', type: 'category', path: '', repository: '' },
  { id: 'agents', label: 'Agents', type: 'category', path: '', repository: '' },
  { id: 'tools', label: 'MCP Tools', type: 'category', path: '', repository: '' },
  { id: 'briefings', label: 'Briefings', type: 'category', path: '', repository: '' },
];

// Tool icon component (MCP icon) - slightly larger for visibility
function ToolIcon({ className }: { className?: string }) {
  // Override size to h-3.5 w-3.5 for better visibility
  const sizeClass =
    className?.replace(HEIGHT_CLASS_REGEX, 'h-3.5').replace(WIDTH_CLASS_REGEX, 'w-3.5') ||
    className;
  return <OriginalMCPIcon className={sizeClass} />;
}

/**
 * Format MCP tool name for display
 * Converts snake_case/underscore names to readable format
 * e.g., "get_design_context" -> "Get design context"
 */
function formatToolName(toolName: string): string {
  return toolName
    .replace(UNDERSCORE_GLOBAL_REGEX, ' ')
    .replace(WORD_BOUNDARY_CAPITALIZE_REGEX, (c) => c.toUpperCase())
    .replace(WHITESPACE_GLOBAL_REGEX, ' ')
    .trim();
}

// Create SVG icon element in DOM based on file extension or type
export function createFileIconElement(
  filename: string,
  type?: 'file' | 'folder' | 'skill' | 'agent' | 'category' | 'tool' | 'briefing',
): SVGSVGElement {
  // biome-ignore lint/style/useNamingConvention: component type variable
  const IconComponent =
    type === 'skill'
      ? ToolCase
      : type === 'agent'
        ? Bot
        : type === 'tool'
          ? ToolIcon
          : type === 'briefing'
            ? FileText
            : type === 'folder'
              ? FolderOpen
              : (getFileIconByExtension(filename) ?? Files);
  // Note: "category" type will use the default file icon based on filename, which is fine since
  // categories won't be inserted as mentions in the editor (they navigate to subpages)

  // Create a temporary container
  const container = document.createElement('div');
  container.style.display = 'none';
  container.style.position = 'absolute';
  container.style.visibility = 'hidden';
  document.body.appendChild(container);

  // Create React element
  const iconElement = createElement(IconComponent, {
    className: 'h-3 w-3 text-muted-foreground shrink-0',
  });

  const root = createRoot(container);

  // Render synchronously using flushSync
  flushSync(() => {
    root.render(iconElement);
  });

  // Extract the SVG element
  const svgElement = container.querySelector('svg');

  // Clean up
  root.unmount();
  if (container.parentNode) {
    document.body.removeChild(container);
  }

  if (!svgElement || !(svgElement instanceof SVGSVGElement)) {
    // Fallback: create a simple file icon
    const fallbackSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    fallbackSvg.setAttribute('width', '12');
    fallbackSvg.setAttribute('height', '12');
    fallbackSvg.setAttribute('viewBox', '0 0 24 24');
    fallbackSvg.setAttribute('fill', 'none');
    fallbackSvg.setAttribute('stroke', 'currentColor');
    fallbackSvg.setAttribute('stroke-width', '2');
    fallbackSvg.setAttribute('stroke-linecap', 'round');
    fallbackSvg.setAttribute('stroke-linejoin', 'round');
    fallbackSvg.setAttribute('aria-label', 'File icon');
    fallbackSvg.className.baseVal = 'h-3 w-3 text-muted-foreground shrink-0';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
    fallbackSvg.appendChild(path);

    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '14 2 14 8 20 8');
    fallbackSvg.appendChild(polyline);

    return fallbackSvg;
  }

  // Clone the SVG to avoid issues
  const clonedSvg = svgElement.cloneNode(true) as SVGSVGElement;
  clonedSvg.setAttribute('class', 'h-3 w-3 text-muted-foreground shrink-0');

  return clonedSvg;
}

// Folder icon component for consistency with file icons
function FolderIcon({ className }: { className?: string }) {
  return <FolderOpen className={className} />;
}

// Skill icon component (local wrapper for getOptionIcon)
function SkillIconWrapper({ className }: { className?: string }) {
  return <ToolCase className={className} />;
}

function CustomAgentIconWrapper({ className }: { className?: string }) {
  return <Bot className={className} />;
}

// ToolIconWrapper removed - use ToolIcon instead (they were identical)

// Category icon component
function CategoryIcon({ className, categoryId }: { className?: string; categoryId: string }) {
  if (categoryId === 'files') {
    return <Files className={className} />;
  }
  if (categoryId === 'skills') {
    return <ToolCase className={className} />;
  }
  if (categoryId === 'agents') {
    return <Bot className={className} />;
  }
  if (categoryId === 'tools') {
    // Override size to h-3.5 w-3.5 for better visibility
    const sizeClass =
      className?.replace(HEIGHT_CLASS_REGEX, 'h-3.5').replace(WIDTH_CLASS_REGEX, 'w-3.5') ||
      className;
    return <OriginalMCPIcon className={sizeClass} />;
  }
  if (categoryId === 'briefings') {
    return <FileText className={className} />;
  }
  return <Files className={className} />;
}

// Briefing icon wrapper for option icon
function BriefingIconWrapper({ className }: { className?: string }) {
  return <FileText className={className} />;
}

/**
 * Get icon component for a file, folder, skill, agent, tool, briefing, or category option
 */
function getOptionIcon(option: {
  id?: string;
  label: string;
  type?: 'file' | 'folder' | 'skill' | 'agent' | 'category' | 'tool' | 'briefing';
}) {
  if (option.type === 'category') {
    // Return a wrapper component for categories
    return function CategoryIconWrapper({ className }: { className?: string }) {
      return <CategoryIcon className={className} categoryId={option.id || ''} />;
    };
  }
  if (option.type === 'skill') {
    return SkillIconWrapper;
  }
  if (option.type === 'agent') {
    return CustomAgentIconWrapper;
  }
  if (option.type === 'tool') {
    return ToolIcon;
  }
  if (option.type === 'briefing') {
    return BriefingIconWrapper;
  }
  if (option.type === 'folder') {
    return FolderIcon;
  }
  return getFileIconByExtension(option.label) ?? Files;
}

/**
 * Render folder path as a tree structure for tooltip
 * e.g., "apps/web/app" becomes:
 *   📁 apps
 *     📁 web
 *       📁 app
 */
function renderFolderTree(path: string) {
  const parts = path.split('/').filter(Boolean);
  const lastIndex = parts.length - 1;
  return (
    <div className="flex flex-col gap-1 min-w-[220px]">
      {parts.map((part, index) => {
        const isLast = index === lastIndex;
        // Use full path up to this point as unique key
        const pathKey = parts.slice(0, index + 1).join('/');
        return (
          <div
            key={pathKey}
            className={cn(
              'flex items-center gap-1.5 text-xs',
              isLast ? 'text-foreground' : 'text-muted-foreground',
            )}
            style={{ paddingLeft: `${index * 20}px` }}
          >
            <FolderOpen
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                isLast ? 'text-foreground/70' : 'text-muted-foreground',
              )}
            />
            <span className={isLast ? 'font-medium' : ''}>{part}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Check if a string matches all search words (multi-word search)
 * Splits search by whitespace, all words must be present in target
 */
function matchesMultiWordSearch(target: string, searchLower: string): boolean {
  if (!searchLower) return true;
  const searchWords = searchLower.split(WHITESPACE_REGEX).filter(Boolean);
  if (searchWords.length === 0) return true;
  const targetLower = target.toLowerCase();
  return searchWords.every((word) => targetLower.includes(word));
}

/**
 * Sort files by relevance to search query
 * Priority: exact match > starts with > shorter match > contains in filename > alphabetical
 * Supports multi-word search - splits by whitespace, all words must match
 * When search ends with space, prioritize files with hyphen/underscore (e.g. "agents " -> "agents-sidebar")
 */
function sortFilesByRelevance<T extends { label: string; path?: string }>(
  files: T[],
  searchText: string,
): T[] {
  if (!searchText) return files;

  const searchLower = searchText.toLowerCase();
  const searchWords = searchLower.split(WHITESPACE_REGEX).filter(Boolean);
  const isSingleWord = searchWords.length <= 1;
  // Check if search ends with space - user wants to continue with hyphenated names
  const endsWithSpace = searchText.endsWith(' ');

  return [...files].sort((a, b) => {
    const aLabelLower = a.label.toLowerCase();
    const bLabelLower = b.label.toLowerCase();

    // Get filename without extension for matching
    const aNameNoExt = aLabelLower.replace(FILE_EXT_REGEX, '');
    const bNameNoExt = bLabelLower.replace(FILE_EXT_REGEX, '');

    // For multi-word search, prioritize files where all words match in filename
    if (!isSingleWord) {
      const aAllInFilename = searchWords.every((w) => aLabelLower.includes(w));
      const bAllInFilename = searchWords.every((w) => bLabelLower.includes(w));
      if (aAllInFilename && !bAllInFilename) return -1;
      if (!aAllInFilename && bAllInFilename) return 1;
    }

    // When search ends with space, prioritize files with hyphen/underscore after first word
    // e.g. "agents " should show "agents-sidebar" before "agents" folder
    if (endsWithSpace && searchWords.length >= 1) {
      const lastWord = searchWords[searchWords.length - 1];
      // Check if filename has hyphen/underscore continuation after matching word
      const aHasContinuation =
        aNameNoExt.includes(`${lastWord}-`) || aNameNoExt.includes(`${lastWord}_`);
      const bHasContinuation =
        bNameNoExt.includes(`${lastWord}-`) || bNameNoExt.includes(`${lastWord}_`);
      if (aHasContinuation && !bHasContinuation) return -1;
      if (!aHasContinuation && bHasContinuation) return 1;
    }

    // Priority 1: EXACT match (chat.tsx when searching "chat") - single word only, not when ending with space
    if (isSingleWord && !endsWithSpace) {
      const aExact = aNameNoExt === searchLower;
      const bExact = bNameNoExt === searchLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
    }

    // Priority 2: filename STARTS with first search word
    const firstWord = searchWords[0] || searchLower;
    const aStartsWith = aNameNoExt.startsWith(firstWord);
    const bStartsWith = bNameNoExt.startsWith(firstWord);
    if (aStartsWith && !bStartsWith) return -1;
    if (!aStartsWith && bStartsWith) return 1;

    // Priority 3: If both start with query, shorter name = higher match %
    // But when ending with space, prefer longer (hyphenated) names
    if (aStartsWith && bStartsWith) {
      if (aNameNoExt.length !== bNameNoExt.length) {
        if (endsWithSpace) {
          return bNameNoExt.length - aNameNoExt.length; // longer first when space at end
        }
        return aNameNoExt.length - bNameNoExt.length; // shorter first normally
      }
    }

    // Priority 4: filename CONTAINS first word (but doesn't start with it)
    const aFilenameMatch = aLabelLower.includes(firstWord);
    const bFilenameMatch = bLabelLower.includes(firstWord);
    if (aFilenameMatch && !bFilenameMatch) return -1;
    if (!aFilenameMatch && bFilenameMatch) return 1;

    // Finally: alphabetically by label
    return a.label.localeCompare(b.label);
  });
}

/**
 * Render tooltip content for a mention option
 * Skills/agents show description, tools, model info
 * Tools show MCP server name
 * Files/folders show path
 */
function renderTooltipContent(option: FileMentionOption) {
  if (option.type === 'folder') {
    return renderFolderTree(option.path);
  }

  if (option.type === 'skill' || option.type === 'agent') {
    return (
      <div className="flex flex-col gap-1.5 w-full overflow-hidden">
        {option.description && (
          <p className="text-xs text-muted-foreground wrap-break-word">{option.description}</p>
        )}
        {option.model && <div className="text-xs text-muted-foreground">Model: {option.model}</div>}
        {option.tools && option.tools.length > 0 && (
          <div className="text-xs text-muted-foreground wrap-break-word">
            Tools: {option.tools.join(', ')}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/70 font-mono truncate w-full">
          {option.path}
        </div>
      </div>
    );
  }

  if (option.type === 'tool') {
    // Show full tool name (e.g., mcp__figma-local-mcp__get_figjam)
    return <div className="text-xs text-muted-foreground font-mono">{option.path}</div>;
  }

  // Files - just path
  return (
    <div className="text-xs text-muted-foreground font-mono truncate w-full">{option.path}</div>
  );
}

// Memoized to prevent re-renders when parent re-renders
export const AgentsFileMention = memo(function AgentsFileMention({
  isOpen,
  onClose,
  onSelect,
  searchText,
  position,
  teamId,
  repository,
  sandboxId,
  branch,
  projectPath,
  projectId,
  changedFiles = [],
  showingFilesList = false,
  showingSkillsList = false,
  showingAgentsList = false,
  showingToolsList = false,
  showingBriefingsList = false,
}: AgentsFileMentionProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const placementRef = useRef<'above' | 'below' | null>(null);
  const [debouncedSearchText, setDebouncedSearchText] = useState(searchText);

  const [_hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Get session info (MCP servers, tools) from atom
  const sessionInfo = useAtomValue(sessionInfoAtom);

  // Fetch skills from filesystem (cached for 5 minutes)
  const { data: rawSkills, isFetching: _isFetchingSkills } = trpc.skills.listEnabled.useQuery(
    projectPath ? { cwd: projectPath } : undefined,
    {
      enabled: isOpen,
      staleTime: 5 * 60 * 1000, // 5 minutes - skills don't change frequently
    },
  );
  const skills = Array.isArray(rawSkills) ? rawSkills : [];

  // Fetch custom agents from filesystem (cached for 5 minutes)
  const { data: rawCustomAgents, isFetching: _isFetchingAgents } = trpc.agents.listEnabled.useQuery(
    projectPath ? { cwd: projectPath } : undefined,
    {
      enabled: isOpen,
      staleTime: 5 * 60 * 1000, // 5 minutes - agents don't change frequently
    },
  );
  const customAgents = Array.isArray(rawCustomAgents) ? rawCustomAgents : [];

  // Fetch flow briefings for this project — prefetch as soon as projectId is known
  const {
    data: rawBriefings,
    isPending: briefingsPending,
    isLoading: briefingsLoading,
    isFetching: briefingsFetching,
    error: briefingsError,
  } = trpc.flows.getBriefings.useQuery(
    { projectId: projectId ?? undefined },
    {
      enabled: !!projectId,
      staleTime: 60 * 1000, // 1 minute
    },
  );
  const briefings = Array.isArray(rawBriefings) ? rawBriefings : [];

  // Debounce search text (300ms to match canvas implementation).
  // Clearing applies immediately so subpage navigation doesn't flash stale "no matches".
  useEffect(() => {
    if (!searchText) {
      setDebouncedSearchText('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedSearchText(searchText);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  // For multi-word search, send only first word to API (server filters by that),
  // then filter results on client by all words
  const apiSearchQuery = useMemo(() => {
    if (!debouncedSearchText) return '';
    const words = debouncedSearchText.split(WHITESPACE_REGEX).filter(Boolean);
    return words[0] || '';
  }, [debouncedSearchText]);

  // Fetch files from API
  // Priority: sandboxId (includes uncommitted) > branch (GitHub API) > cached file_tree
  const {
    data: rawFileResults,
    isLoading: filesLoading,
    isFetching: filesFetching,
    error: filesError,
  } = api.github.searchFiles.useQuery(
    {
      teamId: teamId ?? '',
      repository: repository ?? '',
      query: apiSearchQuery,
      limit: 50,
      sandboxId: sandboxId,
      branch: branch, // Pass branch for GitHub API fetch
      projectPath: projectPath, // For local project file search (desktop)
    },
    {
      // Enable if we have projectPath (desktop) OR teamId with repository/sandboxId/branch (web)
      enabled: isOpen && (!!projectPath || (!!teamId && (!!repository || !!sandboxId || !!branch))),
      staleTime: 5000,
      refetchOnWindowFocus: false,
      // Keep showing previous results while fetching new ones
      placeholderData: keepPreviousData,
    },
  );
  const fileResults = Array.isArray(rawFileResults) ? rawFileResults : [];
  // Convert changed files to options (shown at top in separate group)
  const changedFileOptions: FileMentionOption[] = useMemo(() => {
    if (!changedFiles.length) return [];

    const searchLower = debouncedSearchText.toLowerCase();

    const mapped = changedFiles
      .filter((file) =>
        // Multi-word search: all words must match in file path
        matchesMultiWordSearch(file.filePath, searchLower),
      )
      .map((file) => {
        const pathParts = file.filePath.split('/');
        const fileName = pathParts.pop() || file.filePath;
        const dirPath = pathParts.join('/') || '/';

        return {
          id: `changed:${file.filePath}`,
          label: fileName,
          path: file.filePath,
          repository: repository || '',
          truncatedPath: dirPath,
          additions: file.additions,
          deletions: file.deletions,
        };
      });

    // Sort by relevance using shared function
    return sortFilesByRelevance(mapped, debouncedSearchText);
  }, [changedFiles, debouncedSearchText, repository]);

  // Convert API results to options with truncated path
  // Exclude files that are already in changedFileOptions
  const changedFilePaths = useMemo(
    () => new Set(changedFiles.map((f) => f.filePath)),
    [changedFiles],
  );

  const repoFileOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase();

    const mapped = fileResults
      .filter((file) => !changedFilePaths.has(file.path))
      // Client-side multi-word filtering (API only filtered by first word)
      .filter((file) => matchesMultiWordSearch(file.path, searchLower))
      .map((file) => {
        // Get directory path (without filename/foldername) for inline display
        const pathParts = file.path.split('/');
        const dirPath = pathParts.slice(0, -1).join('/') || '/';

        return {
          id: file.id,
          label: file.label,
          path: file.path,
          repository: file.repository,
          truncatedPath: dirPath,
          type: (file as { type?: 'file' | 'folder' }).type,
        };
      });

    // Sort by relevance using shared function
    return sortFilesByRelevance(mapped, debouncedSearchText);
  }, [fileResults, changedFilePaths, debouncedSearchText]);

  // Convert skills to mention options
  const skillOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase();

    return skills
      .filter(
        (skill) =>
          // Multi-word search: all words must match in name OR description
          matchesMultiWordSearch(skill.name, searchLower) ||
          matchesMultiWordSearch(skill.description, searchLower),
      )
      .map((skill) => ({
        id: `${MENTION_PREFIXES.SKILL}${skill.name}`,
        label: skill.name,
        path: skill.path, // file path for tooltip
        repository: '',
        truncatedPath: skill.description,
        type: 'skill' as const,
        // Extended data for rich tooltip
        description: skill.description,
        source: skill.source,
      }));
  }, [skills, debouncedSearchText]);

  // Convert custom agents to mention options
  const agentOptions: FileMentionOption[] = useMemo(() => {
    const searchLower = debouncedSearchText.toLowerCase();

    return customAgents
      .filter(
        (agent) =>
          // Multi-word search: all words must match in name OR description
          matchesMultiWordSearch(agent.name, searchLower) ||
          matchesMultiWordSearch(agent.description, searchLower),
      )
      .map((agent) => ({
        id: `${MENTION_PREFIXES.AGENT}${agent.name}`,
        label: agent.name,
        path: agent.path, // file path for tooltip
        repository: '',
        truncatedPath: agent.description,
        type: 'agent' as const,
        // Extended data for rich tooltip
        description: agent.description,
        tools: agent.tools,
        model: agent.model,
        source: agent.source,
      }));
  }, [customAgents, debouncedSearchText]);

  // Convert MCP tools to mention options (stable, doesn't depend on search)
  // MCP tools have format like "mcp__servername__toolname"
  const allToolOptions: FileMentionOption[] = useMemo(() => {
    if (!sessionInfo?.tools || !sessionInfo?.mcpServers) return [];

    // Get connected MCP server names
    const connectedServers = new Set(
      sessionInfo.mcpServers.filter((s) => s.status === 'connected').map((s) => s.name),
    );

    // Filter tools that belong to MCP servers (format: mcp__servername__toolname)
    const mcpTools = sessionInfo.tools.filter((tool) => {
      if (!tool.startsWith('mcp__')) return false;
      const parts = tool.split('__');
      if (parts.length < 3) return false;
      const serverName = parts[1];
      return connectedServers.has(serverName);
    });

    return mcpTools.map((tool) => {
      const parts = tool.split('__');
      const serverName = parts[1];
      const toolName = parts.slice(2).join('__');
      const displayName = formatToolName(toolName);
      return {
        id: `${MENTION_PREFIXES.TOOL}${tool}`,
        label: displayName, // readable name without underscores
        path: tool, // full tool name for tooltip/mention
        repository: '',
        truncatedPath: serverName, // show server name as context
        type: 'tool' as const,
        mcpServer: serverName,
      };
    });
  }, [sessionInfo]);

  // Filtered tool options based on search
  const toolOptions: FileMentionOption[] = useMemo(() => {
    if (!debouncedSearchText) return allToolOptions;

    const searchLower = debouncedSearchText.toLowerCase();
    return allToolOptions.filter((tool) => {
      // Search by: display name, raw tool name, full path, server name
      return (
        matchesMultiWordSearch(tool.label, searchLower) ||
        matchesMultiWordSearch(tool.path, searchLower) ||
        matchesMultiWordSearch(tool.mcpServer || '', searchLower)
      );
    });
  }, [allToolOptions, debouncedSearchText]);

  // Build briefing options with briefing text embedded in the token ID at construction time.
  // Format: briefing:<flowId>:<base64Name>:<base64Text>
  // This matches the quote/code pattern: content embedded at selection time, no async at send.
  const allBriefingOptions: FileMentionOption[] = useMemo(() => {
    return briefings.map((b) => {
      const base64Name = encodeForMentionToken(b.name);
      const base64Text = encodeForMentionToken(b.briefing);
      return {
        id: `${MENTION_PREFIXES.BRIEFING}${b.id}:${base64Name}:${base64Text}`,
        label: b.name,
        path: '',
        repository: '',
        truncatedPath: '',
        type: 'briefing' as const,
      };
    });
  }, [briefings]);

  // Filtered briefing options based on search
  const briefingOptions: FileMentionOption[] = useMemo(() => {
    if (!debouncedSearchText) return allBriefingOptions;
    const searchLower = debouncedSearchText.toLowerCase();
    return allBriefingOptions.filter((b) => matchesMultiWordSearch(b.label, searchLower));
  }, [allBriefingOptions, debouncedSearchText]);

  // Check if we have skills, agents, or tools
  // Use base data (not search-filtered) for stable category display
  const hasSkills = skills.length > 0;
  const hasAgents = customAgents.length > 0;
  const hasTools = allToolOptions.length > 0;
  const hasBriefings = allBriefingOptions.length > 0;
  // In a project-scoped chat, never collapse to file-only: Briefings category is always listed and
  // API may return 0 rows (flow on another project id, draft-only briefing, etc.).
  const hasOnlyFiles = !projectId && !hasSkills && !hasAgents && !hasTools && !hasBriefings;

  // Determine if we're in a subpage view (or showing files directly when no skills/agents/tools)
  const isInSubpage =
    showingFilesList ||
    showingSkillsList ||
    showingAgentsList ||
    showingToolsList ||
    showingBriefingsList ||
    hasOnlyFiles;

  // Filter category options based on available data
  const availableCategoryOptions = useMemo(() => {
    return CATEGORY_OPTIONS.filter((category) => {
      if (category.id === 'files') return true; // Always show files
      if (category.id === 'skills') return hasSkills;
      if (category.id === 'agents') return hasAgents;
      if (category.id === 'tools') return hasTools;
      // Always show Briefings so root search can match "brief" and users reach the subpage
      // (empty API still yields an explicit empty state; hiding the row caused 0 global-search hits).
      if (category.id === 'briefings') return true;
      return true;
    });
  }, [hasSkills, hasAgents, hasTools]);

  // Combined options for keyboard navigation
  // Subpage views show only that category's items
  // Root view shows changed files + category navigation options
  // Search filters globally in root view, within category in subpage
  // If no skills, agents, tools, or briefings, skip root view and show files directly
  const options: FileMentionOption[] = useMemo(() => {
    // SUBPAGE: Files (or if no skills/agents/tools/briefings, show files directly)
    if (showingFilesList || hasOnlyFiles) {
      const allFiles = [...changedFileOptions, ...repoFileOptions];
      if (debouncedSearchText) {
        return sortFilesByRelevance(allFiles, debouncedSearchText);
      }
      return allFiles;
    }

    // SUBPAGE: Skills
    if (showingSkillsList) {
      return skillOptions; // already filtered by search in skillOptions memo
    }

    // SUBPAGE: Agents
    if (showingAgentsList) {
      return agentOptions; // already filtered by search in agentOptions memo
    }

    // SUBPAGE: MCP Tools
    if (showingToolsList) {
      return toolOptions; // already filtered by search in toolOptions memo
    }

    // SUBPAGE: Briefings
    if (showingBriefingsList) {
      return briefingOptions; // already filtered by search in briefingOptions memo
    }

    // ROOT VIEW
    if (debouncedSearchText) {
      // Global search: search across changed files + categories + skills + agents + tools + briefings + repo files
      const searchLower = debouncedSearchText.toLowerCase();
      const filteredCategories = availableCategoryOptions.filter((c) =>
        c.label.toLowerCase().includes(searchLower),
      );
      const allItems = [
        ...changedFileOptions,
        ...filteredCategories,
        ...skillOptions,
        ...agentOptions,
        ...toolOptions,
        ...briefingOptions,
        ...repoFileOptions,
      ];
      return sortFilesByRelevance(allItems, debouncedSearchText);
    }

    // No search: Changed files FIRST (quick access), then category navigation
    return [...changedFileOptions, ...availableCategoryOptions];
  }, [
    showingFilesList,
    showingSkillsList,
    showingAgentsList,
    showingToolsList,
    showingBriefingsList,
    debouncedSearchText,
    changedFileOptions,
    repoFileOptions,
    skillOptions,
    agentOptions,
    toolOptions,
    briefingOptions,
    hasOnlyFiles,
    availableCategoryOptions,
  ]);

  // Track previous values for smarter selection reset
  const prevIsOpenRef = useRef(isOpen);
  const prevSearchRef = useRef(debouncedSearchText);
  const prevShowingFilesListRef = useRef(showingFilesList);
  const prevShowingSkillsListRef = useRef(showingSkillsList);
  const prevShowingAgentsListRef = useRef(showingAgentsList);
  const prevShowingToolsListRef = useRef(showingToolsList);
  const prevShowingBriefingsListRef = useRef(showingBriefingsList);

  // CONSOLIDATED: Single useLayoutEffect for selection management (was 3 separate)
  useLayoutEffect(() => {
    const didJustOpen = isOpen && !prevIsOpenRef.current;
    const didSearchChange = debouncedSearchText !== prevSearchRef.current;
    const didSubpageChange =
      showingFilesList !== prevShowingFilesListRef.current ||
      showingSkillsList !== prevShowingSkillsListRef.current ||
      showingAgentsList !== prevShowingAgentsListRef.current ||
      showingToolsList !== prevShowingToolsListRef.current ||
      showingBriefingsList !== prevShowingBriefingsListRef.current;

    // Reset to 0 when opening, search changes, or subpage changes
    if (didJustOpen || didSearchChange || didSubpageChange) {
      setSelectedIndex(0);
    }
    // Clamp to valid range if options shrunk
    else if (options.length > 0 && selectedIndex >= options.length) {
      setSelectedIndex(Math.max(0, options.length - 1));
    }

    // Update refs
    prevIsOpenRef.current = isOpen;
    prevSearchRef.current = debouncedSearchText;
    prevShowingFilesListRef.current = showingFilesList;
    prevShowingSkillsListRef.current = showingSkillsList;
    prevShowingAgentsListRef.current = showingAgentsList;
    prevShowingToolsListRef.current = showingToolsList;
    prevShowingBriefingsListRef.current = showingBriefingsList;
  }, [
    isOpen,
    debouncedSearchText,
    options.length,
    selectedIndex,
    showingFilesList,
    showingSkillsList,
    showingAgentsList,
    showingToolsList,
    showingBriefingsList,
  ]);

  // Reset placement when closed
  useEffect(() => {
    if (!isOpen) {
      placementRef.current = null;
    }
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setSelectedIndex((prev) => (prev + 1) % options.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
          break;
        case 'Enter':
          if (e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          if (options[selectedIndex]) {
            onSelect(options[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          onClose();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isOpen, options, selectedIndex, onSelect, onClose]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return;

    // Account for header element
    const _headerOffset = 1;
    if (selectedIndex === 0) {
      dropdownRef.current.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    const elements = dropdownRef.current.querySelectorAll('[data-option-index]');
    const selectedElement = elements[selectedIndex] as HTMLElement;
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, isOpen]);

  // Click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Calculate dropdown dimensions (matching canvas style)
  // Narrower dropdown when showing only categories (no changed files)
  const hasChangedFiles = changedFileOptions.length > 0;
  const isRootView =
    !showingFilesList &&
    !showingSkillsList &&
    !showingAgentsList &&
    !showingToolsList &&
    !showingBriefingsList &&
    !hasOnlyFiles;

  const fileHeavyView = showingFilesList || hasOnlyFiles;
  const showFullPanelLoadingFiles = filesLoading && options.length === 0 && fileHeavyView;
  // TanStack Query v5: treat pending/loading/fetching together so we never flash empty while the
  // briefings query is in flight (isPending alone can miss edge frames vs isFetching/isLoading).
  const briefingsHookLoading = computeBriefingsHookLoading({
    projectId,
    briefingsError,
    briefingsPending,
    briefingsLoading,
    briefingsFetching,
  });
  const showBriefingsPanelLoading =
    showingBriefingsList && briefingsHookLoading && options.length === 0;
  // Root global search merges file + briefing results; suppress empty until both sources settle.
  const isGlobalSearchNonFileSubpage = checkGlobalSearchNonFileSubpage({
    debouncedSearchText,
    fileHeavyView,
    showingBriefingsList,
    showingSkillsList,
    showingAgentsList,
    showingToolsList,
  });
  const globalSearchAwaitingData =
    isGlobalSearchNonFileSubpage &&
    options.length === 0 &&
    (filesLoading || filesFetching || briefingsHookLoading);
  // Still show while briefings resolve even if file search already errored (avoids a blank panel).
  const showGlobalSearchPanelLoading = globalSearchAwaitingData;
  const showFullPanelFileError = !!filesError && fileHeavyView;
  const showBriefingsErrorRow = showingBriefingsList && !!briefingsError;
  /** Root @ search merges briefings; surface failure without requiring Briefings subpage */
  const showInlineRootBriefingsError =
    isGlobalSearchNonFileSubpage && !!projectId && !!briefingsError;
  const showMainList =
    options.length > 0 &&
    !(filesError && fileHeavyView) &&
    !(showingBriefingsList && briefingsError);

  /** File search + briefings (root search) participate in Results; other subpages stay spinner-free on background refetch */
  const showHeaderSpinner =
    (showingBriefingsList && briefingsFetching && !briefingsLoading) ||
    (fileHeavyView && filesFetching && !filesLoading) ||
    (isRootView &&
      !!debouncedSearchText &&
      ((filesFetching && !filesLoading) ||
        (!!projectId && briefingsFetching && !briefingsLoading)));

  const showInlineRootFileError =
    !!filesError && isRootView && !!debouncedSearchText && !fileHeavyView;

  const showEmptyState = (() => {
    if (options.length > 0) return false;
    if (showFullPanelLoadingFiles || showBriefingsPanelLoading || showGlobalSearchPanelLoading) {
      return false;
    }
    if (showFullPanelFileError || showBriefingsErrorRow || showInlineRootBriefingsError) {
      return false;
    }
    if (showingBriefingsList) {
      return !briefingsHookLoading;
    }
    if (showingSkillsList || showingAgentsList || showingToolsList) return true;
    if (fileHeavyView) {
      return !filesLoading && !filesFetching && !filesError;
    }
    if (debouncedSearchText) {
      return !filesLoading && !filesFetching && !briefingsHookLoading;
    }
    return false;
  })();

  // Narrow dropdown for root view (categories only) and skills/agents/tools/briefings subpages
  // Wide dropdown for files (showingFilesList or hasOnlyFiles)
  const useNarrowWidth =
    (isRootView && !hasChangedFiles && !debouncedSearchText) ||
    showingSkillsList ||
    showingAgentsList ||
    showingToolsList ||
    showingBriefingsList;
  const dropdownWidth = useNarrowWidth ? 200 : 320;
  const itemHeight = 28;
  const headerHeight = 28; // header with py-1.5 and text-xs
  // Only add header height when header is actually shown (in subpages or when searching)
  const showsHeader = !isRootView || !!debouncedSearchText;
  const paddingHeight = 8; // py-1 on container = 4px top + 4px bottom
  const requestedHeight = Math.min(
    options.length * itemHeight + (showsHeader ? headerHeight : 0) + paddingHeight,
    200,
  );
  const gap = 8;

  // Decide placement like Radix Popover (auto-flip top/bottom)
  const safeMargin = 10;
  const lineHeight = 20; // approximate line height for better positioning
  const availableBelow = window.innerHeight - (position.top + lineHeight) - safeMargin;
  const availableAbove = position.top - safeMargin;

  // Compute desired placement, but lock it for the duration of the open state
  // Prefer above if there's more space above, or if below doesn't fit
  if (placementRef.current === null) {
    const condition1 = availableAbove >= requestedHeight && availableBelow < requestedHeight;
    const condition2 = availableAbove > availableBelow && availableAbove >= requestedHeight;
    const shouldPlaceAbove = condition1 || condition2;
    placementRef.current = shouldPlaceAbove ? 'above' : 'below';
  }
  const placeAbove = placementRef.current === 'above';

  // Compute final top based on placement
  // Use line height for better positioning relative to cursor
  const finalTop = placeAbove ? position.top - gap : position.top + lineHeight + gap;

  // Position is already aligned to editor left edge, no offset needed
  let finalLeft = position.left;

  // Adjust horizontal overflow
  if (finalLeft + dropdownWidth > window.innerWidth - safeMargin) {
    finalLeft = window.innerWidth - dropdownWidth - safeMargin;
  }
  if (finalLeft < safeMargin) {
    finalLeft = safeMargin;
  }

  // Compute actual maxHeight based on available space on the chosen side
  const computedMaxHeight = Math.max(
    80,
    Math.min(requestedHeight, placeAbove ? availableAbove - gap : availableBelow - gap),
  );
  const transformY = placeAbove ? 'translateY(-100%)' : 'translateY(0)';

  return createPortal(
    <TooltipProvider delayDuration={300}>
      <div
        ref={dropdownRef}
        className={`fixed z-99999 overflow-y-auto rounded-[10px] border py-1 text-xs text-popover-foreground shadow-lg [&::-webkit-scrollbar]:hidden ${overlayGlass}`}
        style={
          {
            top: finalTop,
            left: finalLeft,
            width: `${dropdownWidth}px`,
            maxHeight: `${computedMaxHeight}px`,
            transform: transformY,
            scrollbarWidth: 'none',
          } as React.CSSProperties
        }
      >
        {/* Initial loading state — file-only surfaces (no cached rows yet) */}
        {showFullPanelLoadingFiles && (
          <div className="flex items-center gap-1.5 h-7 px-1.5 mx-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Loading files...</span>
          </div>
        )}

        {showBriefingsPanelLoading && (
          <div className="flex items-center gap-1.5 h-7 px-1.5 mx-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Loading briefings...</span>
          </div>
        )}

        {showGlobalSearchPanelLoading && (
          <div className="flex items-center gap-1.5 h-7 px-1.5 mx-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Searching...</span>
          </div>
        )}

        {/* Error state — files (file-heavy views only) */}
        {showFullPanelFileError && (
          <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
            Error loading files
          </div>
        )}

        {showBriefingsErrorRow && (
          <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
            Error loading briefings
          </div>
        )}

        {showInlineRootBriefingsError && (
          <div className="px-2.5 py-1 mx-1 text-[10px] text-muted-foreground/90 leading-snug">
            Could not load briefings — other results may be incomplete.
          </div>
        )}

        {/* Empty state — scoped per subpage / query */}
        {showEmptyState && (
          <div className="h-7 px-1.5 mx-1 flex items-center text-xs text-muted-foreground">
            {(() => {
              const noun = showingBriefingsList
                ? 'briefings'
                : showingSkillsList
                  ? 'skills'
                  : showingAgentsList
                    ? 'agents'
                    : showingToolsList
                      ? 'tools'
                      : 'files';
              return debouncedSearchText
                ? `No ${noun} matching "${debouncedSearchText}"`
                : `No ${noun} found`;
            })()}
          </div>
        )}

        {/* Options list — not blocked by unrelated file `isLoading`; briefings error uses row above */}
        {showMainList && (
          <>
            {/* Flat list sorted by relevance */}

            {showInlineRootFileError && (
              <div className="px-2.5 py-1 mx-1 text-[10px] text-muted-foreground/90 leading-snug">
                Could not load files — other results may be incomplete.
              </div>
            )}

            {/* Header - only show in subpages or when searching, not in root view */}
            {(isInSubpage || debouncedSearchText) && (
              <div className="px-2.5 py-1.5 mx-1 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <span>
                  {showingFilesList || hasOnlyFiles
                    ? 'Files & Folders'
                    : showingSkillsList
                      ? 'Skills'
                      : showingAgentsList
                        ? 'Agents'
                        : showingToolsList
                          ? 'MCP Tools'
                          : showingBriefingsList
                            ? 'Briefings'
                            : 'Results'}
                </span>
                {showHeaderSpinner && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
              </div>
            )}
            {options.map((option, index) => {
              const isSelected = selectedIndex === index;
              // biome-ignore lint/style/useNamingConvention: component type variable
              const OptionIcon = getOptionIcon(option);
              const isCategory = option.type === 'category';
              const showTooltip = !isCategory && option.path;

              const itemContent = (
                <div
                  data-option-index={index}
                  onClick={() => onSelect(option)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(option);
                    }
                  }}
                  onMouseEnter={() => {
                    setHoverIndex(index);
                    setSelectedIndex(index);
                  }}
                  onMouseLeave={() => {
                    setHoverIndex((prev) => (prev === index ? null : prev));
                  }}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  className={cn(
                    'group inline-flex w-[calc(100%-8px)] mx-1 items-center whitespace-nowrap outline-hidden',
                    'h-7 px-1.5 justify-start text-xs rounded-md',
                    'transition-colors cursor-pointer select-none gap-1.5',
                    'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring',
                    isSelected
                      ? 'dark:bg-neutral-800 bg-accent text-foreground'
                      : 'text-muted-foreground dark:hover:bg-neutral-800 hover:bg-accent hover:text-foreground',
                  )}
                >
                  <OptionIcon className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="flex items-center gap-1 w-full min-w-0">
                    <span className={cn('shrink-0 whitespace-nowrap', isCategory && 'font-medium')}>
                      {option.label}
                    </span>
                    {/* Diff stats for changed files */}
                    {(option.additions || option.deletions) && (
                      <span className="shrink-0 flex items-center gap-1 text-[10px] font-mono">
                        {option.additions ? (
                          <span className="text-green-500">+{option.additions}</span>
                        ) : null}
                        {option.deletions ? (
                          <span className="text-red-500">-{option.deletions}</span>
                        ) : null}
                      </span>
                    )}
                    {/* Show truncated path for files only, not for skills/agents (they show in tooltip) */}
                    {option.truncatedPath &&
                      !isCategory &&
                      option.type !== 'skill' &&
                      option.type !== 'agent' && (
                        <span
                          className="text-muted-foreground flex-1 min-w-0 ml-2 font-mono overflow-hidden text-[10px]"
                          style={{
                            direction: 'rtl',
                            textAlign: 'left',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <span style={{ direction: 'ltr' }}>{option.truncatedPath}</span>
                        </span>
                      )}
                  </span>
                  {/* ChevronRight for category items (navigate to subpage) */}
                  {isCategory && (
                    <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                </div>
              );

              if (showTooltip) {
                return (
                  <Tooltip key={option.id} open={isSelected}>
                    <TooltipTrigger asChild>{itemContent}</TooltipTrigger>
                    <TooltipContent
                      side="left"
                      align="start"
                      sideOffset={8}
                      collisionPadding={16}
                      avoidCollisions
                      className="overflow-hidden"
                    >
                      {renderTooltipContent(option)}
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return <div key={option.id}>{itemContent}</div>;
            })}
          </>
        )}
      </div>
    </TooltipProvider>,
    document.body,
  );
});
