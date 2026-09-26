// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ResourceStatus, StatusDot } from './status-dot';

vi.mock('lucide-react', () => ({
  Loader2: (props: Record<string, unknown>) => (
    <span data-testid="loader-spinner" className={props.className as string} />
  ),
}));

afterEach(cleanup);

describe('StatusDot', () => {
  it('renders a dot with role="img" for standard statuses', () => {
    render(<StatusDot status="connected" />);
    const dot = screen.getByRole('img');
    expect(dot.tagName).toBe('SPAN');
    expect(dot.getAttribute('aria-label')).toBe('Status: connected');
  });

  it('renders the Loader2 spinner for reconnecting status', () => {
    render(<StatusDot status="reconnecting" />);
    expect(screen.getByTestId('loader-spinner')).toBeDefined();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it.each<{ status: ResourceStatus; expected: string }>([
    { status: 'connected', expected: 'bg-[hsl(var(--status-online))]' },
    { status: 'needs_auth', expected: 'bg-[hsl(var(--status-warning))]' },
    { status: 'error', expected: 'bg-destructive' },
    { status: 'disconnected', expected: 'bg-destructive' },
    { status: 'pending', expected: 'bg-muted-foreground/60' },
    { status: 'starting', expected: 'bg-muted-foreground/60' },
  ])('applies $expected class for "$status"', ({ status, expected }) => {
    render(<StatusDot status={status} />);
    const dot = screen.getByRole('img');
    expect(dot.className).toContain(expected);
  });

  it('falls back to muted for unknown status strings', () => {
    render(<StatusDot status="unknown-status" />);
    const dot = screen.getByRole('img');
    expect(dot.className).toContain('bg-muted-foreground/60');
  });

  it('uses custom aria-label when provided', () => {
    render(<StatusDot status="connected" aria-label="Server online" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Server online');
  });

  it('applies additional className', () => {
    render(<StatusDot status="connected" className="mt-2" />);
    expect(screen.getByRole('img').className).toContain('mt-2');
  });
});
