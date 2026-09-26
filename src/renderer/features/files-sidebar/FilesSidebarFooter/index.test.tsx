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
