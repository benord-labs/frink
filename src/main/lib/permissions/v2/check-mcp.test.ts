import { describe, expect, it } from 'vitest';
import { checkMcp } from './check-mcp';
import { EMPTY_DOCS } from './eval-rules';
import type { PermissionsDoc } from './types';

const noRules: PermissionsDoc = { allow: [], deny: [], ask: [] };

describe('checkMcp', () => {
  it('mcp__server__* allow rule matches any tool from server', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__shortcut__*'] },
      user: noRules,
    };
    expect(
      checkMcp({ toolName: 'mcp__shortcut__create_story', toolInput: {} }, docs),
    ).toMatchObject({ decision: 'allow' });
  });

  it('mcp__server__* does NOT match other servers', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__shortcut__*'] },
      user: noRules,
    };
    expect(checkMcp({ toolName: 'mcp__github__create_issue', toolInput: {} }, docs)).toMatchObject({
      decision: 'ask',
    });
  });

  it('specific MCP rule matches exact tool only', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__shortcut__create_story'] },
      user: noRules,
    };
    expect(
      checkMcp({ toolName: 'mcp__shortcut__create_story', toolInput: {} }, docs),
    ).toMatchObject({ decision: 'allow' });
    expect(
      checkMcp({ toolName: 'mcp__shortcut__update_story', toolInput: {} }, docs),
    ).toMatchObject({ decision: 'ask' });
  });

  it('resource-method rules do not authorize similarly named callable tools', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__context7__resources/read'] },
      user: noRules,
    };
    expect(
      checkMcp({ toolName: 'mcp__context7__resources/read', toolInput: {} }, docs),
    ).toMatchObject({ decision: 'allow' });
    expect(
      checkMcp({ toolName: 'mcp__context7__read_mcp_resource', toolInput: {} }, docs),
    ).toMatchObject({ decision: 'ask' });
  });

  it('no tier-1c — system-denied path in MCP input is irrelevant', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__filesystem__*'] },
      user: noRules,
    };
    // Even an MCP tool whose input mentions /etc/passwd is allowed by the rule.
    // Path-based safety lives in check-edit / check-bash, not here.
    expect(
      checkMcp({ toolName: 'mcp__filesystem__read', toolInput: { path: '/etc/passwd' } }, docs),
    ).toMatchObject({ decision: 'allow' });
  });

  it('empty docs → ask default with structured prompt', () => {
    const r = checkMcp(
      { toolName: 'mcp__shortcut__create_story', toolInput: { name: 'x' } },
      EMPTY_DOCS,
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { reason: 'no-matching-rule', tool: 'mcp__shortcut__create_story' },
    });
  });

  it('deny rule wins over allow', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__shortcut__*'], deny: ['mcp__shortcut__delete_story'] },
      user: noRules,
    };
    expect(
      checkMcp({ toolName: 'mcp__shortcut__delete_story', toolInput: {} }, docs),
    ).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'mcp__shortcut__delete_story', tier: 'project' },
    });
  });

  it('ask result attaches suggestedRules = [exact tool, server wildcard]', () => {
    const r = checkMcp({ toolName: 'mcp__shortcut__create_story', toolInput: {} }, EMPTY_DOCS);
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        suggestedRules: ['mcp__shortcut__create_story', 'mcp__shortcut__*'],
      },
    });
  });

  it('never suggests the server wildcard for a vendor-plugin server', () => {
    // claude-code namespaces plugin servers plugin_<name>_<server>; approving
    // one Slack tool must not offer a rule granting every vendor tool.
    const r = checkMcp(
      { toolName: 'mcp__plugin_slack_slack__slack_send_message', toolInput: {} },
      EMPTY_DOCS,
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { suggestedRules: ['mcp__plugin_slack_slack__slack_send_message'] },
    });
  });

  it('ask result with hyphenated server emits parse-valid suggestedRules', () => {
    const r = checkMcp(
      { toolName: 'mcp__shortcut-frink__stories-list', toolInput: {} },
      EMPTY_DOCS,
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        suggestedRules: ['mcp__shortcut-frink__stories-list', 'mcp__shortcut-frink__*'],
      },
    });
  });

  it('does not suggest a narrow rule for raw tool names that parse as wider rules', () => {
    for (const tool of ['delete(*)', '*']) {
      const r = checkMcp(
        {
          toolName: `mcp__s__${tool}`,
          toolInput: {},
          mcpIdentity: { server: 's', tool },
        },
        EMPTY_DOCS,
      );
      expect(r).toMatchObject({
        decision: 'ask',
        prompt: { suggestedRules: ['mcp__s__*'] },
      });
    }
  });

  it('allow result has no suggestedRules', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['mcp__shortcut__*'] },
      user: noRules,
    };
    const r = checkMcp({ toolName: 'mcp__shortcut__create_story', toolInput: {} }, docs);
    expect(r.decision).toBe('allow');
    expect('prompt' in r ? r.prompt : null).toBeFalsy();
  });

  it('deny rule with wildcard allow still respects deny-over-allow (regression for matcher precedence)', () => {
    const docs = {
      policy: noRules,
      project: {
        ...noRules,
        allow: ['mcp__shortcut-frink__*'],
        deny: ['mcp__shortcut-frink__delete-story'],
      },
      user: noRules,
    };
    expect(
      checkMcp({ toolName: 'mcp__shortcut-frink__delete-story', toolInput: {} }, docs),
    ).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'mcp__shortcut-frink__delete-story', tier: 'project' },
    });
    expect(
      checkMcp({ toolName: 'mcp__shortcut-frink__stories-list', toolInput: {} }, docs),
    ).toMatchObject({ decision: 'allow' });
  });

  it('malformed MCP tool name (no parse) yields ask without suggestedRules', () => {
    // Defensive: the executor gates `isMcp` on `startsWith('mcp__')` so a
    // string like `mcp__only-server` (no tool segment) would reach checkMcp.
    // parseMcpToolFullName returns null → suggestedRules omitted.
    const r = checkMcp({ toolName: 'mcp__only-server', toolInput: {} }, EMPTY_DOCS);
    expect(r.decision).toBe('ask');
    if (r.decision === 'ask') {
      expect(r.prompt.suggestedRules).toBeUndefined();
    }
  });
});
