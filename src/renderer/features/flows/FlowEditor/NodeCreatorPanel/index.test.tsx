// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { FlowBlockType } from '../../../../../shared/types/flow';
import { trpc } from '../../../../lib/trpc';
import { type NodeCreatorMode, NodeCreatorPanel } from '.';

vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: {
      onMessage: () => () => undefined,
      sendMessage: () => undefined,
    },
  });
});

type TestNode = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  entrypoint: string;
  timeout: number;
  inputs: Record<string, never>;
  nodePath: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
};

type DeleteNode = (input: { name: string }) => Promise<void>;
const DELETE_INPUT_SCHEMA = z.object({ name: z.string() });

function testNode(name: string, displayName: string): TestNode {
  return {
    id: name,
    name,
    displayName,
    description: `${displayName} description`,
    version: '1.0.0',
    entrypoint: 'index.ts',
    timeout: 30_000,
    inputs: {},
    nodePath: `/nodes/${name}`,
    verified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createTestClient(nodes: TestNode[], deleteNode: DeleteNode) {
  return trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'customNodes.list') {
              observer.next({ result: { data: nodes } });
              observer.complete();
              return;
            }
            if (op.path === 'customNodes.delete') {
              void deleteNode(DELETE_INPUT_SCHEMA.parse(op.input)).then(() => {
                observer.next({ result: { data: { success: true } } });
                observer.complete();
              });
              return;
            }
            throw new Error(`Unexpected test operation: ${op.path}`);
          }),
    ],
  });
}

function renderPanel({
  mode = { kind: 'floating' },
  allowedTypes = ['agent', 'condition'],
  onPick = vi.fn(),
  nodes = [],
  deleteNode = () => Promise.resolve(),
}: {
  mode?: NodeCreatorMode;
  allowedTypes?: FlowBlockType[];
  onPick?: (blockType: string) => void;
  nodes?: TestNode[];
  deleteNode?: DeleteNode;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <trpc.Provider client={createTestClient(nodes, deleteNode)} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <NodeCreatorPanel
          open
          onOpenChange={vi.fn()}
          mode={mode}
          allowedTypes={allowedTypes}
          onPick={onPick}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { onPick };
}

describe('NodeCreatorPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it.each<[NodeCreatorMode, string]>([
    [{ kind: 'floating' }, 'Add step'],
    [{ kind: 'append', sourceId: 'node-1', sourceHandle: undefined }, 'Add connected step'],
    [{ kind: 'insert_edge', edgeId: 'edge-1' }, 'Insert step'],
  ])('renders the mode-specific dialog title', (mode, title) => {
    renderPanel({ mode });
    expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
  });

  it('wears the overlay glass instead of a solid card', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('glass-lit', 'bg-popover/(--glass-opacity)');
    expect(dialog).not.toHaveClass('bg-card');
  });

  it('keeps category tabs stable while search is scoped to the active tab', () => {
    renderPanel();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Actions' }), { button: 0 });
    const search = screen.getByRole('combobox', { name: 'Search Actions' });
    fireEvent.change(search, { target: { value: 'condition' } });

    expect(screen.getByText('No steps match your search.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Logic' })).toBeInTheDocument();
  });

  it('navigates visible results from the search field and picks with Enter', () => {
    const onPick = vi.fn();
    renderPanel({ onPick });
    const search = screen.getByRole('combobox');

    expect(search).toHaveAttribute('aria-controls', 'node-creator-listbox');
    expect(search).toHaveAttribute('aria-activedescendant', 'node-creator-option-0');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', 'node-creator-option-1');
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onPick).toHaveBeenCalledWith('condition');
  });

  it('removes a chosen custom node without relying on list hover', async () => {
    const deleteNode = vi.fn<DeleteNode>().mockResolvedValue(undefined);
    renderPanel({
      allowedTypes: [],
      deleteNode,
      nodes: [testNode('first_node', 'First Node'), testNode('second_node', 'Second Node')],
    });

    expect(screen.queryByRole('button', { name: 'Choose a custom node to remove' })).toBeNull();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Custom' }), { button: 0 });

    const trigger = screen.getByRole('button', { name: 'Choose a custom node to remove' });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Second Node' }));

    expect(
      screen.getByRole('alertdialog', { name: 'Remove custom node from catalog?' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/"Second Node" will be removed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(deleteNode).toHaveBeenCalledWith({ name: 'second_node' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: 'Remove custom node from catalog?' }),
      ).toBeNull(),
    );
  });
});
