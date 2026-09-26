import * as React from 'react';
import { toast } from 'sonner';

/** Drag types used by IDEs (Cursor/VSCode) instead of standard "Files" */
const IDE_FILE_DRAG_TYPES = ['resourceurls', 'codefiles', 'text/uri-list'];

const REGEX_ABSOLUTE_WIN = /^[A-Za-z]:[/\\]/;
const REGEX_FILE_URI_PREFIX = /^file:\/\/\/?/;
const REGEX_FILE_URI_LOCALHOST = /^localhost\/?/i;
const REGEX_NEWLINE = /\r?\n/;

function isFileDropAllowed(types: readonly string[]): boolean {
  const t = Array.from(types);
  return t.includes('Files') || IDE_FILE_DRAG_TYPES.some((k) => t.includes(k));
}

/** True if path is already absolute (Unix / or Windows C:\ or C:/). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || REGEX_ABSOLUTE_WIN.test(p);
}

/** Convert a single file:// URL or path string to an absolute filesystem path. */
export function fileUriOrPathToPath(entry: string): string {
  const s = entry.trim();
  if (s.startsWith('file://')) {
    let pathPart = s.replace(REGEX_FILE_URI_PREFIX, '').replace(REGEX_FILE_URI_LOCALHOST, '');
    if (pathPart && !isAbsolutePath(pathPart)) {
      pathPart = `/${pathPart}`;
    }
    try {
      return decodeURIComponent(pathPart);
    } catch {
      return pathPart;
    }
  }
  return s;
}

/**
 * Parse file paths from getData() when source uses URI list (e.g. Cursor/VSCode).
 * Handles: JSON array of file:// URLs, newline-separated file:// URLs, or plain paths.
 */
export function parseFilePathsFromDataTransfer(dt: DataTransfer): string[] {
  const tried = ['text/uri-list', 'resourceurls', 'codefiles', 'text/plain'];
  for (const type of tried) {
    try {
      const raw = dt.getData(type);
      if (!raw?.trim()) continue;
      const paths: string[] = [];

      if (raw.trimStart().startsWith('[')) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === 'string') {
              const p = fileUriOrPathToPath(entry);
              if (p) paths.push(p);
            }
          }
        }
      } else {
        const lines = raw
          .split(REGEX_NEWLINE)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const line of lines) {
          const trimmed = line.trim();
          // Only accept file:// URIs or strict absolute paths to avoid clipboard poisoning
          if (
            trimmed.startsWith('file://') ||
            trimmed.startsWith('/') ||
            REGEX_ABSOLUTE_WIN.test(trimmed)
          ) {
            const p = fileUriOrPathToPath(trimmed);
            if (p) paths.push(p);
          }
        }
      }
      if (paths.length > 0) return paths;
    } catch {}
  }
  return [];
}

/** Get filesystem paths from clipboard (Files API or URI list). Used by hook onPaste; re-export when window-level paste is re-enabled. */
export function getExternalFilePathsFromClipboard(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const files = Array.from(dt.files ?? []);
  const webUtils = (window as Window & { webUtils?: { getPathForFile?: (f: File) => string } })
    .webUtils;
  let paths = files.map((f) => webUtils?.getPathForFile?.(f) ?? '').filter(Boolean);
  if (paths.length === 0) paths = parseFilePathsFromDataTransfer(dt);
  return paths;
}

/**
 * Resolve the drop target folder path from the element under the given point.
 * Uses data-tree-path / data-tree-type on tree nodes and data-drop-target="root" on the container.
 */
function resolveDropTargetFolder(
  clientX: number,
  clientY: number,
  _treeContainerRef: React.RefObject<HTMLElement | null>,
): string {
  const elements = document.elementsFromPoint(clientX, clientY);
  for (const el of elements) {
    const path = (el as HTMLElement).dataset?.treePath;
    const type = (el as HTMLElement).dataset?.treeType;
    const dropTarget = (el as HTMLElement).dataset?.dropTarget;

    if (dropTarget === 'root') return '';
    if (path !== undefined) {
      if (type === 'folder') return path;
      if (type === 'file') return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    }
  }
  return '';
}

type UseExternalFileDropOptions = {
  projectPath: string;
  treeContainerRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  copyExternalFilesMutate: (input: {
    sourcePaths: string[];
    projectPath: string;
    destinationFolder: string;
    resolution?: 'overwrite' | 'skip' | 'keepBoth';
  }) => void;
  /** For paste: return the folder path where pasted files should go (e.g. from selection). */
  getDestinationFolder?: () => string;
};

/**
 * Hook for native HTML5 drag-and-drop of external files (Finder, VSCode, etc.) into the file tree.
 * Uses webUtils.getPathForFile (Electron) to get OS paths and calls copyExternalFiles in main process.
 */
export function useExternalFileDrop({
  projectPath,
  treeContainerRef,
  enabled,
  copyExternalFilesMutate,
  getDestinationFolder,
}: UseExternalFileDropOptions): {
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  isDragOver: boolean;
} {
  const [isDragOver, setIsDragOver] = React.useState(false);

  const onDragOver = React.useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !isFileDropAllowed(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsDragOver(true);
    },
    [enabled],
  );

  const onDragLeave = React.useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      setIsDragOver(false);
      if (!enabled || !projectPath) return;
      e.preventDefault();

      const files = Array.from(e.dataTransfer.files);
      const webUtils = (window as Window & { webUtils?: { getPathForFile?: (f: File) => string } })
        .webUtils;
      let sourcePaths = files.map((f) => webUtils?.getPathForFile?.(f) ?? '').filter(Boolean);
      if (sourcePaths.length === 0) {
        sourcePaths = parseFilePathsFromDataTransfer(e.dataTransfer);
      }
      const destinationFolder = resolveDropTargetFolder(e.clientX, e.clientY, treeContainerRef);

      if (sourcePaths.length === 0) {
        toast.warning(
          'Could not get file paths for drop. Try dropping from Finder or your file manager.',
        );
        return;
      }

      copyExternalFilesMutate({
        sourcePaths,
        projectPath,
        destinationFolder,
        resolution: 'keepBoth',
      });
    },
    [enabled, projectPath, treeContainerRef, copyExternalFilesMutate],
  );

  const onPaste = React.useCallback(
    (e: React.ClipboardEvent) => {
      if (!enabled || !projectPath) return;
      const sourcePaths = getExternalFilePathsFromClipboard(e.clipboardData);
      if (sourcePaths.length === 0) return;
      e.preventDefault();
      const destinationFolder = getDestinationFolder?.() ?? '';
      copyExternalFilesMutate({
        sourcePaths,
        projectPath,
        destinationFolder,
        resolution: 'keepBoth',
      });
    },
    [enabled, projectPath, getDestinationFolder, copyExternalFilesMutate],
  );

  return { onDragOver, onDrop, onDragLeave, onPaste, isDragOver };
}
