// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ResourceInfo } from '@/types/resource-info';
import { AgentsHooksTab } from './index';

let hookData: ResourceInfo[] = [];

// oxlint-disable-next-line anti-slop/no-module-mocking -- the tRPC client needs Electron's preload; the tab reads hooks, projects and the home path
vi.mock('@/lib/trpc', () => ({
  trpc: {
    hooks: {
      getAggregatedHookInfo: { useQuery: () => ({ data: hookData, isLoading: false }) },
    },
    projects: { list: { useQuery: () => ({ data: [] }) } },
    external: {
      getHomePath: { useQuery: () => ({ data: '/Users/sam' }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

// The hooks scan never reports built-in, synced or gap state, so hook rows carry none.
function hook(name: string): ResourceInfo {
  const path = `/Users/sam/.frink/hooks/${name}.sh`;
  return {
    name,
    type: 'hook',
    enabled: true,
    scope: 'global',
    path,
    description: `${name} description`,
    config: { name, type: 'hook', source: 'frink', path, enabled: true },
  };
}

function renderTab() {
  render(
    <TooltipProvider>
      <AgentsHooksTab />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  hookData = [];
});

describe('AgentsHooksTab', () => {
  it('lists hooks without pills or Copy across', () => {
    hookData = [hook('format-on-edit'), hook('lint-on-stop')];
    renderTab();

    expect(screen.getByText('lint-on-stop')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^format-on-edit/ }));

    for (const pill of ['Built-in', 'Synced', /^Only in/]) {
      expect(screen.queryByText(pill)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Copy across…' })).not.toBeInTheDocument();
    expect(screen.getByText('/Users/sam/.frink/hooks/format-on-edit.sh')).toBeInTheDocument();
  });

  it('shows an empty state with no folder button', () => {
    renderTab();

    expect(screen.getByText('No hooks yet')).toBeInTheDocument();
    expect(
      screen.getByText('When you add one to your coding tool, it shows up here.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
