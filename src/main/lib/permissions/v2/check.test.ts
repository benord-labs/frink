import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../db/test-utils/fresh-db';
import { checkPermission, resetDocsLoader, setDocsLoader } from './check';
import { buildPermissionDecisionInput } from './context';
import { resolveScopes } from './scope-resolver';
import type { PermissionRequest, PermissionsDoc } from './types';

const noRules: PermissionsDoc = { allow: [], deny: [], ask: [] };

const baseReq = (overrides: Partial<PermissionRequest>): PermissionRequest => ({
  tool: '',
  input: {},
  projectId: 'p1',
  projectPath: '/home/user/project',
  ...overrides,
});

afterEach(() => {
  resetDocsLoader();
});

describe('checkPermission — dispatcher routing', () => {
  it('Bash → routes to checkBash', async () => {
    // Only checkBash emits a Bash-shaped prompt, so an ask proves the routing.
    const r = await checkPermission(baseReq({ tool: 'Bash', input: { command: 'cd ../../etc' } }));
    expect(r).toMatchObject({ decision: 'ask', prompt: { tool: 'Bash' } });
  });

  it('Bash with command substitution reaches the ask bucket, never a deny', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'Bash', input: { command: 'echo $(whoami)' } }),
    );
    expect(r).toMatchObject({ decision: 'ask', prompt: { tool: 'Bash' } });
  });

  it('Edit → routes to checkEdit', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'Edit', input: { file_path: '/home/user/project/.env' } }),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('Read → routes to checkEdit (path tool)', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'Read', input: { file_path: '/home/user/project/.env' } }),
    );
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('Write → routes to checkEdit (path tool)', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'Write', input: { file_path: '/home/user/project/.git/config' } }),
    );
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('Delete → routes to checkEdit (path tool)', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'Delete', input: { file_path: '/home/user/project/.env' } }),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('MultiEdit → routes to checkEdit (path tool)', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'MultiEdit', input: { file_path: '/home/user/project/.env' } }),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('NotebookEdit → routes to checkEdit (path tool)', async () => {
    const r = await checkPermission(
      baseReq({
        tool: 'NotebookEdit',
        input: { file_path: '/home/user/project/.git/config' },
      }),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('mcp__server__tool → routes to checkMcp', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, allow: ['mcp__shortcut__*'] },
      user: noRules,
    }));
    const r = await checkPermission(baseReq({ tool: 'mcp__shortcut__create_story', input: {} }));
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('frink-owned read/infra MCP tool → auto-allow (trusted, bypasses checkMcp)', async () => {
    // Even an explicit deny rule is ignored — frink's own read/infra tools are
    // trusted. Mutating flow tools are the exception below. Codex flow
    // writes reach this same dispatcher via dynamic-chat-server.gateFlowWrite.
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, deny: ['mcp__frink_dynamic_chat__*'] },
      user: noRules,
    }));
    const r = await checkPermission(
      baseReq({ tool: 'mcp__frink_dynamic_chat__frink_flows_list', input: {} }),
    );
    expect(r).toEqual({ decision: 'allow' });
  });

  it('does not trust a same-name Frink MCP when the provider rejects its provenance', async () => {
    const r = await checkPermission(
      baseReq({
        tool: 'mcp__frink__read_something',
        input: {},
        trustedFrinkOwnedMcp: false,
      }),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('frink mutating flow tool with no rules → asks with narrow + server-wide suggestions', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'mcp__frink_dynamic_chat__frink_flows_patch', input: {} }),
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        suggestedRules: [
          'mcp__frink_dynamic_chat__frink_flows_patch',
          'mcp__frink_dynamic_chat__*',
        ],
      },
    });
  });

  it('frink mutating flow tool honors an explicit deny rule', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, deny: ['mcp__frink_dynamic_chat__*'] },
      user: noRules,
    }));
    const r = await checkPermission(
      baseReq({ tool: 'mcp__frink_dynamic_chat__frink_flows_patch', input: {} }),
    );
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('frink mutating flow tool asks under the `frink` server key too (external-CLI identity)', async () => {
    // Rules learned as mcp__frink_dynamic_chat__* do NOT cover this identity;
    // it must still consult rules rather than fall to the trust auto-allow.
    const r = await checkPermission(baseReq({ tool: 'mcp__frink__frink_flows_patch', input: {} }));
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { suggestedRules: ['mcp__frink__frink_flows_patch', 'mcp__frink__*'] },
    });
  });

  it('frink mutating flow tool honors an allow rule (always-allow persistence)', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, allow: ['mcp__frink_dynamic_chat__frink_flows_patch'] },
      user: noRules,
    }));
    const r = await checkPermission(
      baseReq({ tool: 'mcp__frink_dynamic_chat__frink_flows_patch', input: {} }),
    );
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('non-frink MCP tool with no rule → still asks (checkMcp not bypassed)', async () => {
    const r = await checkPermission(baseReq({ tool: 'mcp__shortcut__create_story', input: {} }));
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('does not let a server wildcard authorize a prefix-colliding MCP server', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, allow: ['mcp__frink__*'] },
      user: noRules,
    }));
    const r = await checkPermission(
      baseReq({
        tool: 'mcp__frink__evil__x',
        input: {},
        trustedFrinkOwnedMcp: false,
        mcpIdentity: { server: 'frink__evil', tool: 'x' },
      }),
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { suggestedRules: ['mcp__frink__evil__*'] },
    });
  });

  it('does not let a sanitized exact name authorize a different raw MCP server', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, allow: ['mcp__foo_bar__x'] },
      user: noRules,
    }));
    const r = await checkPermission(
      baseReq({
        tool: 'mcp__foo_bar__x',
        input: {},
        trustedFrinkOwnedMcp: false,
        mcpIdentity: { server: 'foo-bar', tool: 'x' },
      }),
    );
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { suggestedRules: ['mcp__foo-bar__x', 'mcp__foo-bar__*'] },
    });
  });

  it('Glob → routes to checkSearch (in-project search stays prompt-free)', async () => {
    const r = await checkPermission(baseReq({ tool: 'Glob', input: { pattern: '**/*.ts' } }));
    expect(r).toEqual({ decision: 'allow' });
  });

  it('Grep of ~/.ssh → tier-1c deny (no unconditional auto-allow)', async () => {
    const r = await checkPermission(
      baseReq({ tool: 'Grep', input: { pattern: 'PRIVATE KEY', path: '~/.ssh' } }),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('Grep → uses the host-resolved root from the decision input over the input path', async () => {
    const input = buildPermissionDecisionInput(
      'Grep',
      { pattern: 'x', path: '/home/user/project/src' },
      nodePath.join(nodeOs.homedir(), '.aws'),
    );
    const r = await checkPermission(baseReq({ tool: 'Grep', input }));
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('Grep → a worktree override remapped into the project stays prompt-free', async () => {
    const input = buildPermissionDecisionInput(
      'Grep',
      { pattern: 'x', path: '/wt/brave-lion/src' },
      '/home/user/project/src',
    );
    expect(await checkPermission(baseReq({ tool: 'Grep', input }))).toEqual({ decision: 'allow' });
  });

  it('Grep → forwards projectId: no project row makes an in-project path ask', async () => {
    const r = await checkPermission(
      baseReq({
        tool: 'Grep',
        input: { pattern: 'x', path: '/home/user/project/src' },
        projectId: '',
      }),
    );
    expect(r).toMatchObject({ decision: 'ask', prompt: { tool: 'Grep' } });
  });

  it('Grep → an unreadable rule store denies rather than allowing', async () => {
    setDocsLoader(async () => {
      throw new Error('db down');
    });
    const r = await checkPermission(baseReq({ tool: 'Grep', input: { pattern: 'x' } }));
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'db:unavailable' } });
  });

  it('unknown tool → generic rule-eval (tool-wide allow)', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, allow: ['WebFetch'] },
      user: noRules,
    }));
    const allow = await checkPermission(
      baseReq({ tool: 'WebFetch', input: { url: 'https://example.com' } }),
    );
    expect(allow).toMatchObject({ decision: 'allow' });
  });

  it('unknown tool → generic rule-eval (deny rule fires)', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, deny: ['WebFetch'] },
      user: noRules,
    }));
    const r = await checkPermission(
      baseReq({ tool: 'WebFetch', input: { url: 'https://example.com' } }),
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'rule:deny', rule: 'WebFetch' } });
  });

  it('default loader returns empty docs (Bash → ask)', async () => {
    // resetDocsLoader done in afterEach; default is empty docs.
    const r = await checkPermission(baseReq({ tool: 'Bash', input: { command: 'npm test' } }));
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'no-matching-rule' } });
  });

  it('setDocsLoader injects custom docs', async () => {
    setDocsLoader(async () => ({
      policy: noRules,
      project: { ...noRules, deny: ['Bash(npm test:*)'] },
      user: noRules,
    }));
    const r = await checkPermission(baseReq({ tool: 'Bash', input: { command: 'npm test' } }));
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', tier: 'project', rule: 'Bash(npm test:*)' },
    });
  });
});

describe('checkPermission — no v2 consumers outside v2/ yet', () => {
  it('dispatcher is dormant — no entry point wired in (ticket 09)', () => {
    // Smoke check: the export exists and is callable. Real wiring lands in ticket 09.
    expect(typeof checkPermission).toBe('function');
  });
});

describe('checkPermission — sessionDirRoot threading (ticket 15, widened)', () => {
  let tmpRoot: string;

  function setup(): { session: string; project: string } {
    tmpRoot = nodeFs.realpathSync.native(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'check-dispatcher-')),
    );
    const sessionDir = nodePath.join(tmpRoot, 'claude-sessions', 'chat-1');
    nodeFs.mkdirSync(nodePath.join(sessionDir, 'pasted'), { recursive: true });
    const projectDir = nodePath.join(tmpRoot, 'project');
    nodeFs.mkdirSync(projectDir, { recursive: true });
    return { session: sessionDir, project: projectDir };
  }

  afterEach(() => {
    if (tmpRoot) nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Read in pasted/ → auto-allow when sessionDirRoot is threaded through', async () => {
    const { session, project } = setup();
    const file = nodePath.join(session, 'pasted', 'pasted_1.txt');
    nodeFs.writeFileSync(file, '');
    const r = await checkPermission(
      baseReq({
        tool: 'Read',
        input: { file_path: file },
        projectPath: project,
        sessionDirRoot: session,
      }),
    );
    expect(r).toEqual({ decision: 'allow' });
  });

  it('Read in pasted/ WITHOUT sessionDirRoot → falls through to scope eval (prompts)', async () => {
    const { session, project } = setup();
    const file = nodePath.join(session, 'pasted', 'pasted_1.txt');
    nodeFs.writeFileSync(file, '');
    const r = await checkPermission(
      baseReq({ tool: 'Read', input: { file_path: file }, projectPath: project }),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('Edit in pasted/ → does NOT auto-allow (Read-only bypass)', async () => {
    const { session, project } = setup();
    const file = nodePath.join(session, 'pasted', 'pasted_1.txt');
    nodeFs.writeFileSync(file, '');
    const r = await checkPermission(
      baseReq({
        tool: 'Edit',
        input: { file_path: file },
        projectPath: project,
        sessionDirRoot: session,
      }),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('Read outside the session dir → not auto-allowed even with sessionDirRoot set', async () => {
    const { session, project } = setup();
    const r = await checkPermission(
      baseReq({
        tool: 'Read',
        input: { file_path: nodePath.join(project, 'src/a.ts') },
        projectPath: project,
        sessionDirRoot: session,
      }),
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkPermission — a store with no rules and a store that cannot be read', () => {
  it('prompts for a routine tool call when the rule store is empty', async () => {
    const db = freshDb();
    try {
      setDocsLoader((req) => resolveScopes(db, req));
      const r = await checkPermission(baseReq({ tool: 'Bash', input: { command: 'npm test' } }));
      expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'no-matching-rule' } });
    } finally {
      db.$client.close();
    }
  });

  it('denies when the rule store cannot be read', async () => {
    setDocsLoader(async () => {
      throw new Error('database is locked');
    });
    const r = await checkPermission(baseReq({ tool: 'Bash', input: { command: 'npm test' } }));
    expect(r).toEqual({ decision: 'deny', reason: { kind: 'db:unavailable' } });
  });

  it('allows a command with no sub-commands to run — nothing to evaluate', async () => {
    // Characterises the one command shape checkBash lets through on its own, so a
    // change to that shape is visible rather than silent.
    const r = await checkPermission(baseReq({ tool: 'Bash', input: { command: '   ' } }));
    expect(r).toEqual({ decision: 'allow' });
  });

  it('denies a path tool too when the rule store cannot be read', async () => {
    setDocsLoader(async () => {
      throw new Error('database is locked');
    });
    const r = await checkPermission(
      baseReq({ tool: 'Edit', input: { file_path: '/home/user/project/src/a.ts' } }),
    );
    expect(r).toEqual({ decision: 'deny', reason: { kind: 'db:unavailable' } });
  });
});
