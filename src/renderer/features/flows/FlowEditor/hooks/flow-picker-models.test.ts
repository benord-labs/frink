import { describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PICKER_MODELS,
  CODEX_MODELS,
  codexModelToPickerItem,
} from '../../../../../shared/lib/models';
import { flowModelVariant, getFlowPickerModels } from './flow-picker-models';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

describe('getFlowPickerModels', () => {
  it('returns Claude picker models without the composer-only Ultra rows when not Codex', () => {
    const claude = getFlowPickerModels(false);
    expect(claude).toEqual(CLAUDE_PICKER_MODELS.filter((m) => !m.ultra));
    expect(claude.length).toBeLessThan(CLAUDE_PICKER_MODELS.length);
  });

  it('returns Codex picker models when Codex project', () => {
    const codex = getFlowPickerModels(true);
    expect(codex.length).toBe(CODEX_MODELS.length);
    expect(codex[0]).toEqual(codexModelToPickerItem(CODEX_MODELS[0]));
  });

  it('offers an unattended step only the models the signed-in Codex account can use', () => {
    const free = { tiers: { 'gpt-6-luna': [], 'gpt-5.5': [] }, defaultSlug: 'gpt-6-luna' };
    const ids = getFlowPickerModels(true, free).map((m) => m.id);
    expect(ids).toContain('codex-gpt-6-luna-medium');
    expect(ids.some((id) => id.startsWith('codex-gpt-6-astra'))).toBe(false);
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
