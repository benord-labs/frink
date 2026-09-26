// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PermissionPresentation, PromptData } from '../../../../../shared/types/permissions';
import { PromptBody } from './index';

function makePrompt(overrides: Partial<PromptData> = {}): PromptData {
  return {
    tool: 'Bash',
    input: { command: 'npm test' },
    reason: 'no-matching-rule',
    ...overrides,
  };
}

function makeRegistrationPresentation(): PermissionPresentation {
  return {
    type: 'custom-node-registration',
    packagePath: 'nodes/image-reader',
    action: 'create',
    node: { name: 'actual-node-name', entrypoint: 'index.js' },
    source: { current: 'console.log({ ok: true });\n' },
    modules: [],
    resources: [],
    credentialNames: [],
    packageDigest: 'b'.repeat(64),
    packageBytes: 32,
    warning: 'Runs unsandboxed.',
  };
}

describe('PromptBody — Bash branch', () => {
  it('renders Bash header label + path as code', () => {
    render(
      <PromptBody
        prompt={makePrompt({ tool: 'Bash' })}
        isBash={true}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="this project"
        requestPath="npm test"
      />,
    );
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });

  it('renders long commands in full in the scroll block (no truncation, no expand toggle)', () => {
    const longCommand = `${'echo abc && '.repeat(20)}done`;
    render(
      <PromptBody
        prompt={makePrompt({ tool: 'Bash' })}
        isBash={true}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="this project"
        requestPath={longCommand}
      />,
    );
    // Whole command present (overflow handled by scroll, not truncation) and no expand button.
    expect(screen.getByText(longCommand)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show full command/i })).toBeNull();
  });
});

describe('PromptBody — file-op branch', () => {
  it('renders "Allow <tool> in <project>?" for in-project paths', () => {
    render(
      <PromptBody
        prompt={makePrompt({ tool: 'Edit', pathLocation: 'in-current-project' })}
        isBash={false}
        isFileOpTool={true}
        isPathInCurrentProject={true}
        projectDisplayName="frink"
        requestPath="/proj/src/foo.ts"
      />,
    );
    expect(screen.getByText('File')).toBeTruthy();
    expect(screen.getByText('edit')).toBeTruthy();
    expect(screen.getByText('frink')).toBeTruthy();
    expect(screen.getByText('/proj/src/foo.ts')).toBeTruthy();
  });

  it('renders "Allow <tool> for an external path?" for outside paths', () => {
    render(
      <PromptBody
        prompt={makePrompt({ tool: 'Read' })}
        isBash={false}
        isFileOpTool={true}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath="/etc/hosts"
      />,
    );
    expect(screen.getByText(/external path/i)).toBeTruthy();
  });
});

describe('PromptBody — MCP branch', () => {
  it('renders "MCP" label + friendly tool name + server', () => {
    render(
      <PromptBody
        prompt={makePrompt({ tool: 'mcp__shortcut-frink__stories-list' })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="this project"
        requestPath=""
      />,
    );
    expect(screen.getByText('MCP')).toBeTruthy();
    expect(screen.getByText('Stories List')).toBeTruthy();
    expect(screen.getByText('(shortcut-frink)')).toBeTruthy();
  });

  it('renders snake_case tool names with proper Title Case', () => {
    render(
      <PromptBody
        prompt={makePrompt({ tool: 'mcp__neon__create_database' })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="this project"
        requestPath=""
      />,
    );
    expect(screen.getByText('Create Database')).toBeTruthy();
    expect(screen.getByText('(neon)')).toBeTruthy();
  });

  it('does NOT render the path code block for MCP (request.path is empty)', () => {
    const { container } = render(
      <PromptBody
        prompt={makePrompt({ tool: 'mcp__shortcut-frink__stories-list' })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="this project"
        requestPath=""
      />,
    );
    // No <code> element should exist for the raw tool fullname; the only code
    // is the inline server-name tag rendered AS a code identifier — that's
    // expected. Assert the raw mcp__server__tool string is nowhere in the DOM.
    expect(container.textContent ?? '').not.toContain('mcp__shortcut-frink__stories-list');
  });

  it('uses the trusted custom-node presentation instead of the generic MCP summary', () => {
    render(
      <PromptBody
        prompt={makePrompt({
          tool: 'mcp__frink_dynamic_chat__frink_register_node',
          presentation: makeRegistrationPresentation(),
        })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath="agent-controlled summary"
      />,
    );

    expect(screen.getByText('Custom node')).toBeTruthy();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'STRONG' && element.textContent === 'Register “actual-node-name”?',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('agent-controlled summary')).toBeNull();
  });

  it('never uses a valid registration presentation for a noncanonical tool', () => {
    render(
      <PromptBody
        prompt={makePrompt({
          tool: 'mcp__untrusted__frink_register_node',
          presentation: makeRegistrationPresentation(),
        })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath="agent-controlled summary"
      />,
    );

    expect(screen.getByText('MCP')).toBeTruthy();
    expect(screen.queryByText('Custom node')).toBeNull();
    expect(screen.queryByText('Register “actual-node-name”?')).toBeNull();
  });

  it('drops a malformed registration presentation at the renderer boundary', () => {
    // SAFETY: Deliberately malformed runtime payload verifies renderer rejection.
    const malformedPresentation = {
      type: 'custom-node-registration',
      packagePath: 42,
    } as never;
    render(
      <PromptBody
        prompt={makePrompt({
          tool: 'mcp__frink_dynamic_chat__frink_register_node',
          presentation: malformedPresentation,
        })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath="agent-controlled summary"
      />,
    );

    expect(screen.getByText('MCP')).toBeTruthy();
    expect(screen.queryByText('Custom node')).toBeNull();
  });

  it('summarizes a Flow patch compactly without exposing IDs or configuration values', () => {
    const { container } = render(
      <PromptBody
        prompt={makePrompt({
          tool: 'mcp__frink_dynamic_chat__frink_flows_patch',
          input: {
            flowId: 'flow-1',
            operations: [
              {
                op: 'update_node',
                nodeId: 'reply-step-private-id',
                label: 'Post repo pulse',
                config: { messageTemplate: 'PRIVATE MESSAGE CONTENT' },
              },
              {
                op: 'add_edge',
                edge: {
                  id: 'private-edge-id',
                  source: 'private-source-id',
                  target: 'private-target-id',
                },
              },
              {
                op: 'update_settings',
                settings: { briefing: 'PRIVATE BRIEFING CONTENT' },
              },
            ],
          },
        })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath=""
      />,
    );

    expect(screen.getByText('Update this Flow?')).toBeTruthy();
    expect(
      screen.getByText('“Post repo pulse”: step name and reply message will change.'),
    ).toBeTruthy();
    expect(screen.getByText('Also updates 1 connection and Flow settings.')).toBeTruthy();
    expect(screen.getByText('Saves a new version. The Flow will not run.')).toBeTruthy();
    expect(container.querySelector('ol')).toBeNull();
    for (const hiddenValue of [
      'flow-1',
      'reply-step-private-id',
      'private-edge-id',
      'private-source-id',
      'private-target-id',
      'PRIVATE MESSAGE CONTENT',
      'PRIVATE BRIEFING CONTENT',
      'update_node',
      'add_edge',
      'update_settings',
    ]) {
      expect(container.textContent ?? '').not.toContain(hiddenValue);
    }
  });

  it('summarizes a new Flow by its graph shape and confirms it will not run', () => {
    render(
      <PromptBody
        prompt={makePrompt({
          tool: 'mcp__frink_dynamic_chat__frink_flows_patch',
          input: {
            name: 'Release automation',
            operations: [{ op: 'add_node' }, { op: 'add_node' }, { op: 'add_edge' }],
          },
        })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath=""
      />,
    );

    expect(screen.getByText('Create “Release automation”?')).toBeTruthy();
    expect(screen.getByText('Adds 2 steps and 1 connection.')).toBeTruthy();
    expect(screen.getByText('Saves the Flow. The Flow will not run.')).toBeTruthy();
  });

  it('aggregates an untargeted update without exposing raw operations', () => {
    const { container } = render(
      <PromptBody
        prompt={makePrompt({
          tool: 'mcp__frink_dynamic_chat__frink_flows_patch',
          input: {
            flowId: 'private-flow-id',
            operations: [
              { op: 'remove_node', nodeId: 'private-node-a' },
              { op: 'remove_node', nodeId: 'private-node-b' },
              { op: 'remove_edge', edgeId: 'private-edge' },
            ],
          },
        })}
        isBash={false}
        isFileOpTool={false}
        isPathInCurrentProject={false}
        projectDisplayName="frink"
        requestPath=""
      />,
    );

    expect(screen.getByText('Updates 2 steps and 1 connection.')).toBeTruthy();
    expect(container.textContent ?? '').not.toContain('private-');
  });
});
