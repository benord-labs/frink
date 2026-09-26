// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from './index';
import { ModifiedFilterContext } from './modified-filter-context';

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  getClientRect: vi.fn(),
  MeasuringStrategy: { BeforeDragging: 1, Always: 0, WhileDragging: 2 },
  PointerSensor: {},
  useDndContext: () => ({ active: null }),
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
