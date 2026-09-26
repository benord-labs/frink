// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { parseRule } from '../../../shared/lib/rule-parser';
import type { PermissionRequest } from '../../hooks/usePermissionPrompts';
import { PermissionPrompt } from './index';
import { buildFallbackRule } from './RuleStringDropdown';

function makeMoveChatRequest(): PermissionRequest {
  return {
    requestId: 'move-1',
    scope: { type: 'folder', folderId: '' },
    path: 'Acme',
    operation: 'move_chat',
    moveChatPayload: {
      targetChatId: 'c',
      targetSubChatId: 's',
      projectName: 'Acme',
      prompt: '',
      projectPath: '/proj',
      requestedWorktreePath: null,
      targetBranch: null,
    },
  };
}

function makeBashRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'bash-1',
    scope: { type: 'bash' },
    path: 'npm test',
    operation: 'bash',
    projectPath: '/proj',
    isRemote: true,
    chatId: 'c',
    subChatId: 's',
    prompt: {
      tool: 'Bash',
      input: { command: 'npm test' },
      reason: 'no-matching-rule',
      suggestedRules: ['Bash(npm test:*)', 'Bash(npm:*)'],
    },
    ...overrides,
  };
}

function makeMcpRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'mcp-1',
    scope: { type: 'folder', folderId: '' },
    path: '',
    operation: 'mcp_tool',
    projectPath: '/proj',
    projectName: 'frink',
    isRemote: true,
    chatId: 'c',
    subChatId: 's',
    mcpToolPayload: {
      toolName: 'mcp__shortcut-frink__stories-list',
      summary: '',
    },
    prompt: {
      tool: 'mcp__shortcut-frink__stories-list',
      input: {},
      reason: 'no-matching-rule',
      suggestedRules: ['mcp__shortcut-frink__stories-list', 'mcp__shortcut-frink__*'],
    },
    ...overrides,
  };
}

describe('PermissionPrompt — view-switch', () => {
  it('routes move-chat to SimpleApprovalView (no prompt → 2 buttons)', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <PermissionPrompt request={makeMoveChatRequest()} onApprove={onApprove} onDeny={onDeny} />,
    );
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Deny$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Allow this time/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /In this project/i })).toBeNull();
  });

  it('SimpleApprovalView Deny calls onDeny with requestId', () => {
    const onDeny = vi.fn();
    render(
      <PermissionPrompt request={makeMoveChatRequest()} onApprove={vi.fn()} onDeny={onDeny} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Deny$/ }));
    expect(onDeny).toHaveBeenCalledWith('move-1');
  });

  it('routes bash with prompt to FourButtonView (4 buttons)', () => {
    render(<PermissionPrompt request={makeBashRequest()} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Deny$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow this time/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /In this project/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /On this machine/i })).toBeTruthy();
  });
});

describe('PermissionPrompt — FourButtonView responses', () => {
  it('"Allow this time" emits no scope', () => {
    const onApprove = vi.fn();
    render(<PermissionPrompt request={makeBashRequest()} onApprove={onApprove} onDeny={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Allow this time/i }));
    expect(onApprove).toHaveBeenCalledWith('bash-1', {});
  });

  it('"In this project" emits scope=project + ruleString + ruleType', () => {
    const onApprove = vi.fn();
    render(<PermissionPrompt request={makeBashRequest()} onApprove={onApprove} onDeny={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /In this project/i }));
    expect(onApprove).toHaveBeenCalledWith('bash-1', {
      scope: 'project',
      ruleString: 'Bash(npm test:*)',
      ruleType: 'allow',
    });
  });

  it('"On this machine" emits scope=user', () => {
    const onApprove = vi.fn();
    render(<PermissionPrompt request={makeBashRequest()} onApprove={onApprove} onDeny={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /On this machine/i }));
    expect(onApprove).toHaveBeenCalledWith('bash-1', {
      scope: 'user',
      ruleString: 'Bash(npm test:*)',
      ruleType: 'allow',
    });
  });

  it('Deny calls onDeny only', () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeBashRequest()} onApprove={onApprove} onDeny={onDeny} />);
    fireEvent.click(screen.getByRole('button', { name: /^Deny$/ }));
    expect(onDeny).toHaveBeenCalledWith('bash-1');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('"In this project" is inert (aria-disabled, focusable) when no projectPath', () => {
    const noProjReq = makeBashRequest({ projectPath: undefined });
    render(<PermissionPrompt request={noProjReq} onApprove={vi.fn()} onDeny={vi.fn()} />);
    const allowForProject = screen.getByRole('button', { name: /In this project/i });
    // aria-disabled (not `disabled`) keeps it keyboard-focusable so the
    // explanatory tooltip is reachable; no onClick → still a no-op.
    expect((allowForProject as HTMLButtonElement).disabled).toBe(false);
    expect(allowForProject.getAttribute('aria-disabled')).toBe('true');
  });

  it('$1 in command renders verbatim (no shell-quote expansion)', () => {
    const req = makeBashRequest({ path: 'echo "$1"' });
    render(<PermissionPrompt request={req} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByText(/echo "\$1"/)).toBeTruthy();
  });

  it('MCP "In this project" emits suggestedRules[0] as ruleString (locks persistence path)', () => {
    const onApprove = vi.fn();
    render(<PermissionPrompt request={makeMcpRequest()} onApprove={onApprove} onDeny={vi.fn()} />);
    expect(screen.getByRole('combobox').textContent).toBe('mcp__shortcut-frink__stories-list');
    fireEvent.click(screen.getByRole('button', { name: /In this project/i }));
    expect(onApprove).toHaveBeenCalledWith('mcp-1', {
      scope: 'project',
      ruleString: 'mcp__shortcut-frink__stories-list',
      ruleType: 'allow',
    });
  });

  it('names the plugin and action while preserving the exact persistent permission rule', () => {
    const onApprove = vi.fn();
    const rule = 'mcp__plugin_linear_linear__list_issues';
    const { container } = render(
      <PermissionPrompt
        request={makeMcpRequest({
          prompt: {
            tool: rule,
            input: { limit: 3 },
            reason: 'no-matching-rule',
            suggestedRules: [rule],
          },
        })}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );

    expect(screen.getByText('(Linear)')).toBeTruthy();
    expect(screen.getByText('List Issues')).toBeTruthy();
    const ruleSelector = screen.getByRole('combobox', { name: 'Permission rule' });
    expect(ruleSelector.textContent).toBe('Linear · List Issues');
    expect(ruleSelector.getAttribute('title')).toBe(rule);
    expect(ruleSelector.getAttribute('aria-description')).toBe(rule);
    fireEvent.click(ruleSelector);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Linear · List Issues' }));
    expect(container.textContent ?? '').not.toContain('plugin_linear_linear');
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /In this project/i }));
    expect(onApprove).toHaveBeenCalledWith('mcp-1', {
      scope: 'project',
      ruleString: rule,
      ruleType: 'allow',
    });
  });

  it('humanizes the persistent Flow rule without changing the emitted rule value', () => {
    const onApprove = vi.fn();
    const rule = 'mcp__frink_dynamic_chat__frink_flows_patch';
    const { container } = render(
      <PermissionPrompt
        request={makeMcpRequest({
          requestId: 'flow-patch-1',
          mcpToolPayload: { toolName: rule, summary: '' },
          prompt: {
            tool: rule,
            input: { flowId: 'private-flow-id', operations: [] },
            reason: 'no-matching-rule',
            suggestedRules: [rule, 'mcp__frink_dynamic_chat__*'],
          },
        })}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );

    expect(screen.getByText('Flow changes')).toBeTruthy();
    expect(container.textContent ?? '').not.toContain(rule);

    const ruleSelector = screen.getByRole('combobox');
    fireEvent.click(ruleSelector);
    expect(screen.getByText('All Frink tools')).toBeTruthy();
    fireEvent.keyDown(ruleSelector, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: /In this project/i }));

    expect(onApprove).toHaveBeenCalledWith('flow-patch-1', {
      scope: 'project',
      ruleString: rule,
      ruleType: 'allow',
    });
  });

  it('MCP request renders FourButtonView (4 buttons) when prompt is present', () => {
    render(<PermissionPrompt request={makeMcpRequest()} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Deny$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow this time/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /In this project/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /On this machine/i })).toBeTruthy();
  });
});

describe('PermissionPrompt — DenyReasonBanner', () => {
  it('renders rule:ask banner with matched rule + tier', () => {
    const req = makeBashRequest({
      prompt: {
        tool: 'Bash',
        input: { command: 'npm test' },
        reason: 'rule:ask',
        matchedRule: 'Bash(npm:*)',
        matchedTier: 'project',
        suggestedRules: ['Bash(npm:*)'],
      },
    });
    render(<PermissionPrompt request={req} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByText(/Asking because of rule/i)).toBeTruthy();
    // `Bash(npm:*)` appears both in banner + dropdown (suggestedRules) — assert count.
    expect(screen.getAllByText('Bash(npm:*)').length).toBeGreaterThan(0);
    expect(screen.getByText('project')).toBeTruthy();
  });

  it('omits the persist options when the dispatcher found no rule that can express the command', () => {
    // An EMPTY suggestion list means no rule could match on replay, so offering
    // "Always allow" would promise something the matcher discards.
    const req = makeBashRequest({
      path: 'echo $HOME *',
      prompt: {
        tool: 'Bash',
        input: { command: 'echo $HOME *' },
        reason: 'no-matching-rule',
        suggestedRules: [],
      },
    });
    render(<PermissionPrompt request={req} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Allow this time' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(screen.queryByText('Always allow')).toBeNull();
    expect(screen.queryByRole('button', { name: 'On this machine' })).toBeNull();
  });

  it('renders over-50-subcommands banner', () => {
    const req = makeBashRequest({
      prompt: {
        tool: 'Bash',
        input: { command: 'a; b; c' },
        reason: 'over-50-subcommands',
      },
    });
    render(<PermissionPrompt request={req} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByText(/Compound command has too many parts/i)).toBeTruthy();
  });

  it('renders no banner for no-matching-rule', () => {
    render(<PermissionPrompt request={makeBashRequest()} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.queryByText(/Asking because of rule/i)).toBeNull();
    expect(screen.queryByText(/Compound command has too many parts/i)).toBeNull();
  });
});

describe('PermissionPrompt — keyboard shortcuts', () => {
  it('Enter triggers the primary "Allow this time" (no persistent grant) — with project', () => {
    const onApprove = vi.fn();
    render(<PermissionPrompt request={makeBashRequest()} onApprove={onApprove} onDeny={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledWith('bash-1', {});
  });

  it('Enter triggers "Allow this time" regardless of project context', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeBashRequest({ projectPath: undefined })}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledWith('bash-1', {});
  });

  it('Escape triggers Deny', () => {
    const onDeny = vi.fn();
    render(<PermissionPrompt request={makeBashRequest()} onApprove={vi.fn()} onDeny={onDeny} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDeny).toHaveBeenCalledWith('bash-1');
  });
});

function makeFileOpRequest(
  tool: 'Read' | 'Edit' | 'Write' | 'Delete' | 'MultiEdit' | 'NotebookEdit',
  pathLocation: 'in-current-project' | 'outside',
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  const operation = tool === 'Read' ? 'read' : tool === 'Delete' ? 'delete' : 'write';
  return {
    requestId: `${tool.toLowerCase()}-1`,
    scope: { type: 'folder', folderId: 'frink' },
    path: '/proj/src/data/changelog.ts',
    operation,
    projectPath: '/proj',
    projectName: 'frink',
    isRemote: true,
    chatId: 'c',
    subChatId: 's',
    prompt: {
      tool,
      input: { file_path: '/proj/src/data/changelog.ts' },
      reason: 'no-matching-rule',
      pathLocation,
      suggestedRules: pathLocation === 'in-current-project' ? [tool] : [],
    },
    ...overrides,
  };
}

describe('PermissionPrompt — file-op flow (ticket 15)', () => {
  it('in-project Read: shows 3 buttons (Deny / Allow this time / Allow Read for {project}), no machine button, no dropdown', () => {
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Read', 'in-current-project')}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Deny$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow this time/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Allow Read for frink/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /On this machine/i })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('in-project Edit: "Allow Edit for {project}" emits scope=project + ruleString=Edit (tool-wide)', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Edit', 'in-current-project')}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Allow Edit for frink/i }));
    expect(onApprove).toHaveBeenCalledWith('edit-1', {
      scope: 'project',
      ruleString: 'Edit',
      ruleType: 'allow',
    });
  });

  it('outside path: persistent button is hidden entirely; Allow this time still works', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Read', 'outside')}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Allow Read for/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Allow this time/i }));
    expect(onApprove).toHaveBeenCalledWith('read-1', {});
  });

  it('no project context: persistent button is hidden entirely', () => {
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Read', 'in-current-project', {
          projectPath: undefined,
          projectName: undefined,
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Allow Read/i })).toBeNull();
  });

  it('header copy: in-project shows "Allow read in {project}?"', () => {
    const { container } = render(
      <PermissionPrompt
        request={makeFileOpRequest('Read', 'in-current-project')}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    const titleText = container.textContent ?? '';
    expect(titleText).toContain('Allow read in');
    expect(titleText).toContain('frink');
  });

  it('header copy: outside path shows "Allow {tool} for an external path?"', () => {
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Read', 'outside')}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(/for an external path/i)).toBeTruthy();
  });

  it('Enter key on in-project file op triggers the persistent button', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Write', 'in-current-project')}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledWith('write-1', {
      scope: 'project',
      ruleString: 'Write',
      ruleType: 'allow',
    });
  });

  it('Enter key on outside file op falls back to Allow this time (no machine option)', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeFileOpRequest('Read', 'outside')}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onApprove).toHaveBeenCalledWith('read-1', {});
  });

  it('all 6 PATH_TOOLS produce a tool-wide button label and emit the tool-name verbatim', () => {
    const tools = ['Read', 'Edit', 'Write', 'Delete', 'MultiEdit', 'NotebookEdit'] as const;
    for (const tool of tools) {
      const onApprove = vi.fn();
      const { unmount } = render(
        <PermissionPrompt
          request={makeFileOpRequest(tool, 'in-current-project')}
          onApprove={onApprove}
          onDeny={vi.fn()}
        />,
      );
      const btn = screen.getByRole('button', { name: new RegExp(`Allow ${tool} for frink`, 'i') });
      fireEvent.click(btn);
      expect(onApprove).toHaveBeenCalledWith(`${tool.toLowerCase()}-1`, {
        scope: 'project',
        ruleString: tool,
        ruleType: 'allow',
      });
      unmount();
    }
  });
});

describe('buildFallbackRule', () => {
  it('escapes parens so parseRule accepts the rule', () => {
    const rule = buildFallbackRule('Bash', 'node -e "console.log(1)"');
    expect(rule).toBe('Bash(node -e "console.log\\(1\\)":*)');
    const parsed = parseRule(rule);
    expect('error' in parsed).toBe(false);
  });

  it('produces a clean Bash rule when no parens', () => {
    const rule = buildFallbackRule('Bash', 'npm test');
    expect(rule).toBe('Bash(npm test:*)');
    const parsed = parseRule(rule);
    expect('error' in parsed).toBe(false);
  });

  it('produces a clean Edit rule for path-based tools', () => {
    const rule = buildFallbackRule('Edit', '/proj/src/foo.ts');
    expect(rule).toBe('Edit(/proj/src/foo.ts)');
    const parsed = parseRule(rule);
    expect('error' in parsed).toBe(false);
  });

  it('collapses a multi-line heredoc to its first line (never embeds the body)', () => {
    // `bash <<EOF` has its base suppressed by BARE_SHELL_PREFIXES, so the prompt
    // falls back here — it must NOT persist the whole body as a dead rule.
    const rule = buildFallbackRule('Bash', 'bash <<EOF\nrm -rf /\nEOF');
    expect(rule).toBe('Bash(bash <<EOF:*)');
    const parsed = parseRule(rule);
    expect('error' in parsed).toBe(false);
  });
});

const FLOW_CONSENT_PAYLOAD = {
  flowId: 'flow-abc',
  flowName: 'Nightly digest',
  summary: { nodeCount: 3, blockTypes: ['manual_trigger', 'agent'], unsandboxedBlockTypes: [] },
  allowOnce: true,
};

function makeFlowConsentRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'flow-1',
    scope: { type: 'folder', folderId: '' },
    path: 'flow-abc',
    operation: 'flow_consent',
    isRemote: true,
    chatId: 'c',
    subChatId: 's',
    flowConsent: FLOW_CONSENT_PAYLOAD,
    ...overrides,
  };
}

describe('PermissionPrompt — per-flow agent-run consent', () => {
  it('routes a flow-consent request to the consent card', () => {
    render(
      <PermissionPrompt request={makeFlowConsentRequest()} onApprove={vi.fn()} onDeny={vi.fn()} />,
    );

    expect(screen.getByText(/Let this chat's agent run "Nightly digest"\?/)).toBeTruthy();
  });

  it('prefers the consent card even when a v2 prompt payload rides along', () => {
    // Routing order matters: falling through to FourButtonView would offer
    // rule scopes that mean nothing for a per-flow grant.
    render(
      <PermissionPrompt
        request={makeFlowConsentRequest({
          prompt: {
            tool: 'mcp__frink_dynamic_chat__frink_flows_run',
            input: {},
            reason: 'no-matching-rule',
            suggestedRules: [],
          },
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Always allow this Flow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Always allow$/ })).toBeNull();
  });

  it('emits a flow grant, not a permission-rule scope, for "Always allow this Flow"', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeFlowConsentRequest()}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Always allow this Flow' }));

    expect(onApprove).toHaveBeenCalledWith('flow-1', { flowGrant: true });
  });

  it('emits a bare approval for a one-call allow so nothing is persisted', () => {
    const onApprove = vi.fn();
    render(
      <PermissionPrompt
        request={makeFlowConsentRequest()}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));

    expect(onApprove).toHaveBeenCalledWith('flow-1');
  });

  it('hides the one-call button under Auto, where it could never be honoured', () => {
    render(
      <PermissionPrompt
        request={makeFlowConsentRequest({
          flowConsent: { ...FLOW_CONSENT_PAYLOAD, allowOnce: false },
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Always allow this Flow' })).toBeTruthy();
  });

  it('states the batch size, so "once" cannot read as a single run', () => {
    render(
      <PermissionPrompt
        request={makeFlowConsentRequest({
          flowConsent: {
            ...FLOW_CONSENT_PAYLOAD,
            summary: {
              nodeCount: 3,
              blockTypes: ['agent'],
              unsandboxedBlockTypes: [],
              batch: { stageCount: 4, pendingRunCount: 120 },
            },
          },
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    expect(screen.getByText(/120 runs across 4 stages/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Run this batch once' })).toBeTruthy();
  });

  it('warns when the flow will execute commands on this machine', () => {
    render(
      <PermissionPrompt
        request={makeFlowConsentRequest({
          flowConsent: {
            ...FLOW_CONSENT_PAYLOAD,
            summary: {
              nodeCount: 2,
              blockTypes: ['manual_trigger', 'run_command'],
              unsandboxedBlockTypes: ['run_command'],
            },
          },
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    expect(screen.getByText(/Runs commands on this machine \(run_command\)/)).toBeTruthy();
  });

  it('denies without granting anything', () => {
    const onDeny = vi.fn();
    render(
      <PermissionPrompt request={makeFlowConsentRequest()} onApprove={vi.fn()} onDeny={onDeny} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(onDeny).toHaveBeenCalledWith('flow-1');
  });
});
