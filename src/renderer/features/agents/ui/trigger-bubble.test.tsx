// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriggerSummary } from '../../../../shared/lib/trigger-summary';
import { TriggerBubble } from './trigger-bubble';

afterEach(() => {
  document.body.innerHTML = '';
});

const summary: TriggerSummary = {
  source: 'shortcut',
  provider: 'Shortcut',
  title: 'Implement trigger metadata panel',
  subtitle: '#4821 · Ready for Dev · feature',
  fields: [
    { label: 'Type', value: 'feature', tone: 'neutral' },
    { label: 'State', value: 'Ready for Dev', tone: 'green' },
    { label: 'Owners', value: 'Benji Norval' },
  ],
  changes: [{ label: 'State', from: 'Ready for Dev', to: 'In Development' }],
  autoStart: true,
};

describe('TriggerBubble', () => {
  it('shows the summary fields, changes, and full prompt when expanded', () => {
    render(
      <TriggerBubble
        data={summary}
        fullPrompt={'## Trigger Context: Shortcut Story\n\nFull prompt body'}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Shortcut/ }));

    expect(screen.getByText('Detected metadata')).toBeTruthy();
    expect(screen.getByText('What changed')).toBeTruthy();
    expect(screen.getByText('Prompt used')).toBeTruthy();
    expect(screen.getByText((c) => c.includes('Full prompt body'))).toBeTruthy();
    expect(screen.getByText('Benji Norval')).toBeTruthy();
    expect(screen.getByText('In Development')).toBeTruthy();
  });

  it('hides fields that are absent (no empty rows)', () => {
    const { container } = render(
      <TriggerBubble data={{ ...summary, fields: [] }} fullPrompt="x" />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toContain('%23494BCB');
    fireEvent.click(screen.getByRole('button', { name: /Shortcut/ }));
    expect(screen.queryByText('Detected metadata')).toBeNull();
  });

  it('copies full prompt text from copy action', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<TriggerBubble data={summary} fullPrompt="prompt to copy" />);
    fireEvent.click(screen.getByRole('button', { name: /Shortcut/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('prompt to copy');
  });
});
