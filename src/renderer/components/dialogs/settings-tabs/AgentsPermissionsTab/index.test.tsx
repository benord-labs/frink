// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPolicyDocMock = vi.fn();
const listUserRulesMock = vi.fn();
const listProjectRulesMock = vi.fn();
const getSystemDeniedPathsMock = vi.fn();
const getSystemWriteDeniedPathsMock = vi.fn();
const projectsListMock = vi.fn();

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      permissions: {
        listProjectRules: { invalidate: vi.fn() },
        listUserRules: { invalidate: vi.fn() },
      },
    }),
    permissions: {
      getPolicyDoc: { useQuery: (...args: unknown[]) => getPolicyDocMock(...args) },
      listUserRules: { useQuery: (...args: unknown[]) => listUserRulesMock(...args) },
      listProjectRules: { useQuery: (...args: unknown[]) => listProjectRulesMock(...args) },
      getSystemDeniedPaths: { useQuery: (...args: unknown[]) => getSystemDeniedPathsMock(...args) },
      getSystemWriteDeniedPaths: {
        useQuery: (...args: unknown[]) => getSystemWriteDeniedPathsMock(...args),
      },
      addProjectRule: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ ok: true }),
          isPending: false,
        }),
      },
      addUserRule: {
        useMutation: () => ({
          mutateAsync: vi.fn().mockResolvedValue({ ok: true }),
          isPending: false,
        }),
      },
      removeProjectRule: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      removeUserRule: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    projects: {
      list: { useQuery: (...args: unknown[]) => projectsListMock(...args) },
    },
  },
}));

import { AgentsPermissionsTab } from './index';

const loadedQuery = <T,>(data: T) => ({ data, isLoading: false, refetch: vi.fn() });
const loadingQuery = () => ({ data: undefined, isLoading: true, refetch: vi.fn() });

const emptyDoc = { allow: [], deny: [], ask: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getPolicyDocMock.mockReturnValue(loadedQuery(emptyDoc));
  listUserRulesMock.mockReturnValue(loadedQuery(emptyDoc));
  listProjectRulesMock.mockReturnValue(loadedQuery(emptyDoc));
  getSystemDeniedPathsMock.mockReturnValue(loadedQuery([]));
  getSystemWriteDeniedPathsMock.mockReturnValue(loadedQuery([]));
  projectsListMock.mockReturnValue(loadedQuery([]));
});

describe('AgentsPermissionsTab', () => {
  it('shows loading state during initial fetch', () => {
    getPolicyDocMock.mockReturnValue(loadingQuery());
    render(<AgentsPermissionsTab />);
    expect(screen.getByText(/Loading permissions/i)).toBeTruthy();
  });

  it('renders Policy and User sections when no projects', () => {
    render(<AgentsPermissionsTab />);
    expect(screen.getByText('Policy')).toBeTruthy();
    expect(screen.getByText('User')).toBeTruthy();
  });

  it('renders one ProjectScopeSection per project', () => {
    projectsListMock.mockReturnValue(
      loadedQuery([
        { id: 'p1', name: 'Frink' },
        { id: 'p2', name: 'Other' },
      ]),
    );
    render(<AgentsPermissionsTab />);
    expect(screen.getByText('Project — Frink')).toBeTruthy();
    expect(screen.getByText('Project — Other')).toBeTruthy();
  });

  it('Policy section is read-only (no AddRuleInput, no delete buttons)', () => {
    getPolicyDocMock.mockReturnValue(loadedQuery({ allow: ['Bash(npm:*)'], deny: [], ask: [] }));
    render(<AgentsPermissionsTab />);
    // The Policy section has no AddRuleInput. With User section rendering its own
    // AddRuleInput, there will be 1 input total; if Policy added its own there would be 2.
    const ruleInputs = screen.getAllByLabelText(/Rule string/i);
    expect(ruleInputs).toHaveLength(1);
    // The single Policy rule has no delete button.
    expect(screen.queryByRole('button', { name: 'Delete rule Bash(npm:*)' })).toBeNull();
  });

  it('mixed loading: project p2 still loading shows skeleton; p1 resolved renders rules', () => {
    projectsListMock.mockReturnValue(
      loadedQuery([
        { id: 'p1', name: 'Alpha' },
        { id: 'p2', name: 'Beta' },
      ]),
    );
    // p1 → resolved with one rule; p2 → still loading
    listProjectRulesMock.mockImplementation(({ projectId }: { projectId: string }) =>
      projectId === 'p1'
        ? loadedQuery({ allow: ['Bash(p1-rule:*)'], deny: [], ask: [] })
        : loadingQuery(),
    );
    render(<AgentsPermissionsTab />);
    // p1 section renders its rule
    expect(screen.getByText('Bash(p1-rule:*)')).toBeTruthy();
    // p2 section renders the skeleton (ScopeSection's loading guard)
    expect(screen.getByLabelText(/Loading Project — Beta rules/i)).toBeTruthy();
  });
  it('lists write-blocked shell startup files under their own label', () => {
    getSystemDeniedPathsMock.mockReturnValue(loadedQuery(['**/.ssh/**']));
    getSystemWriteDeniedPathsMock.mockReturnValue(loadedQuery(['~/.zshrc', '~/.config/fish']));
    render(<AgentsPermissionsTab />);
    expect(screen.getByText(/Write-blocked/)).toBeInTheDocument();
    expect(screen.getByText('~/.zshrc')).toBeInTheDocument();
    expect(screen.getByText('~/.config/fish')).toBeInTheDocument();
    expect(screen.getByText('**/.ssh/**')).toBeInTheDocument();
  });

  it('keeps the page in its loading state until the write-blocked list has loaded', () => {
    getSystemDeniedPathsMock.mockReturnValue(loadedQuery(['**/.ssh/**']));
    getSystemWriteDeniedPathsMock.mockReturnValue(loadingQuery());
    render(<AgentsPermissionsTab />);
    expect(screen.getByText(/Loading permissions/i)).toBeInTheDocument();
    expect(screen.queryByText('**/.ssh/**')).toBeNull();
  });
});
