// Public surface for the code-editor feature. Logic now lives in
// @/lib/code-editor/* (state, monaco, files, lsp, …); this barrel re-exports the
// atoms consumed across the app plus the panel component, so existing importers
// of '@/features/code-editor' keep working unchanged.
export {
  clearCodeSelectionContextAtomFamily,
  clearPaneContextAtom,
  closeFilesOutsideProjectAtom,
  closePaneTabsAtom,
  codeEditorActiveChatIdAtom,
  codeEditorHeightAtom,
  codeEditorLayoutAtom,
  codeEditorMaximizedAtom,
  codeEditorOpenAtom,
  codeEditorWidthAtom,
  codeSelectionContextAtomFamily,
  editorActivePaneIndexAtom,
  editorIsSplitActiveAtom,
  filterTabsToActivePaneAtom,
  lastActiveTabPerPaneAtom,
  openFileAtom,
  openFilesAtom,
  tagOpenFilesWithPaneContextAtom,
} from '@/lib/code-editor/state';
export { CodeEditorPanel } from './CodeEditorPanel';
