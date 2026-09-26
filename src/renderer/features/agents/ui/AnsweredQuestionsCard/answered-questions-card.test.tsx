// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnsweredQuestionsCard } from './index';

describe('AnsweredQuestionsCard', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders a minimal trace when no entries carry answer text', () => {
    render(<AnsweredQuestionsCard entries={[]} />);
    expect(screen.getByText('Question answered')).toBeInTheDocument();
  });

  it('renders answer markdown so it matches the popup option it was picked from', () => {
    render(
      <AnsweredQuestionsCard entries={[{ label: 'Approach', answer: 'Use **strict** `mode`' }]} />,
    );

    expect(screen.getByText('Approach')).toBeInTheDocument();
    expect(screen.getByText('strict').tagName).toBe('STRONG');
    expect(screen.getByText('mode')).toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
    expect(screen.queryByText(/`/)).not.toBeInTheDocument();
  });

  // On the fallback path a row's label IS the full question text. Questions in one ask routinely
  // share a long opening clause, so a key built from a prefix of the label collides and React
  // reconciles the rows as one.
  it('keeps sibling rows distinct when two questions share a long opening clause', () => {
    const shared = 'Which scope should this take for the payment module rewrite?';
    const entries = [
      { label: `${shared} Option A covers the parser.`, answer: 'Yes' },
      { label: `${shared} Option B covers the renderer.`, answer: 'Yes' },
    ];

    const keyWarnings: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      keyWarnings.push(args);
    });

    render(<AnsweredQuestionsCard entries={entries} />);

    expect(screen.getByText(entries[0].label)).toBeInTheDocument();
    expect(screen.getByText(entries[1].label)).toBeInTheDocument();
    expect(keyWarnings.filter((args) => String(args[0]).includes('same key'))).toHaveLength(0);

    spy.mockRestore();
  });
});
