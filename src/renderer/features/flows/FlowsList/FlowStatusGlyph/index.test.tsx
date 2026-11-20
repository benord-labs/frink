// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FlowRunGlyph } from '../../../../lib/flows/flow-run-state';
import { FlowStatusGlyph } from '.';

describe('FlowStatusGlyph', () => {
  it('turns a live run slowly on its wrapper, in the live tone', () => {
    const { container } = render(<FlowStatusGlyph glyph="live" tone="live" />);
    const spinner = container.querySelector('[data-spinner]');
    expect(spinner?.getAttribute('class')).toContain('motion-safe:animate-spin-slow');
    expect(spinner?.getAttribute('class')).toContain('size-3.5');
    expect(spinner?.querySelector('svg')?.getAttribute('class')).toContain('lucide-loader-circle');
  });

  it.each<FlowRunGlyph>(['done', 'paused', 'failed'])('keeps a %s glyph still', (glyph) => {
    const { container } = render(<FlowStatusGlyph glyph={glyph} tone="quiet" />);
    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
