// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldShowWorktreeBanner, WorktreeBanner } from './worktree-banner';

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('WorktreeBanner', () => {
  it('renders both Dismiss and Settings buttons', () => {
    const { getByRole } = render(<WorktreeBanner onConfigure={vi.fn()} onDismiss={vi.fn()} />);
    expect(getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('renders Dismiss before Settings (tab order = visual order)', () => {
    const { getAllByRole } = render(<WorktreeBanner onConfigure={vi.fn()} onDismiss={vi.fn()} />);
    const [first, second] = getAllByRole('button');
    expect(first).toHaveTextContent('Dismiss');
    expect(second).toHaveTextContent('Settings');
  });

  it('fires onDismiss when Dismiss is clicked', () => {
    const onDismiss = vi.fn();
    const { getByRole } = render(<WorktreeBanner onConfigure={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('fires onConfigure when Settings is clicked', () => {
    const onConfigure = vi.fn();
    const { getByRole } = render(<WorktreeBanner onConfigure={onConfigure} onDismiss={vi.fn()} />);
    fireEvent.click(getByRole('button', { name: 'Settings' }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });
});

describe('shouldShowWorktreeBanner', () => {
  const base = {
    workMode: 'worktree',
    projectPath: '/work/frink',
    dismissed: false,
    configData: { config: null },
  };

  it('shows when worktree mode, project selected, not dismissed, loaded with no config', () => {
    expect(shouldShowWorktreeBanner(base)).toBe(true);
  });

  it('hides once dismissed (the dismiss action)', () => {
    expect(shouldShowWorktreeBanner({ ...base, dismissed: true })).toBe(false);
  });

  it('hides when not in worktree mode', () => {
    expect(shouldShowWorktreeBanner({ ...base, workMode: 'agent' })).toBe(false);
  });

  it('hides when no project is selected', () => {
    expect(shouldShowWorktreeBanner({ ...base, projectPath: undefined })).toBe(false);
  });

  it('hides while the config query is still loading (no flash before load)', () => {
    expect(shouldShowWorktreeBanner({ ...base, configData: undefined })).toBe(false);
  });

  it('hides when a config already exists', () => {
    expect(
      shouldShowWorktreeBanner({ ...base, configData: { config: { commands: 'pnpm i' } } }),
    ).toBe(false);
  });

  // Frink-built projects have no git, so their settings page has no worktree setup to link to.
  it('hides for a project Frink built', () => {
    expect(
      shouldShowWorktreeBanner({ ...base, projectPath: '/Users/b/.frink/builds/my-app' }),
    ).toBe(false);
  });
});
