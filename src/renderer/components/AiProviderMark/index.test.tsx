// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { aiProviderMark } from './index';

afterEach(cleanup);

function renderMark(provider: string | null) {
  const Mark = aiProviderMark(provider);
  return render(<Mark className="size-4" />).container;
}

describe('aiProviderMark', () => {
  it.each(['claude-code', 'codex', 'opencode', 'copilot', 'cursor'])(
    'draws the %s brand mark',
    (provider) => {
      const container = renderMark(provider);
      expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(container.querySelector('.lucide-bot')).toBeNull();
    },
  );

  it.each(['grok', 'someday-agent', ''])('gives %j a neutral glyph', (provider) => {
    const container = renderMark(provider);
    expect(container.querySelector('svg.lucide-bot')).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws a legacy account with no type as Claude', () => {
    expect(aiProviderMark(null)).toBe(aiProviderMark('claude-code'));
  });

  it('keeps each mark stable across renders', () => {
    expect(aiProviderMark('someday-agent')).toBe(aiProviderMark('grok'));
    expect(aiProviderMark('copilot')).toBe(aiProviderMark('copilot'));
    expect(aiProviderMark('codex')).not.toBe(aiProviderMark('claude-code'));
  });
});
