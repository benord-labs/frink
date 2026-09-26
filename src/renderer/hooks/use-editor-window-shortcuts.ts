import type { editor as MonacoEditor } from 'monaco-editor';
import { type RefObject, useEffect, useRef } from 'react';
import { fileKey, type OpenFile } from '@/lib/code-editor/state';

type EditorWindowShortcutsArgs = {
  /** Currently visible (possibly pane-filtered) tabs, in display order. */
  visibleFiles: OpenFile[];
  /** Composite key of the active tab (from `fileKey`). */
  activePath: string | null;
  setActivePath: (key: string) => void;
  editorRef: RefObject<MonacoEditor.IStandaloneCodeEditor | null>;
  /** Whether the editor panel is open (guards the find shortcut). */
  isOpen: boolean;
};

/**
 * Wire global editor window shortcuts dispatched by the app's hotkey router:
 * - `editor:cycle-pane-group` — cycle tabs forward/back (detail = +1 / -1)
 * - `editor:find` — open Monaco's find widget
 *
 * Volatile values (visibleFiles, activePath) are tracked via refs so the
 * listener subscriptions stay stable and don't re-bind on every tab switch.
 */
export function useEditorWindowShortcuts({
  visibleFiles,
  activePath,
  setActivePath,
  editorRef,
  isOpen,
}: EditorWindowShortcutsArgs): void {
  const visibleFilesRef = useRef(visibleFiles);
  visibleFilesRef.current = visibleFiles;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // Cycle through tabs via Cmd+Shift+]/[ (dispatched as a custom event).
  useEffect(() => {
    const handler = (e: Event) => {
      const direction = (e as CustomEvent<number>).detail; // +1 or -1
      const visible = visibleFilesRef.current;
      if (visible.length <= 1) return;
      const currentIdx = visible.findIndex(
        (f) => fileKey(f.path, f.projectPath) === activePathRef.current,
      );
      if (currentIdx === -1) return;
      const nextIdx = (currentIdx + direction + visible.length) % visible.length;
      const nextFile = visible[nextIdx];
      if (nextFile) {
        setActivePath(fileKey(nextFile.path, nextFile.projectPath));
      }
    };
    window.addEventListener('editor:cycle-pane-group', handler);
    return () => window.removeEventListener('editor:cycle-pane-group', handler);
  }, [setActivePath]);

  // Open Monaco's find widget from global shortcut routing when editor is active.
  useEffect(() => {
    const handleEditorFind = () => {
      if (!isOpen) return;
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.trigger('keyboard', 'actions.find', null);
    };
    window.addEventListener('editor:find', handleEditorFind);
    return () => window.removeEventListener('editor:find', handleEditorFind);
  }, [isOpen, editorRef]);
}
