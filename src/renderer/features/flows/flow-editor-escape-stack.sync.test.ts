import { describe, expect, it } from 'vitest';
import { resolveFlowEditorEscapeAction } from './flow-editor-escape-stack';

const base = {
  hasOpenDialogLayer: false,
  ghostRunActive: false,
  creatorOpen: false,
  settingsOpen: false,
  selectedNodeId: null as string | null,
  runsTab: false,
  stageDetailOpen: false,
};

describe('resolveFlowEditorEscapeAction', () => {
  it('defers when a dialog/overlay layer is open', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        hasOpenDialogLayer: true,
        creatorOpen: true,
      }),
    ).toBe('defer-to-radix');
  });

  it('leaves Escape to an open picker or dialog while a Ghost Run is active', () => {
    expect(
      resolveFlowEditorEscapeAction({ ...base, hasOpenDialogLayer: true, ghostRunActive: true }),
    ).toBe('defer-to-radix');
  });

  it('clears a Ghost Run before closing the creator or leaving the editor', () => {
    expect(
      resolveFlowEditorEscapeAction({ ...base, ghostRunActive: true, creatorOpen: true }),
    ).toBe('clear-ghost-run');
    expect(resolveFlowEditorEscapeAction({ ...base, ghostRunActive: true })).toBe(
      'clear-ghost-run',
    );
  });

  it('closes creator before settings rail', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        creatorOpen: true,
        settingsOpen: true,
      }),
    ).toBe('close-creator');
  });

  it('closes settings before runs-tab stage detail', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        settingsOpen: true,
        runsTab: true,
        stageDetailOpen: true,
      }),
    ).toBe('close-settings');
  });

  it('clears selection before back', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        selectedNodeId: 'n1',
      }),
    ).toBe('clear-selection');
  });

  it('backs to list when stack is empty', () => {
    expect(resolveFlowEditorEscapeAction(base)).toBe('back');
  });

  it('closes stage detail before leaving the Runs tab', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        runsTab: true,
        stageDetailOpen: true,
      }),
    ).toBe('close-stage-detail');
  });

  it('returns to the Editor tab from the Runs tab with no stage detail open', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        runsTab: true,
      }),
    ).toBe('back-to-editor-tab');
  });

  it('on Runs tab, never burns Escape on the hidden editor selection', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        runsTab: true,
        selectedNodeId: 'n1',
      }),
    ).toBe('back-to-editor-tab');
  });

  it('closes stage detail before hidden editor clear-selection when both are active', () => {
    expect(
      resolveFlowEditorEscapeAction({
        ...base,
        runsTab: true,
        stageDetailOpen: true,
        selectedNodeId: 'n1',
      }),
    ).toBe('close-stage-detail');
  });
});
