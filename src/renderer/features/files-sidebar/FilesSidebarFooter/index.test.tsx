// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesSidebarFooter } from '.';

afterEach(() => {
  cleanup();
});

describe('FilesSidebarFooter', () => {
  it('applies compact icon sizing for non-worktree footer', () => {
    const { container } = render(
      <FilesSidebarFooter projectName="proj" projectPath="/tmp/proj" selectedCount={0} compact />,
    );

    expect(container.querySelector('.h-3.w-3')).toBeInTheDocument();
  });

  it.each([
    [undefined, undefined, null],
    [1, undefined, null],
    [2, undefined, '2 projects in this tree'],
    [3, '/tmp/proj/.worktrees/feature-foo', '3 projects in this tree'],
  ])('with %s projects (worktree %s) shows the count %s', (projectCount, worktreePath, count) => {
    const { queryByText } = render(
      <FilesSidebarFooter
        projectName="proj"
        projectPath="/tmp/proj/.worktrees/feature-foo"
        worktreePath={worktreePath}
        projectCount={projectCount}
      />,
    );

    expect(queryByText(/projects in this tree/)?.textContent ?? null).toBe(count);
  });

  it('hides duplicate project row when worktree and project paths are the same', () => {
    const { container, queryByTitle } = render(
      <FilesSidebarFooter
        projectName="feature-foo"
        projectPath="/tmp/proj/.worktrees/feature-foo"
        worktreePath="/tmp/proj/.worktrees/feature-foo"
        selectedCount={0}
      />,
    );

    expect(queryByTitle('Worktree: /tmp/proj/.worktrees/feature-foo')).toBeInTheDocument();
    const worktreeLabelCount = (container.textContent?.match(/feature-foo/g) ?? []).length;
    expect(worktreeLabelCount).toBe(1);
  });
});
