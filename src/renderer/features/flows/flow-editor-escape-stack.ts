/**
 * Pure priority for FlowEditor Escape (capture handler). Keeps stacking order testable.
 */

type FlowEditorEscapeStackInput = {
  hasOpenDialogLayer: boolean;
  ghostRunActive: boolean;
  creatorOpen: boolean;
  settingsOpen: boolean;
  selectedNodeId: string | null;
  /** True when the Runs tab is active. */
  runsTab: boolean;
  /** True when a stage detail panel is open on the Runs tab. */
  stageDetailOpen: boolean;
};

type FlowEditorEscapeStackAction =
  | 'defer-to-radix'
  | 'clear-ghost-run'
  | 'close-creator'
  | 'close-settings'
  | 'close-stage-detail'
  | 'back-to-editor-tab'
  | 'clear-selection'
  | 'back';

export function resolveFlowEditorEscapeAction(
  input: FlowEditorEscapeStackInput,
): FlowEditorEscapeStackAction {
  if (input.hasOpenDialogLayer) {
    return 'defer-to-radix';
  }
  // A Ghost Run is transient: clear it before the editor is closed or exited under it.
  if (input.ghostRunActive) {
    return 'clear-ghost-run';
  }
  if (input.creatorOpen) {
    return 'close-creator';
  }
  if (input.settingsOpen) {
    return 'close-settings';
  }
  if (input.runsTab) {
    // The Runs tab is a nested context: Escape peels stage detail, then returns to the
    // Editor tab. It never exits the editor directly (the hidden editor's node selection
    // is also never burned — it stays for when the user returns).
    return input.stageDetailOpen ? 'close-stage-detail' : 'back-to-editor-tab';
  }
  if (input.selectedNodeId) {
    return 'clear-selection';
  }
  return 'back';
}
