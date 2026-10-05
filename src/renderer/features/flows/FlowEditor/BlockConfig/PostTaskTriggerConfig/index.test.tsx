// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';

/** The binding fields the component reads, as the tRPC case-convert middleware returns them. */
type ListedBinding = {
  id: string;
  triggerType: 'post_task_trigger';
  projectId: string | null;
  isActive: boolean;
  lastError: string | null;
};

let listedBindings: ListedBinding[];

// The component's only data source is tRPC react-query hooks, which need a live IPC link.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../../../../../lib/trpc', () => {
  const mutation = () => ({ mutate: () => {}, isPending: false });
  return {
    trpc: {
      useUtils: () => ({ triggerBindings: { list: { invalidate: vi.fn() } } }),
      triggerBindings: {
        list: { useQuery: () => ({ data: listedBindings, isLoading: false }) },
        create: { useMutation: mutation },
        update: { useMutation: mutation },
        delete: { useMutation: mutation },
      },
    },
  };
});
// FlowProjectField pulls the full agents ProjectSelector; the warning does not depend on it.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('../FlowProjectField', () => ({ FlowProjectField: () => <div /> }));

import { PostTaskTriggerConfig } from './index';

const triggerNode: FlowNode = {
  id: 't',
  blockType: 'post_task_trigger',
  position: { x: 0, y: 0 },
};

const NO_PROJECT_WARNING = /has no project, so it will never fire/;

const renderWithBinding = (projectId: string | null) => {
  listedBindings = [
    {
      id: 'b1',
      projectId,
      triggerType: 'post_task_trigger',
      isActive: true,
      lastError: null,
    },
  ];
  render(
    <PostTaskTriggerConfig
      flowId="f1"
      flowProjectId={null}
      node={triggerNode}
      onPatchLabel={vi.fn()}
      onPatchConfig={vi.fn()}
    />,
  );
};

describe('PostTaskTriggerConfig project-less binding warning (sc-3299)', () => {
  afterEach(() => {
    cleanup();
    listedBindings = [];
  });

  it.each([null, '', '   '])('warns when the binding project is %j', (projectId) => {
    renderWithBinding(projectId);
    expect(screen.getByText(NO_PROJECT_WARNING)).toBeInTheDocument();
  });

  it('stays quiet when the binding has a project', () => {
    renderWithBinding('proj-1');
    expect(screen.queryByText(NO_PROJECT_WARNING)).not.toBeInTheDocument();
  });
});
