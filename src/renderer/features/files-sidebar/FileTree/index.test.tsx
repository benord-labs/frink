// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from './index';
import { ModifiedFilterContext } from './modified-filter-context';
import { ReadOnlyContext } from './ReadOnlyContext';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  getClientRect: vi.fn(),
  MeasuringStrategy: { BeforeDragging: 1, Always: 0, WhileDragging: 2 },
  PointerSensor: {},
  // Every render is mid-drag, so the root hint shows wherever a tree allows it.
  useDndContext: () => ({ active: { data: { current: { type: 'tree-node' } } } }),
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useSensor: () => ({}),
  useSensors: () => [],
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

vi.mock('../../agents/mentions/agents-file-mention', () => ({
  getFileIconByExtension: () => null,
}));

vi.mock('./TreeNode', () => ({
  TreeNode: () => <div />,
}));

describe('FileTree empty states', () => {
  it('shows "No modified files" when modified-only mode is enabled', () => {
    render(
      <ModifiedFilterContext.Provider value={true}>
        <FileTree nodes={[]} projectPath="/tmp/proj" onFileClick={() => {}} />
      </ModifiedFilterContext.Provider>,
    );

    expect(screen.getByText('No modified files')).toBeInTheDocument();
  });

  it('shows "No files in project" when not filtering and not searching', () => {
    render(
      <ModifiedFilterContext.Provider value={false}>
        <FileTree nodes={[]} projectPath="/tmp/proj" onFileClick={() => {}} />
      </ModifiedFilterContext.Provider>,
    );

    expect(screen.getByText('No files in project')).toBeInTheDocument();
  });

  it('shows "No files found" during a search with no results', () => {
    render(
      <ModifiedFilterContext.Provider value={false}>
        <FileTree
          nodes={[]}
          projectPath="/tmp/proj"
          onFileClick={() => {}}
          searchQuery="nonexistent"
        />
      </ModifiedFilterContext.Provider>,
    );

    expect(screen.getByText('No files found')).toBeInTheDocument();
  });
});

describe('FileTree root drop hint', () => {
  it.each([
    ['shows', false],
    ['hides', true],
  ])('%s the project root hint during a drag when read-only is %s', (_, readOnly) => {
    render(
      <ReadOnlyContext.Provider value={readOnly}>
        <FileTree
          nodes={[{ id: 'a.ts', name: 'a.ts', path: 'a.ts', type: 'file' }]}
          projectPath="/tmp/proj"
          manageDnd={false}
          onFileClick={() => {}}
        />
      </ReadOnlyContext.Provider>,
    );

    expect(Boolean(screen.queryByText('Project root'))).toBe(!readOnly);
  });
});
