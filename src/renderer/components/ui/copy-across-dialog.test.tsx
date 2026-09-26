// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyAcrossDialog } from './copy-across-dialog';

afterEach(cleanup);

const projects = [
  { id: 'p1', name: 'Frink Marketing', path: '/proj/p1' },
  { id: 'p2', name: 'Other', path: '/proj/p2' },
];

describe('CopyAcrossDialog', () => {
  it('renders nothing when there is no skill to copy', () => {
    const { container } = render(
      <CopyAcrossDialog items={[]} projects={projects} onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('titles a single skill and defaults the target to global', () => {
    const onSubmit = vi.fn();
    render(
      <CopyAcrossDialog
        items={[{ name: 'frontend-design', sourcePath: '/src/frontend-design' }]}
        projects={projects}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText('Copy across: frontend-design')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onSubmit).toHaveBeenCalledWith('global', undefined, 'portable');
  });

  it('summarises a multi-skill set as a count', () => {
    render(
      <CopyAcrossDialog
        items={[
          { name: 'a', sourcePath: '/src/a' },
          { name: 'b', sourcePath: '/src/b' },
        ]}
        projects={projects}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('Copy across: 2 skills')).toBeDefined();
  });

  it('warns about a repo add and submits the project target when seeded with a project source', () => {
    const onSubmit = vi.fn();
    render(
      <CopyAcrossDialog
        items={[{ name: 'frontend-design', sourcePath: '/src/frontend-design' }]}
        sourceScope="project"
        sourceProjectId="p1"
        projects={projects}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    // The repo-add note names the seeded project (default target = its source scope).
    expect(screen.getByText(/become part of its repo/)).toBeDefined();
    expect(screen.getAllByText('Frink Marketing').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onSubmit).toHaveBeenCalledWith('project', 'p1', 'portable');
  });

  it('offers a tool-only breadth and defaults to portable when an active tool is known', () => {
    const onSubmit = vi.fn();
    render(
      <CopyAcrossDialog
        items={[{ name: 'a', sourcePath: '/src/a' }]}
        activeTool="claude-code"
        projects={projects}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText('Add a copy to')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onSubmit).toHaveBeenCalledWith('global', undefined, 'portable');
  });

  it('cancels without copying', () => {
    const onClose = vi.fn();
    render(
      <CopyAcrossDialog
        items={[{ name: 'a', sourcePath: '/src/a' }]}
        projects={projects}
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
