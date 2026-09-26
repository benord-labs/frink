// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowGraph } from '../../../../../shared/lib/validate-flow-graph';

type DiscoverShape = {
  errors: Array<{ dir: string; error: string }>;
  manifestWarnings: Array<{ name: string; warnings: string[] }>;
  valid: Array<{ name: string }>;
};

const snap = vi.hoisted(() => ({
  discoverData: {
    errors: [] as DiscoverShape['errors'],
    manifestWarnings: [] as DiscoverShape['manifestWarnings'],
    valid: [] as DiscoverShape['valid'],
  } as DiscoverShape,
  discoverError: false,
  discoverFetching: false,
  catalogData: [] as Array<{ name: string }> | undefined,
  syncMutate: vi.fn(),
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      customNodes: {
        discoverLocal: { invalidate: vi.fn() },
        list: { invalidate: vi.fn() },
      },
    }),
    customNodes: {
      discoverLocal: {
        useQuery: () => ({
          data: snap.discoverError ? undefined : snap.discoverData,
          isError: snap.discoverError,
          isFetching: snap.discoverFetching,
        }),
      },
      list: {
        useQuery: () => ({
          data: snap.catalogData,
        }),
      },
      sync: {
        useMutation: () => ({
          mutate: snap.syncMutate,
          isPending: false,
        }),
      },
    },
  },
}));

import { NodeHealthBadge } from './index';

const CUSTOM = 'my-custom-node';

function graphWithCustomNode(): FlowGraph {
  return {
    nodes: [{ id: 'c1', blockType: CUSTOM, config: {} }],
    edges: [],
  };
}

function graphNoCustom(): FlowGraph {
  return {
    nodes: [{ id: 't1', blockType: 'manual_trigger', config: {} }],
    edges: [],
  };
}

describe('NodeHealthBadge', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    snap.discoverData = { errors: [], manifestWarnings: [], valid: [] };
    snap.discoverError = false;
    snap.discoverFetching = false;
    snap.catalogData = [];
    snap.syncMutate.mockClear();
  });

  it('renders nothing when the graph has no custom node steps', () => {
    render(<NodeHealthBadge graph={graphNoCustom()} />);
    expect(screen.queryByTitle('Custom node health')).not.toBeInTheDocument();
  });

  it('renders nothing when custom steps are healthy (catalog + discovery agree)', () => {
    snap.catalogData = [{ name: CUSTOM }];
    snap.discoverData = {
      errors: [],
      manifestWarnings: [],
      valid: [{ name: CUSTOM }],
    };
    render(<NodeHealthBadge graph={graphWithCustomNode()} />);
    expect(screen.queryByTitle('Custom node health')).not.toBeInTheDocument();
  });

  it('renders nothing while catalog is still loading if discovery reports no issues', () => {
    snap.catalogData = undefined;
    snap.discoverData = { errors: [], manifestWarnings: [], valid: [{ name: CUSTOM }] };
    render(<NodeHealthBadge graph={graphWithCustomNode()} />);
    expect(screen.queryByTitle('Custom node health')).not.toBeInTheDocument();
  });

  it('shows the badge when a custom step is missing from the cloud catalog', async () => {
    const user = userEvent.setup();
    snap.catalogData = [{ name: 'other-node' }];
    snap.discoverData = { errors: [], manifestWarnings: [], valid: [{ name: CUSTOM }] };
    render(<NodeHealthBadge graph={graphWithCustomNode()} />);

    const trigger = screen.getByTitle('Custom node health');
    expect(trigger).toBeInTheDocument();
    await user.click(trigger);
    expect(
      screen.getByText('Manifest not discovered locally — refresh custom nodes'),
    ).toBeInTheDocument();
  });

  it('shows the badge when local discovery reports an error for that node folder', async () => {
    const user = userEvent.setup();
    snap.catalogData = [{ name: CUSTOM }];
    snap.discoverData = {
      errors: [{ dir: CUSTOM, error: 'Invalid JSON in manifest' }],
      manifestWarnings: [],
      valid: [],
    };
    render(<NodeHealthBadge graph={graphWithCustomNode()} />);

    await user.click(screen.getByTitle('Custom node health'));
    expect(screen.getByText('Invalid JSON in manifest')).toBeInTheDocument();
  });

  it('shows the badge when discoverLocal fails (scan error)', () => {
    snap.discoverError = true;
    snap.catalogData = [{ name: CUSTOM }];
    render(<NodeHealthBadge graph={graphWithCustomNode()} />);
    expect(screen.getByTitle('Custom node health')).toBeInTheDocument();
  });

  it('keeps the badge visible while discovery is refetching so the UI does not flicker hidden', () => {
    snap.discoverFetching = true;
    snap.catalogData = [{ name: CUSTOM }];
    snap.discoverData = { errors: [], manifestWarnings: [], valid: [{ name: CUSTOM }] };
    render(<NodeHealthBadge graph={graphWithCustomNode()} />);
    expect(screen.getByTitle('Custom node health')).toBeInTheDocument();
  });

  it('omits the menu separator when the menu only has sync (e.g. discovery refetch, no issues yet)', async () => {
    const user = userEvent.setup();
    snap.discoverFetching = true;
    snap.catalogData = [{ name: CUSTOM }];
    snap.discoverData = { errors: [], manifestWarnings: [], valid: [{ name: CUSTOM }] };
    const { baseElement } = render(<NodeHealthBadge graph={graphWithCustomNode()} />);

    await user.click(screen.getByTitle('Custom node health'));
    expect(
      screen.getByRole('menuitem', { name: /Sync custom nodes to cloud/i }),
    ).toBeInTheDocument();
    const openMenu = baseElement.querySelector('[role="menu"]');
    expect(openMenu).toBeTruthy();
    expect(openMenu?.querySelectorAll('[role="separator"]').length ?? 0).toBe(0);
  });

  it('renders a separator between issue content and sync when there is body content', async () => {
    const user = userEvent.setup();
    snap.catalogData = [];
    snap.discoverData = { errors: [], manifestWarnings: [], valid: [{ name: CUSTOM }] };
    const { baseElement } = render(<NodeHealthBadge graph={graphWithCustomNode()} />);

    await user.click(screen.getByTitle('Custom node health'));
    expect(
      screen.getByText('Manifest not discovered locally — refresh custom nodes'),
    ).toBeInTheDocument();
    const openMenu = baseElement.querySelector('[role="menu"]');
    expect(openMenu?.querySelectorAll('[role="separator"]').length ?? 0).toBeGreaterThan(0);
  });
});
