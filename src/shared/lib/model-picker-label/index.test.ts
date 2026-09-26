import { describe, expect, it } from 'vitest';
import { CODEX_MODELS } from '../models';
import {
  formatModelPickerLabel,
  formatModelPickerLabelParts,
  resolveModelPickerItemById,
} from './index';

/** Resolve + format in one step (the flow-run pill's exact path). */
function labelFor(id: string): string | null {
  const r = resolveModelPickerItemById(id);
  return r ? formatModelPickerLabel(r.item) : null;
}

describe('formatModelPickerLabel', () => {
  it('appends a non-default tier with a middot', () => {
    expect(formatModelPickerLabel({ name: 'Opus 4.8', version: '4.8', detail: 'Max' })).toBe(
      'Opus 4.8 · Max',
    );
  });

  it('hides the Claude/Codex default "Medium" tier', () => {
    expect(formatModelPickerLabel({ name: 'Sonnet', detail: 'Medium' })).toBe('Sonnet');
  });

  it('skips a version already baked into the name', () => {
    expect(formatModelPickerLabel({ name: 'Opus 4.8', version: '4.8' })).toBe('Opus 4.8');
  });

  it('appends a version not present in the name', () => {
    expect(formatModelPickerLabel({ name: 'Codex', version: '5.3' })).toBe('Codex 5.3');
  });
});

describe('formatModelPickerLabelParts', () => {
  it.each([
    [{ name: 'Opus 4.8', version: '4.8', detail: 'Max' }, 'Opus 4.8', ' · Max'],
    [{ name: 'Sonnet', detail: 'Medium' }, 'Sonnet', ''],
    [{ name: 'Codex', version: '5.3', detail: 'High' }, 'Codex 5.3', ' · High'],
  ] as const)('splits %j into a name and a tier suffix', (m, name, suffix) => {
    expect(formatModelPickerLabelParts(m)).toEqual({ name, suffix });
    expect(name + suffix).toBe(formatModelPickerLabel(m));
  });
});

describe('resolveModelPickerItemById', () => {
  it('resolves a Claude id with effort baked into the label', () => {
    expect(labelFor('opus-4.8-max')).toBe('Opus 4.8 · Max');
  });

  it('shows the High default tier for Opus 4.8 / Sonnet 5 (only Medium is hidden)', () => {
    expect(labelFor('opus-4.8')).toBe('Opus 4.8 · High');
    expect(labelFor('sonnet-5')).toBe('Sonnet 5 · High');
  });

  it('resolves a codex id to its own variant with a non-empty label', () => {
    const codexId = CODEX_MODELS[0]?.id ?? '';
    expect(resolveModelPickerItemById(codexId)?.variant).toBe('codex');
    expect(labelFor(codexId)).toBeTruthy();
  });

  it('returns null for an unknown / stale id', () => {
    expect(resolveModelPickerItemById('made-up-model')).toBeNull();
    expect(labelFor('made-up-model')).toBeNull();
  });
});
