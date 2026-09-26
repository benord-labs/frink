/* eslint-disable max-lines, max-lines-per-function */
import { atom } from 'jotai';
import { atomFamily, atomWithStorage } from 'jotai/utils';
import type { CodeSelectionContext } from '@/features/agents/lib/queue-utils';
import { detectLanguage } from '../../../../shared/detect-language';
import { isWindowsAbsolutePath } from '../../../../shared/lib/path-normalization';

export { isImagePath } from '../../../../shared/image-extensions';
export { isMarkdownPath } from '../../../../shared/markdown-extensions';

import { normalizePathForComparison } from '@/features/files-sidebar/utils/resolve-effective-project-path';
import { isPdfPath } from '../../../../shared/pdf-extensions';
import { registerChatScopedFamily } from '../../atoms/atom-family-factory';
import {
  type CodeEditorLayout,
  type LegacyCodeEditorLayout,
  normalizeCodeEditorLayout,
} from './layout-cycle';

export { isPdfPath } from '../../../../shared/pdf-extensions';

// Type for an open file tab
export type OpenFile = {
  /** Absolute file path */
  path: string;
  /** File name for display */
  name: string;
  /** File content (loaded on demand) */
  content?: string;
  /** Whether file has unsaved changes */
  isDirty?: boolean;
  /** Language for syntax highlighting */
  language?: string;
  /** True if loading content failed (so we don't show Loading... forever) */
  loadError?: boolean;
  /** Error message when load failed (e.g. "Image too large to display (max 20MB)") */
  loadErrorMessage?: string;
  /** Project path this file was opened from (for pane association) */
  projectPath?: string;
  /** Pane index (0-based) the file was opened from in split view */
  sourcePaneIndex?: number;
  /** Chat ID the file was opened from */
  sourceChatId?: string;
  /** True when this tab was opened from a worktree-scoped file context */
  isWorktreeContext?: boolean;
  /** VS Code-like preview tab (italic, replaced by next preview open in same pane) */
  isPreview?: boolean;
};

type OpenFileIntent = 'preview' | 'pinned';

/** Input for opening a file with optional pane context */
type OpenFileInput = {
  path: string;
  name: string;
  content?: string;
  /** Monaco language id; defaults from file path */
  language?: string;
  /** Project path for pane association (split view) */
  projectPath?: string;
  /** Pane index for color-coding (split view) */
  sourcePaneIndex?: number;
  /** Chat ID for tracking which chat opened the file */
  sourceChatId?: string;
  /** True when opening from a worktree-scoped file context */
  isWorktreeContext?: boolean;
  /** Open intent: preview tabs are reused/replaced, pinned tabs persist */
  intent?: OpenFileIntent;
};

// Code editor panel open state
export const codeEditorOpenAtom = atom<boolean>(false);

// Code editor maximized state (externally settable so callers can open files fullscreen)
export const codeEditorMaximizedAtom = atom<boolean>(false);

/** Per-chat: code selection from Monaco for this chat's input context (each pane has its own) */
export const codeSelectionContextAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<CodeSelectionContext | null>(null)),
);

/** Which chat id should receive the next code selection from the editor (set by layout; null = e.g. new-chat pane) */
export const codeEditorActiveChatIdAtom = atom<string | null>(null);

// ---- Per-chat context file tracking ----
// Each chat panel tracks which file it last opened (for context indicator in chat input).
//
// Intentional UX: context persists per-chat across chat switches. When the user
// opens a file from Chat A's tree, that file stays as Chat A's context even after
// switching to Chat B and back. This matches the mental model of "I opened that
// file from this chat" and avoids losing context on accidental tab switches.
// The dismiss state (`chatContextFileDismissedAtomFamily`) resets when the file
// path changes, so stale dismissals don't carry over if a new file is opened.

/** Per-chat: the file that was last opened from this chat's file tree */
export const chatContextFileAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<{ name: string; path: string } | null>(null)),
);

/** Per-chat: whether the user dismissed the active file from context */
export const chatContextFileDismissedAtomFamily = registerChatScopedFamily(
  atomFamily((_chatId: string) => atom<boolean>(false)),
);

// List of open files (tabs)
export const openFilesAtom = atom<OpenFile[]>([]);

// Path of the currently active/focused file
export const activeFilePathAtom = atom<string | null>(null);

// Persisted preference for showing Monaco inline diff view when available.
export const diffModePreferenceAtom = atomWithStorage<boolean>(
  'code-editor-diff-mode',
  true,
  undefined,
  { getOnInit: true },
);

// Code editor panel height (percentage of viewport)
export const codeEditorHeightAtom = atomWithStorage<number>(
  'code-editor-height',
  60, // Default 60% height
  undefined,
  { getOnInit: true },
);

type PersistedCodeEditorLayout = CodeEditorLayout | LegacyCodeEditorLayout;

const codeEditorLayoutStorageAtom = atomWithStorage<PersistedCodeEditorLayout>(
  'code-editor-layout',
  'top',
  undefined,
  { getOnInit: true },
);

// Layout mode: top (above chats), left, or right (beside chats)
export const codeEditorLayoutAtom = atom(
  (get): CodeEditorLayout => normalizeCodeEditorLayout(get(codeEditorLayoutStorageAtom)),
  (get, set, update: CodeEditorLayout | ((prev: CodeEditorLayout) => CodeEditorLayout)) => {
    const current = normalizeCodeEditorLayout(get(codeEditorLayoutStorageAtom));
    const next = typeof update === 'function' ? update(current) : update;
    set(codeEditorLayoutStorageAtom, next);
  },
);

// Code editor panel width (percentage of viewport) for left/right layouts
export const codeEditorWidthAtom = atomWithStorage<number>(
  'code-editor-width',
  50, // Default 50% width
  undefined,
  { getOnInit: true },
);

// Derived atom: get the active file object
// activeFilePathAtom stores a composite key (projectPath:path or just path)
export const activeFileAtom = atom((get) => {
  const files = get(openFilesAtom);
  const activeKey = get(activeFilePathAtom);
  if (!activeKey) return null;
  return files.find((f) => fileKey(f.path, f.projectPath) === activeKey) ?? null;
});

/**
 * Build a unique key for an open file tab.
 * In split view, two projects can have files with the same relative path
 * (e.g. `src/index.ts`). Keying by `projectPath + ':' + relativePath` avoids
 * collisions while keeping backwards compat for single-pane mode.
 */
export function fileKey(path: string, projectPath?: string): string {
  return projectPath ? `${projectPath}:${path}` : path;
}

const LEADING_SLASHES_REGEX = /^\/+/;

function isWindowsNormalizedAbsolutePath(value: string): boolean {
  return isWindowsAbsolutePath(value) || value.startsWith('//');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || isWindowsNormalizedAbsolutePath(value);
}

function canonicalizeRelativePath(path: string): string {
  return path.replace(LEADING_SLASHES_REGEX, '');
}

function toAbsoluteComparablePath(path: string, projectPath?: string): string | null {
  const normalizedPath = normalizePathForComparison(path) ?? path;
  if (isAbsolutePath(normalizedPath)) {
    return normalizedPath;
  }
  const normalizedProjectPath = normalizePathForComparison(projectPath);
  if (!normalizedProjectPath) {
    return null;
  }
  return `${normalizedProjectPath}/${canonicalizeRelativePath(normalizedPath)}`;
}

function getCanonicalComparablePath(path: string, projectPath?: string): string {
  const normalizedPath = normalizePathForComparison(path) ?? path;
  const normalizedProjectPath = normalizePathForComparison(projectPath);
  if (!normalizedProjectPath) {
    return normalizedPath;
  }
  if (!isAbsolutePath(normalizedPath)) {
    return canonicalizeRelativePath(normalizedPath);
  }
  if (normalizedPath.startsWith(`${normalizedProjectPath}/`)) {
    return canonicalizeRelativePath(normalizedPath.slice(normalizedProjectPath.length + 1));
  }
  return normalizedPath;
}

function areCanonicalPathsEquivalent(
  leftPath: string,
  leftProjectPath: string | undefined,
  rightPath: string,
  rightProjectPath: string | undefined,
): boolean {
  const leftAbsolute = toAbsoluteComparablePath(leftPath, leftProjectPath);
  const rightAbsolute = toAbsoluteComparablePath(rightPath, rightProjectPath);
  if (leftAbsolute && rightAbsolute && leftAbsolute === rightAbsolute) {
    return true;
  }

  const leftProject = normalizePathForComparison(leftProjectPath);
  const rightProject = normalizePathForComparison(rightProjectPath);
  if (leftProject !== rightProject) {
    return false;
  }
  return (
    getCanonicalComparablePath(leftPath, leftProjectPath) ===
    getCanonicalComparablePath(rightPath, rightProjectPath)
  );
}

/** Find a file in the open files list, accounting for project-scoped keys */
function findOpenFile(files: OpenFile[], path: string, projectPath?: string): OpenFile | undefined {
  const key = fileKey(path, projectPath);
  const exact = files.find((f) => fileKey(f.path, f.projectPath) === key);
  if (exact) return exact;
  const canonical = files.find((f) =>
    areCanonicalPathsEquivalent(f.path, f.projectPath, path, projectPath),
  );
  if (canonical) {
    return canonical;
  }
  // First try exact composite match, then fall back to path-only (legacy tabs)
  return files.find((f) => f.path === path && !f.projectPath && !projectPath);
}

/** Find the current preview tab to replace for this pane/editor group. */
function findPreviewTabForGroup(
  files: OpenFile[],
  sourcePaneIndex: number | undefined,
): OpenFile | undefined {
  return files.find((f) => f.isPreview && f.sourcePaneIndex === sourcePaneIndex);
}

// Action atom: open a file (add to tabs if not already open, set as active)
export const openFileAtom = atom(null, (get, set, file: OpenFileInput) => {
  const files = get(openFilesAtom);
  const openIntent: OpenFileIntent = file.intent ?? 'preview';
  const existing = findOpenFile(files, file.path, file.projectPath);
  const nextKey = fileKey(file.path, file.projectPath);

  if (existing) {
    const existingKey = fileKey(existing.path, existing.projectPath);
    const mergedProjectPath = file.projectPath ?? existing.projectPath;
    const mergedIsWorktree = existing.isWorktreeContext || file.isWorktreeContext;
    set(
      openFilesAtom,
      files.map((f) => {
        if (fileKey(f.path, f.projectPath) !== existingKey) return f;
        return {
          ...f,
          ...(file.language !== undefined ? { language: file.language } : {}),
          projectPath: mergedProjectPath,
          sourcePaneIndex:
            file.sourcePaneIndex !== undefined ? file.sourcePaneIndex : f.sourcePaneIndex,
          sourceChatId: file.sourceChatId ?? f.sourceChatId,
          isWorktreeContext: mergedIsWorktree,
          isPreview: openIntent === 'preview' ? f.isPreview : false,
        };
      }),
    );
    set(activeFilePathAtom, fileKey(existing.path, mergedProjectPath));
    set(codeEditorOpenAtom, true);
    return;
  } else if (
    openIntent === 'preview' &&
    findPreviewTabForGroup(files, file.sourcePaneIndex) !== undefined
  ) {
    // Replace the existing preview tab in this editor group (pane-aware).
    const previewToReplace = findPreviewTabForGroup(files, file.sourcePaneIndex);
    const previewKey = previewToReplace
      ? fileKey(previewToReplace.path, previewToReplace.projectPath)
      : null;
    const language = file.language ?? detectLanguage(file.path, EXTENSION_TO_LANGUAGE);
    if (previewToReplace) revokePdfBlobIfPresent(previewToReplace);
    set(
      openFilesAtom,
      files.map((f) =>
        fileKey(f.path, f.projectPath) === previewKey
          ? {
              path: file.path,
              name: file.name,
              content: file.content,
              isDirty: false,
              language,
              loadError: false,
              loadErrorMessage: undefined,
              projectPath: file.projectPath,
              sourcePaneIndex: file.sourcePaneIndex,
              sourceChatId: file.sourceChatId,
              isWorktreeContext: file.isWorktreeContext,
              isPreview: true,
            }
          : f,
      ),
    );
  } else {
    // Add a new tab with pane context.
    const {
      projectPath,
      sourcePaneIndex,
      sourceChatId,
      isWorktreeContext,
      intent: _,
      language: languageOverride,
      ...rest
    } = file;
    const language = languageOverride ?? detectLanguage(file.path, EXTENSION_TO_LANGUAGE);
    set(openFilesAtom, [
      ...files,
      {
        ...rest,
        language,
        projectPath,
        sourcePaneIndex,
        sourceChatId,
        isWorktreeContext,
        isPreview: openIntent === 'preview',
      },
    ]);
  }

  // Set as active (use composite key for unique identity)
  set(activeFilePathAtom, nextKey);

  // Open the panel if not already open
  set(codeEditorOpenAtom, true);
});

// Revoke blob URL if present (shared by image/pdf lifecycle cleanup paths)
export function revokeBlobUrlIfPresent(content: string | undefined): void {
  if (typeof content === 'string' && content.startsWith('blob:')) {
    URL.revokeObjectURL(content);
  }
}

// Revoke PDF blob URL for a file if present (avoids leaks when closing via any path)
export function revokePdfBlobIfPresent(file: { path: string; content?: string }): void {
  if (isPdfPath(file.path)) {
    revokeBlobUrlIfPresent(file.content);
  }
}

// Action atom: close a file (accepts composite key from fileKey)
export const closeFileAtom = atom(null, (get, set, key: string) => {
  const files = get(openFilesAtom);
  const activeKey = get(activeFilePathAtom);
  const closedFile = files.find((f) => fileKey(f.path, f.projectPath) === key);
  const newFiles = files.filter((f) => fileKey(f.path, f.projectPath) !== key);

  if (closedFile) revokePdfBlobIfPresent(closedFile);
  set(openFilesAtom, newFiles);

  // If we closed the active file, prefer a tab from the same pane
  if (activeKey === key) {
    if (newFiles.length > 0) {
      const samePaneFiles =
        closedFile?.sourcePaneIndex !== undefined
          ? newFiles.filter((f) => f.sourcePaneIndex === closedFile.sourcePaneIndex)
          : [];
      const next =
        samePaneFiles.length > 0
          ? samePaneFiles[samePaneFiles.length - 1]
          : newFiles[newFiles.length - 1];
      set(activeFilePathAtom, fileKey(next.path, next.projectPath));
    } else {
      set(activeFilePathAtom, null);
    }
  }

  // Close panel if no files left
  if (newFiles.length === 0) {
    set(codeEditorOpenAtom, false);
  }
});

// Action atom: update file content (key = composite fileKey)
export const updateFileContentAtom = atom(
  null,
  (get, set, { key, content }: { key: string; content: string }) => {
    const files = get(openFilesAtom);
    set(
      openFilesAtom,
      files.map((f) =>
        fileKey(f.path, f.projectPath) === key
          ? { ...f, content, isDirty: true, isPreview: false }
          : f,
      ),
    );
  },
);

// Action atom: mark file as saved (key = composite fileKey)
export const markFileSavedAtom = atom(null, (get, set, key: string) => {
  const files = get(openFilesAtom);
  set(
    openFilesAtom,
    files.map((f) =>
      fileKey(f.path, f.projectPath) === key ? { ...f, isDirty: false, isPreview: false } : f,
    ),
  );
});

// Action atom: pin a preview tab without changing dirty/content state.
export const pinFileAtom = atom(null, (get, set, key: string) => {
  const files = get(openFilesAtom);
  set(
    openFilesAtom,
    files.map((f) => (fileKey(f.path, f.projectPath) === key ? { ...f, isPreview: false } : f)),
  );
});

/** Per-chat: clear this chat's code selection context (e.g. on send or dismiss) */
export const clearCodeSelectionContextAtomFamily = registerChatScopedFamily(
  atomFamily((chatId: string) =>
    atom(null, (_get, set) => set(codeSelectionContextAtomFamily(chatId), null)),
  ),
);

// ---- Split view pane awareness ----

/** The currently active split pane index (synced from split view state) */
export const editorActivePaneIndexAtom = atom<number | null>(null);

/** Whether the editor is in split view mode (multiple panes visible) */
export const editorIsSplitActiveAtom = atom<boolean>(false);

/** Map of pane index → last active file key (composite, for auto-focus on pane switch) */
export const lastActiveTabPerPaneAtom = atom<Record<number, string>>({});

/** Action: record which tab was last active for a given pane (key = composite fileKey) */
export const trackPaneTabAtom = atom(
  null,
  (get, set, { paneIndex, key }: { paneIndex: number; key: string }) => {
    const current = get(lastActiveTabPerPaneAtom);
    if (current[paneIndex] === key) return;
    set(lastActiveTabPerPaneAtom, { ...current, [paneIndex]: key });
  },
);

/**
 * Action: retroactively tag open files with pane context when split view activates.
 * Accepts a map of projectPath → paneIndex. Files whose `projectPath` matches
 * get their `sourcePaneIndex` set (if not already set or if stale).
 * Files whose projectPath matches a pane also get `sourceChatId` set if provided.
 */
export const tagOpenFilesWithPaneContextAtom = atom(
  null,
  (get, set, paneMap: Array<{ projectPath: string; paneIndex: number; chatId?: string }>) => {
    const files = get(openFilesAtom);
    let changed = false;
    const updated = files.map((f) => {
      if (!f.projectPath) return f;
      const match = paneMap.find((p) => p.projectPath === f.projectPath);
      if (!match) return f;
      // Skip if already correctly tagged
      if (f.sourcePaneIndex === match.paneIndex) return f;
      changed = true;
      return {
        ...f,
        sourcePaneIndex: match.paneIndex,
        sourceChatId: match.chatId ?? f.sourceChatId,
        // Re-tagging into split panes should not keep transient preview semantics.
        isPreview: false,
      };
    });
    if (changed) {
      set(openFilesAtom, updated);
    }
  },
);

/**
 * Action: clear pane metadata (sourcePaneIndex) from all open files.
 * Called when exiting split view to prevent stale pane colors on re-entry.
 * Keeps sourceChatId so AI-origin context survives layout transitions.
 */
export const clearPaneContextAtom = atom(null, (get, set) => {
  const files = get(openFilesAtom);
  if (files.length === 0) return;
  // Keep isWorktreeContext as immutable origin metadata; split cleanup only removes pane linkage.
  const needsUpdate = files.some((f) => f.sourcePaneIndex !== undefined);
  if (!needsUpdate) return;
  set(
    openFilesAtom,
    files.map((f) => {
      if (f.sourcePaneIndex === undefined) return f;
      const { sourcePaneIndex: _, ...rest } = f;
      return rest;
    }),
  );
});

/**
 * Action: close editor tabs for a closed pane, unless another remaining pane
 * shares the same project. Keeps the tab bar tidy after pane removal.
 *
 * Legacy tabs (opened before split view, so missing `projectPath`) that were
 * retroactively tagged with `sourcePaneIndex` are intentionally closed here.
 * They have no project association to "survive" the pane removal, and keeping
 * them would leave orphan tabs with stale pane colors.
 */
export const closePaneTabsAtom = atom(
  null,
  (
    get,
    set,
    {
      closedPaneIndex,
      remainingProjectPaths,
    }: { closedPaneIndex: number; remainingProjectPaths: string[] },
  ) => {
    const files = get(openFilesAtom);
    if (files.length === 0) return;

    const remainingProjects = new Set(remainingProjectPaths);

    // Keep files that don't belong to the closed pane, or whose project
    // is still represented by another remaining pane.
    // Note: legacy tabs without projectPath that match the closed pane are
    // dropped — see JSDoc above for rationale.
    const kept = files.filter((f) => {
      if (f.sourcePaneIndex !== closedPaneIndex) return true;
      return f.projectPath !== undefined && remainingProjects.has(f.projectPath);
    });

    if (kept.length === files.length) return;

    const keptKeys = new Set(kept.map((f) => fileKey(f.path, f.projectPath)));
    files.forEach((f) => {
      if (!keptKeys.has(fileKey(f.path, f.projectPath))) revokePdfBlobIfPresent(f);
    });

    // Shift sourcePaneIndex on remaining files: indices above the removed pane move down
    const shifted = kept.map((f) => {
      if (f.sourcePaneIndex !== undefined && f.sourcePaneIndex > closedPaneIndex) {
        return { ...f, sourcePaneIndex: f.sourcePaneIndex - 1 };
      }
      return f;
    });

    set(openFilesAtom, shifted);

    const activeKey = get(activeFilePathAtom);
    const activeStillOpen = kept.some((f) => fileKey(f.path, f.projectPath) === activeKey);
    if (!activeStillOpen) {
      const first = kept[0];
      set(activeFilePathAtom, first ? fileKey(first.path, first.projectPath) : null);
      if (kept.length === 0) {
        set(codeEditorOpenAtom, false);
      }
    }
  },
);

/**
 * Whether to filter tabs to active pane only (persisted across reloads).
 *
 * Persistence is mainly useful for mid-session reloads while split view is
 * active. On split view exit, `agents-content.tsx` resets this to `false`,
 * so the saved value only survives a window refresh — not cross-session.
 */
export const filterTabsToActivePaneAtom = atomWithStorage<boolean>(
  'code-editor-filter-to-active-pane',
  false,
  undefined,
  { getOnInit: true },
);

// Action atom: close all files not belonging to a project path
// Security: prevents accidentally editing files from wrong project
export const closeFilesOutsideProjectAtom = atom(null, (get, set, projectPath: string | null) => {
  const files = get(openFilesAtom);

  // Early return if no files are open (most common case)
  if (files.length === 0) {
    return;
  }

  if (!projectPath) {
    // No project selected - close all files
    files.forEach(revokePdfBlobIfPresent);
    set(openFilesAtom, []);
    set(activeFilePathAtom, null);
    set(codeEditorOpenAtom, false);
    return;
  }

  // Filter files: keep only those belonging to this project.
  // Files store relative paths, so compare via the projectPath metadata
  // (set when file is opened from a pane/sidebar). Falls back to the legacy
  // absolute-path prefix check for any files opened before pane awareness.
  const normalizedProjectPath = normalizePathForComparison(projectPath);
  const normalizedProjectPrefix = normalizedProjectPath ? `${normalizedProjectPath}/` : '';
  const filesInProject = files.filter((f) => {
    const normalizedFileProjectPath = normalizePathForComparison(f.projectPath);
    const normalizedFilePath = normalizePathForComparison(f.path) ?? '';
    return (
      normalizedFileProjectPath === normalizedProjectPath ||
      normalizedFilePath.startsWith(normalizedProjectPrefix)
    );
  });

  const projectKeys = new Set(filesInProject.map((f) => fileKey(f.path, f.projectPath)));
  files.forEach((f) => {
    if (!projectKeys.has(fileKey(f.path, f.projectPath))) revokePdfBlobIfPresent(f);
  });
  // If files were removed, update state
  if (filesInProject.length !== files.length) {
    set(openFilesAtom, filesInProject);

    const activeKey = get(activeFilePathAtom);
    const activeFileStillOpen = filesInProject.some(
      (f) => fileKey(f.path, f.projectPath) === activeKey,
    );

    // If active file was closed, switch to first remaining file
    if (!activeFileStillOpen) {
      const first = filesInProject[0];
      set(activeFilePathAtom, first ? fileKey(first.path, first.projectPath) : null);
    }

    // Close panel if no files left
    if (filesInProject.length === 0) {
      set(codeEditorOpenAtom, false);
    }
  }
});

// Extension → Monaco language ID. Covers all Monaco basic/rich languages for offline use.
// @see monaco-editor/esm/vs/basic-languages */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Data / config
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  cfg: 'ini',
  conf: 'ini',
  // Markup / styles
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  xaml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sass: 'scss',
  // General purpose
  py: 'python',
  pyw: 'python',
  rpy: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  csx: 'csharp',
  php: 'php',
  phtml: 'php',
  sql: 'sql',
  mysql: 'mysql',
  pgsql: 'pgsql',
  // Shell / scripts
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  // Containers / config
  dockerfile: 'dockerfile',
  gql: 'graphql',
  graphql: 'graphql',
  proto: 'proto',
  // Web / template
  hbs: 'handlebars',
  handlebars: 'handlebars',
  mustache: 'handlebars',
  pug: 'pug',
  jade: 'pug',
  twig: 'twig',
  razor: 'razor',
  cshtml: 'razor',
  // Other languages Monaco supports
  lua: 'lua',
  r: 'r',
  rmd: 'r',
  scala: 'scala',
  sc: 'scala',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  coffee: 'coffeescript',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  fsscript: 'fsharp',
  vb: 'vb',
  vbs: 'vb',
  pl: 'perl',
  pm: 'perl',
  t: 'perl',
  julia: 'julia',
  jl: 'julia',
  hcl: 'hcl',
  tf: 'hcl',
  tfvars: 'hcl',
  bicep: 'bicep',
  redis: 'redis',
  cypher: 'cypher',
  sparql: 'sparql',
  rq: 'sparql',
  sol: 'sol',
  prisma: 'plaintext',
  restructuredtext: 'restructuredtext',
  rst: 'restructuredtext',
  lexon: 'lexon',
  liquid: 'liquid',
  freemarker: 'freemarker2',
  ftl: 'freemarker2',
  ftlh: 'freemarker2',
  m3: 'm3',
  pascal: 'pascal',
  pp: 'pascal',
  pas: 'pascal',
  powerquery: 'powerquery',
  pq: 'powerquery',
  qsharp: 'qsharp',
  qs: 'qsharp',
  redshift: 'redshift',
  sb: 'sb',
  scheme: 'scheme',
  scm: 'scheme',
  ss: 'scheme',
  st: 'st',
  tcl: 'tcl',
  typespec: 'typespec',
  tsp: 'typespec',
  wgsl: 'wgsl',
  azcli: 'azcli',
  apex: 'apex',
  cls: 'apex',
  trigger: 'apex',
  abap: 'abap',
  cameligo: 'cameligo',
  csp: 'csp',
  ecl: 'ecl',
  flow9: 'flow9',
  mips: 'mips',
  msdax: 'msdax',
  pla: 'pla',
  pascaligo: 'pascaligo',
  postiats: 'postiats',
  dats: 'postiats',
  sats: 'postiats',
  hats: 'postiats',
  systemverilog: 'systemverilog',
  sv: 'systemverilog',
  svh: 'systemverilog',
  v: 'verilog',
  vh: 'verilog',
  gitignore: 'ini',
};
