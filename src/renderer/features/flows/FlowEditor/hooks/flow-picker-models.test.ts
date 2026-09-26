import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PICKER_MODELS,
  CODEX_MODELS,
  codexModelToPickerItem,
} from '../../../../../shared/lib/models';
import { flowModelVariant, getFlowPickerModels } from './flow-picker-models';

describe('getFlowPickerModels', () => {
  it('returns Claude picker models without the composer-only Ultra tier when not Codex', () => {
    const claude = getFlowPickerModels(false);
    expect(claude).toEqual(CLAUDE_PICKER_MODELS.filter((m) => m.effort !== 'ultra'));
    expect(claude.length).toBeLessThan(CLAUDE_PICKER_MODELS.length);
  });

  it('returns Codex picker models when Codex project', () => {
    const codex = getFlowPickerModels(true);
    expect(codex.length).toBe(CODEX_MODELS.length);
    expect(codex[0]).toEqual(codexModelToPickerItem(CODEX_MODELS[0]));
  });
});

describe('flowModelVariant', () => {
  it('defaults to claude when not codex', () => {
    expect(flowModelVariant(false)).toBe('claude');
  });

  it('matches getFlowPickerModels for a codex project, so list and styling agree', () => {
    expect(flowModelVariant(true)).toBe('codex');
    expect(getFlowPickerModels(true)[0]).toEqual(codexModelToPickerItem(CODEX_MODELS[0]));
  });
});
