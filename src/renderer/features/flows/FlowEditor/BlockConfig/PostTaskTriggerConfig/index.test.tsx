// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { FlowNode } from '../../../../../../shared/lib/validate-flow-graph';
import { postTaskBindingConfigSchema } from '../../../../../../shared/types/flows/flow-trigger-binding-config';
import { trpc } from '../../../../../lib/trpc';
import { PostTaskTriggerConfig } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const CREATE_INPUT = z.strictObject({
  flowId: z.string(),
  projectId: z.string().nullable(),
  triggerType: z.literal('post_task_trigger'),
  config: postTaskBindingConfigSchema,
});
const UPDATE_INPUT = z.strictObject({
  id: z.string(),
  config: postTaskBindingConfigSchema.optional(),
  isActive: z.boolean().optional(),
  clearLastError: z.literal(true).optional(),
});
const DELETE_INPUT = z.strictObject({ id: z.string() });

type StoredBinding = {
  id: string;
  triggerType: string;
  isActive: boolean;
  lastError: string | null;
};

const createBinding = vi.fn<(input: z.infer<typeof CREATE_INPUT>) => void>();
const updateBinding = vi.fn<(input: z.infer<typeof UPDATE_INPUT>) => void>();
const deleteBinding = vi.fn<(input: z.infer<typeof DELETE_INPUT>) => void>();
const onPatchConfig = vi.fn<(config: FlowNode['config']) => void>();

/** A real trpc client answered in-process; each binding write is parsed with the schema the router enforces. */
function createTestClient(bindings: StoredBinding[]) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            let data: StoredBinding[] | null = null;
            if (op.path === 'triggerBindings.list') data = bindings;
            else if (op.path === 'triggerBindings.create')
              createBinding(CREATE_INPUT.parse(op.input));
            else if (op.path === 'triggerBindings.update')
              updateBinding(UPDATE_INPUT.parse(op.input));
            else if (op.path === 'triggerBindings.delete')
              deleteBinding(DELETE_INPUT.parse(op.input));
            else if (op.type !== 'query') throw new Error(`Unexpected test operation: ${op.path}`);
            observer.next({ result: { data } });
            observer.complete();
          }),
    ],
  });
}

function renderEditor(config: FlowNode['config'], bindings: StoredBinding[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const node: FlowNode = {
    id: 'trigger',
    blockType: 'post_task_trigger',
    config,
    position: { x: 0, y: 0 },
  };
  render(
    <trpc.Provider client={createTestClient(bindings)} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <PostTaskTriggerConfig
          flowId="flow-1"
          flowProjectId="project-1"
          node={node}
          onPatchLabel={vi.fn<() => void>()}
          onPatchConfig={onPatchConfig}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

const existingBinding = (lastError: string | null): StoredBinding => ({
  id: 'binding-1',
  triggerType: 'post_task_trigger',
  isActive: true,
  lastError,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PostTaskTriggerConfig binding payload', () => {
  it('enables automation with a config the binding schema accepts when the node has none', async () => {
    renderEditor({});

    await userEvent.click(await screen.findByRole('button', { name: 'Enable automation' }));

    await waitFor(() =>
      expect(createBinding).toHaveBeenCalledWith({
        flowId: 'flow-1',
        projectId: 'project-1',
        triggerType: 'post_task_trigger',
        config: { triggerStates: ['done', 'completed'] },
      }),
    );
  });

  it('drops unknown states and non-string sources before sending the config', async () => {
    renderEditor({ triggerStates: ['failed', 'bogus'], filterBySource: ['manual', 7, 'slack'] });

    await userEvent.click(await screen.findByRole('button', { name: 'Enable automation' }));

    await waitFor(() =>
      expect(createBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { triggerStates: ['failed'], filterBySource: ['manual', 'slack'] },
        }),
      ),
    );
  });

  it('syncs the node config onto an existing binding and clears its error', async () => {
    renderEditor({ triggerStates: ['all'] }, [existingBinding('boom')]);

    expect(await screen.findByText('boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sync config to binding' }));

    await waitFor(() =>
      expect(updateBinding).toHaveBeenCalledWith({
        id: 'binding-1',
        config: { triggerStates: ['all'] },
        clearLastError: true,
      }),
    );
  });

  it('deactivates and removes an existing binding without sending a config', async () => {
    renderEditor({}, [existingBinding(null)]);

    await userEvent.click(await screen.findByLabelText('Automation active'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove binding' }));

    await waitFor(() => expect(deleteBinding).toHaveBeenCalledWith({ id: 'binding-1' }));
    expect(updateBinding).toHaveBeenCalledWith({ id: 'binding-1', isActive: false });
  });

  it('falls back to done and completed when the last state is unticked', async () => {
    renderEditor({ triggerStates: ['failed'] });

    await userEvent.click(screen.getByLabelText('Failed'));
    await userEvent.click(screen.getByLabelText('All statuses'));

    expect(onPatchConfig).toHaveBeenNthCalledWith(1, {
      triggerStates: ['done', 'completed'],
      filterBySource: undefined,
    });
    expect(onPatchConfig).toHaveBeenNthCalledWith(2, {
      triggerStates: ['all'],
      filterBySource: undefined,
    });
  });
});
