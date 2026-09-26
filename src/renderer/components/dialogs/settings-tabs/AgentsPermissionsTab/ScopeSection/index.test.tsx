// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionsDoc } from '../../../../../../shared/types/permissions';

const listProjectInvalidate = vi.fn().mockResolvedValue(undefined);
const listUserInvalidate = vi.fn().mockResolvedValue(undefined);

const addProjectRuleMutateAsync = vi.fn();
const addUserRuleMutateAsync = vi.fn();
const removeProjectRuleMutate = vi.fn();
const removeUserRuleMutate = vi.fn();

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      permissions: {
        listProjectRules: { invalidate: listProjectInvalidate },
        listUserRules: { invalidate: listUserInvalidate },
      },
    }),
    permissions: {
      addProjectRule: {
        useMutation: (opts: { onSuccess?: (r: unknown, v: unknown) => void } = {}) => ({
          mutateAsync: vi.fn(async (vars: unknown) => {
            const result = await addProjectRuleMutateAsync(vars);
            opts.onSuccess?.(result, vars);
            return result;
          }),
          isPending: false,
        }),
      },
      addUserRule: {
        useMutation: (opts: { onSuccess?: (r: unknown, v: unknown) => void } = {}) => ({
          mutateAsync: vi.fn(async (vars: unknown) => {
            const result = await addUserRuleMutateAsync(vars);
            opts.onSuccess?.(result, vars);
            return result;
          }),
          isPending: false,
        }),
      },
      removeProjectRule: {
        useMutation: (opts: { onSuccess?: (r: unknown, v: unknown) => void } = {}) => ({
          mutate: vi.fn((vars: unknown) => {
            removeProjectRuleMutate(vars);
            opts.onSuccess?.(undefined, vars);
          }),
          isPending: false,
        }),
      },
      removeUserRule: {
        useMutation: (opts: { onSuccess?: (r: unknown, v: unknown) => void } = {}) => ({
          mutate: vi.fn((vars: unknown) => {
            removeUserRuleMutate(vars);
            opts.onSuccess?.(undefined, vars);
          }),
          isPending: false,
        }),
      },
      listProjectRules: { useQuery: vi.fn() },
    },
  },
}));

import { ScopeSection } from './index';

const emptyDoc: PermissionsDoc = { allow: [], deny: [], ask: [] };
const populatedDoc: PermissionsDoc = {
  allow: ['Bash(npm:*)'],
  deny: ['Bash(rm:*)'],
  ask: ['Edit(src/**)'],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ScopeSection — rendering', () => {
  it('renders title and description', () => {
    render(
      <ScopeSection
        title="Project — Frink"
        description="Per-project rules."
        doc={emptyDoc}
        projectId="p1"
      />,
    );
    expect(screen.getByText('Project — Frink')).toBeTruthy();
    expect(screen.getByText('Per-project rules.')).toBeTruthy();
  });

  it('renders skeleton when doc is undefined', () => {
    render(<ScopeSection title="X" description="Y" doc={undefined} projectId="p1" />);
    expect(screen.getByLabelText(/Loading X rules/i)).toBeTruthy();
  });

  it('renders empty-state when all three buckets are empty', () => {
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} projectId="p1" />);
    expect(screen.getByText(/No rules in this scope/i)).toBeTruthy();
  });

  it('renders all family tabs and their default-tab type headings', () => {
    render(<ScopeSection title="X" description="Y" doc={populatedDoc} projectId="p1" />);
    // populatedDoc has Bash allow + Bash deny, plus Edit ask → two tabs:
    // Bash (shows Allowed + Denied), File ops (shows Asks). Default tab = Bash.
    expect(screen.getByRole('tab', { name: 'Bash' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'File ops' })).toBeTruthy();
    // Default Bash tab content visible.
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
    expect(screen.getAllByText('Bash(npm:*)').length).toBeGreaterThan(0);
    expect(screen.getByText('Bash(rm:*)')).toBeTruthy();
  });

  it('hides delete buttons and AddRuleInput when readOnly', () => {
    render(<ScopeSection title="Policy" description="Y" doc={populatedDoc} readOnly />);
    expect(screen.queryByRole('button', { name: /Delete rule/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/Bash\(npm:\*\)/i)).toBeNull();
  });

  it('renders the fixed Bash / File ops / MCP tabs (all servers grouped under MCP)', () => {
    const doc: PermissionsDoc = {
      allow: [
        'Bash(echo:*)',
        'Read',
        'mcp__codebase__searchCode',
        'mcp__shortcut-frink__stories-list',
      ],
      deny: [],
      ask: [],
    };
    render(<ScopeSection title="X" description="Y" doc={doc} projectId="p1" />);
    expect(screen.getByRole('tab', { name: 'Bash' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'File ops' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'MCP' })).toBeTruthy();
    // No per-server MCP tabs.
    expect(screen.queryByRole('tab', { name: 'MCP — codebase' })).toBeNull();
  });

  it('always renders Bash + File ops tabs; an empty family is clickable and shows an empty state', () => {
    const doc: PermissionsDoc = { allow: ['Bash(echo:*)'], deny: [], ask: [] };
    render(<ScopeSection title="X" description="Y" doc={doc} projectId="p1" />);
    // No disabled tabs — every tab is a real affordance.
    expect((screen.getByRole('tab', { name: 'Bash' }) as HTMLButtonElement).disabled).toBe(false);
    const fileOpsTab = screen.getByRole('tab', { name: 'File ops' }) as HTMLButtonElement;
    expect(fileOpsTab.disabled).toBe(false);
    // File ops has no rules in this scope → selecting it explains itself.
    fireEvent.mouseDown(fileOpsTab);
    fireEvent.click(fileOpsTab);
    expect(screen.getByText(/No File ops rules in this scope/i)).toBeTruthy();
  });

  it('defaults to the first non-empty tab when leading tabs are empty', () => {
    // Only an MCP rule → Bash + File ops render empty; MCP tab is the default.
    const doc: PermissionsDoc = { allow: ['mcp__codebase__searchCode'], deny: [], ask: [] };
    render(<ScopeSection title="X" description="Y" doc={doc} projectId="p1" />);
    // Default selection lands on the only non-empty tab, not the empty Bash tab.
    expect(screen.getByRole('tab', { name: 'MCP', selected: true })).toBeTruthy();
  });

  it('Other-only scope defaults to the trailing Other tab', () => {
    // Bash / File ops / MCP seed empty; Other is the only populated tab → default.
    const doc: PermissionsDoc = { allow: ['Task', 'WebFetch'], deny: [], ask: [] };
    render(<ScopeSection title="X" description="Y" doc={doc} projectId="p1" />);
    expect(screen.getByRole('tab', { name: 'Other', selected: true })).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
  });

  it('single-family allow-only doc ALWAYS shows the ALLOWED heading (layout stability across tab switches)', () => {
    const doc: PermissionsDoc = {
      allow: ['Bash(echo:*)', 'Bash(ls:*)'],
      deny: [],
      ask: [],
    };
    render(<ScopeSection title="X" description="Y" doc={doc} projectId="p1" />);
    expect(screen.getByRole('tab', { name: 'Bash' })).toBeTruthy();
    // Heading shown even when only one type → first rule sits in the same
    // vertical position regardless of which tab the user clicks into.
    expect(screen.getByText('Allowed')).toBeTruthy();
  });

  it('multi-type same-family doc renders ALLOWED / DENIED sub-headings inside the tab', () => {
    const doc: PermissionsDoc = {
      allow: ['Bash(echo:*)'],
      deny: ['Bash(rm:*)'],
      ask: [],
    };
    render(<ScopeSection title="X" description="Y" doc={doc} projectId="p1" />);
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('Denied')).toBeTruthy();
  });
});

describe('ScopeSection — delete', () => {
  it('project-scope delete calls removeProjectRule with ruleType', () => {
    render(<ScopeSection title="X" description="Y" doc={populatedDoc} projectId="p1" />);
    const deleteBtn = screen.getByRole('button', { name: 'Delete rule Bash(npm:*)' });
    fireEvent.click(deleteBtn);
    expect(removeProjectRuleMutate).toHaveBeenCalledWith({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
  });

  it('user-scope delete calls removeUserRule with ruleType', () => {
    render(<ScopeSection title="X" description="Y" doc={populatedDoc} userScope />);
    const deleteBtn = screen.getByRole('button', { name: 'Delete rule Bash(rm:*)' });
    fireEvent.click(deleteBtn);
    expect(removeUserRuleMutate).toHaveBeenCalledWith({
      ruleString: 'Bash(rm:*)',
      ruleType: 'deny',
    });
  });
});

describe('ScopeSection — AddRuleInput integration', () => {
  it('submit calls addProjectRule directly (no validateRule)', async () => {
    addProjectRuleMutateAsync.mockResolvedValueOnce({ ok: true });
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} projectId="p1" />);
    const input = screen.getByLabelText(/Rule string/i);
    fireEvent.change(input, { target: { value: 'Bash(npm:*)' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    });
    expect(addProjectRuleMutateAsync).toHaveBeenCalledWith({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
  });

  it('parse error surfaces inline; input not cleared', async () => {
    addProjectRuleMutateAsync.mockResolvedValueOnce({
      ok: false,
      error: 'validation',
      message: 'Invalid rule grammar',
    });
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} projectId="p1" />);
    const input = screen.getByLabelText(/Rule string/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bash(:*)' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Invalid rule grammar');
    expect(input.value).toBe('Bash(:*)');
  });

  it('duplicate error surfaces inline', async () => {
    addProjectRuleMutateAsync.mockResolvedValueOnce({
      ok: false,
      error: 'duplicate',
      message: 'Rule already exists in this scope',
    });
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} projectId="p1" />);
    const input = screen.getByLabelText(/Rule string/i);
    fireEvent.change(input, { target: { value: 'Bash(npm:*)' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Rule already exists in this scope');
  });

  it('on success: invalidates list query and clears input', async () => {
    addProjectRuleMutateAsync.mockResolvedValueOnce({ ok: true });
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} projectId="p1" />);
    const input = screen.getByLabelText(/Rule string/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bash(npm:*)' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    });
    expect(listProjectInvalidate).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(input.value).toBe('');
  });

  it('user-scope add calls addUserRule and invalidates listUserRules', async () => {
    addUserRuleMutateAsync.mockResolvedValueOnce({ ok: true });
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} userScope />);
    fireEvent.change(screen.getByLabelText(/Rule string/i), { target: { value: 'Bash(ls:*)' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    });
    expect(addUserRuleMutateAsync).toHaveBeenCalledWith({
      ruleString: 'Bash(ls:*)',
      ruleType: 'allow',
    });
    expect(listUserInvalidate).toHaveBeenCalled();
  });
});

describe('ScopeSection — Select / form interaction', () => {
  it('Enter inside the rule-type Select does NOT submit the form', async () => {
    render(<ScopeSection title="X" description="Y" doc={emptyDoc} projectId="p1" />);
    const input = screen.getByLabelText(/Rule string/i);
    fireEvent.change(input, { target: { value: 'Bash(npm:*)' } });

    // Fire Enter on the SelectTrigger directly (Radix renders type="button", so
    // a stray Enter must not bubble to the form's onSubmit).
    const selectTrigger = screen.getByLabelText(/Rule type/i);
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: 'Enter', code: 'Enter' });
    });
    expect(addProjectRuleMutateAsync).not.toHaveBeenCalled();
  });
});

describe('ScopeSection — per-section isolation', () => {
  it('two sections with different docs render isolated rule lists', () => {
    render(
      <>
        <ScopeSection
          title="Project A"
          description=""
          doc={{ allow: ['Bash(a:*)'], deny: [], ask: [] }}
          projectId="a"
        />
        <ScopeSection
          title="Project B"
          description=""
          doc={{ allow: ['Bash(b:*)'], deny: [], ask: [] }}
          projectId="b"
        />
      </>,
    );
    expect(screen.getByText('Bash(a:*)')).toBeTruthy();
    expect(screen.getByText('Bash(b:*)')).toBeTruthy();
  });
});
