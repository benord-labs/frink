type InlineDiffStateInput = {
  isTextEditorFile: boolean;
  hasWorkingLineChanges: boolean;
  diffModePreference: boolean;
};

type InlineDiffState = {
  canShowInlineDiff: boolean;
  isDiffModeActive: boolean;
};

type InlineDiffAvailabilityTransitionInput = {
  wasInlineDiffAvailable: boolean;
  isInlineDiffAvailable: boolean;
};

type InlineDiffShortcutInput = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isEditorOpen: boolean;
  canShowInlineDiff: boolean;
};

export function getInlineDiffState({
  isTextEditorFile,
  hasWorkingLineChanges,
  diffModePreference,
}: InlineDiffStateInput): InlineDiffState {
  const canShowInlineDiff = Boolean(isTextEditorFile && hasWorkingLineChanges);

  return {
    canShowInlineDiff,
    isDiffModeActive: Boolean(diffModePreference && canShowInlineDiff),
  };
}

export function shouldAutoEnableInlineDiff({
  wasInlineDiffAvailable,
  isInlineDiffAvailable,
}: InlineDiffAvailabilityTransitionInput): boolean {
  return !wasInlineDiffAvailable && isInlineDiffAvailable;
}

export function isInlineDiffToggleShortcut({
  key,
  code,
  metaKey,
  ctrlKey,
  shiftKey,
  isEditorOpen,
  canShowInlineDiff,
}: InlineDiffShortcutInput): boolean {
  if (!canShowInlineDiff || !isEditorOpen) return false;
  const mod = metaKey || ctrlKey;
  if (!mod || !shiftKey) return false;
  return key.toLowerCase() === 'i' || code === 'KeyI';
}
