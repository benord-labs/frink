// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalToggleButton } from './terminal-toggle-button';

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../../../components/ui/kbd', () => ({
  Kbd: ({ shortcutId }: { shortcutId: string }) => <kbd data-testid={`kbd-${shortcutId}`} />,
}));

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('TerminalToggleButton', () => {
  describe('when closed (isOpen=false)', () => {
    it('labels button "Open terminal"', () => {
      const { getByRole } = render(<TerminalToggleButton isOpen={false} onClick={vi.fn()} />);
      expect(getByRole('button', { name: 'Open terminal' })).toBeInTheDocument();
    });

    it('sets aria-pressed to false', () => {
      const { getByRole } = render(<TerminalToggleButton isOpen={false} onClick={vi.fn()} />);
      expect(getByRole('button', { name: 'Open terminal' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('shows "Open terminal" in tooltip', () => {
      const { getByTestId } = render(<TerminalToggleButton isOpen={false} onClick={vi.fn()} />);
      expect(getByTestId('tooltip-content')).toHaveTextContent('Open terminal');
    });
  });

  describe('when open (isOpen=true)', () => {
    it('labels button "Close terminal"', () => {
      const { getByRole } = render(<TerminalToggleButton isOpen onClick={vi.fn()} />);
      expect(getByRole('button', { name: 'Close terminal' })).toBeInTheDocument();
    });

    it('sets aria-pressed to true', () => {
      const { getByRole } = render(<TerminalToggleButton isOpen onClick={vi.fn()} />);
      expect(getByRole('button', { name: 'Close terminal' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('shows "Close terminal" in tooltip', () => {
      const { getByTestId } = render(<TerminalToggleButton isOpen onClick={vi.fn()} />);
      expect(getByTestId('tooltip-content')).toHaveTextContent('Close terminal');
    });
  });

  it('fires onClick when clicked', () => {
    const handleClick = vi.fn();
    const { getByRole } = render(<TerminalToggleButton onClick={handleClick} />);
    fireEvent.click(getByRole('button'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('does not throw when onClick is not provided', () => {
    const { getByRole } = render(<TerminalToggleButton />);
    expect(() => fireEvent.click(getByRole('button'))).not.toThrow();
  });
});
