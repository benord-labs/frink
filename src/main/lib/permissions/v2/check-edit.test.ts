import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEdit, type PathToolName } from './check-edit';
import { EMPTY_DOCS } from './eval-rules';
import type { PermissionsDoc } from './types';

const root = '/project';
const noRules: PermissionsDoc = { allow: [], deny: [], ask: [] };

describe('checkEdit — tier-1c (bypass-immune)', () => {
  it('Edit(.git/config) deny via system-denied even with Edit(**) allow', () => {
    const docs = { policy: noRules, project: { ...noRules, allow: ['Edit(**)'] }, user: noRules };
    const r = checkEdit({ file_path: '/project/.git/config' }, docs, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('Edit(.env) deny via system-denied', () => {
    const r = checkEdit({ file_path: '/project/.env' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('Edit(~/.ssh/id_rsa) deny via tilde-expanded system-denied', () => {
    const r = checkEdit({ file_path: '~/.ssh/id_rsa' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path', path: nodePath.join(nodeOs.homedir(), '.ssh', 'id_rsa') },
    });
  });
});

describe('checkEdit — rule eval', () => {
  it('Edit(src/**) matches absolute path under project', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Edit(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/project/src/a.ts' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('Edit(src/**) matches relative path', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Edit(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: 'src/a.ts' }, docs, root);
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('Edit(src/**) does NOT match path outside src/', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Edit(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/project/lib/x.ts' }, docs, root);
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkEdit — input field chain (file_path → file → path)', () => {
  it('falls back to `file` when `file_path` missing', () => {
    const r = checkEdit({ file: '/project/.env' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('falls back to `path` when `file_path` and `file` missing', () => {
    const r = checkEdit({ path: '/project/.env' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'deny' });
  });

  it('no path → ask (no-matching-rule)', () => {
    const r = checkEdit({}, EMPTY_DOCS, root);
    expect(r).toMatchObject({ decision: 'ask', prompt: { reason: 'no-matching-rule' } });
  });
});

describe('checkEdit — DenyReason transparency', () => {
  it('safety:path includes resolved path', () => {
    const r = checkEdit({ file_path: '/project/.git/config' }, EMPTY_DOCS, root);
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path', path: '/project/.git/config' },
    });
  });

  it('rule:deny includes rule + tier', () => {
    const docs = {
      policy: noRules,
      project: noRules,
      user: { ...noRules, deny: ['Edit(secrets/**)'] },
    };
    const r = checkEdit({ file_path: '/project/secrets/key.txt' }, docs, root);
    expect(r).toMatchObject({
      decision: 'deny',
      reason: { kind: 'rule:deny', rule: 'Edit(secrets/**)', tier: 'user' },
    });
  });
});

describe('checkEdit — toolName param routes through correct tool', () => {
  it('Read(src/**) matches when toolName is Read', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/project/src/a.ts' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('Read(src/**) does NOT match when toolName is Edit', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/project/src/a.ts' }, docs, root, 'Edit');
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkEdit — file-op prompt classification (ticket 15)', () => {
  it('in-project ask: attaches pathLocation="in-current-project" + suggestedRules=[toolName]', () => {
    const r = checkEdit({ file_path: '/project/src/a.ts' }, EMPTY_DOCS, root, 'Read');
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        pathLocation: 'in-current-project',
        suggestedRules: ['Read'],
      },
    });
  });

  it('outside-project ask: pathLocation="outside" + suggestedRules=[]', () => {
    const r = checkEdit({ file_path: '/elsewhere/x.ts' }, EMPTY_DOCS, root, 'Edit');
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        pathLocation: 'outside',
        suggestedRules: [],
      },
    });
  });

  it('no projectRoot context: pathLocation="outside" + suggestedRules=[]', () => {
    const r = checkEdit({ file_path: '/project/src/a.ts' }, EMPTY_DOCS, '', 'Write');
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: {
        pathLocation: 'outside',
        suggestedRules: [],
      },
    });
  });

  it('uses the toolName param verbatim in suggestedRules (covers Delete / MultiEdit / NotebookEdit)', () => {
    for (const tool of ['Delete', 'MultiEdit', 'NotebookEdit'] as const) {
      const r = checkEdit({ file_path: '/project/src/a.ts' }, EMPTY_DOCS, root, tool);
      expect(r).toMatchObject({
        decision: 'ask',
        prompt: { pathLocation: 'in-current-project', suggestedRules: [tool] },
      });
    }
  });

  it('allow decision does NOT attach pathLocation (only ask prompts)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Edit(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/project/src/a.ts' }, docs, root, 'Edit');
    expect(r).toMatchObject({ decision: 'allow' });
    expect(r).not.toHaveProperty('prompt');
  });

  it('deny decision does NOT attach pathLocation (only ask prompts)', () => {
    const r = checkEdit({ file_path: '/project/.env' }, EMPTY_DOCS, root, 'Read');
    expect(r).toMatchObject({ decision: 'deny' });
    expect(r).not.toHaveProperty('prompt');
  });
});

describe('checkEdit — project-scope tool-wide path-containment guardrail (ticket 15 bugfix)', () => {
  // The user's mental model when clicking "Allow Read for {project}" is "I'm
  // allowing reads INSIDE this project", not "any read anywhere while chatting
  // here". The matcher treats `Read` (tool-wide) as "matches any input", which
  // would allow `/etc/hosts` Reads from a frink chat — wrong. The dispatcher
  // adds a path-containment safety net.

  it('project-scope tool-wide `Read` + outside path → DOWNGRADE to ask', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/elsewhere/secret.txt' }, docs, root, 'Read');
    expect(r).toMatchObject({
      decision: 'ask',
      prompt: { pathLocation: 'outside', suggestedRules: [] },
    });
  });

  it('project-scope tool-wide `Read` + in-project path → allow (no downgrade)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/project/src/a.ts' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('project-scope tool-wide `Read(*)` shortcut + outside path → DOWNGRADE to ask', () => {
    // `Read(*)` is the explicit form of `Read` — matches anything for the tool.
    // Same guardrail must apply.
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read(*)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/elsewhere/secret.txt' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('project-scope path-specific `Read(src/**)` + outside path → does NOT match → ask (matcher rejected, not downgrade)', () => {
    // Path-specific glob fails the picomatch test for outside paths anyway —
    // the safety net isn't even reached. Sanity check that we don't regress.
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read(src/**)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/elsewhere/secret.txt' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('project-scope path-specific `Read(/etc/hosts)` + matching outside path → allow (power-user override preserved)', () => {
    // The user hand-crafted an absolute path at project scope via Settings →
    // AddRuleInput. Trust their explicit intent; do NOT downgrade.
    const docs = {
      policy: noRules,
      project: { ...noRules, allow: ['Read(/etc/hosts)'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/etc/hosts' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('USER-scope tool-wide `Read` + outside path → allow (machine-wide rule, no downgrade)', () => {
    // User-scope rules are machine-wide by design — added explicitly via
    // Settings, not from the prompt flow. Don't second-guess the user.
    const docs = {
      policy: noRules,
      project: noRules,
      user: { ...noRules, allow: ['Read'] },
    };
    const r = checkEdit({ file_path: '/elsewhere/x.txt' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('POLICY-scope tool-wide `Read` + outside path → allow (managed, no downgrade)', () => {
    const docs = {
      policy: { ...noRules, allow: ['Read'] },
      project: noRules,
      user: noRules,
    };
    const r = checkEdit({ file_path: '/elsewhere/x.txt' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'allow' });
  });

  it('project-scope tool-wide guardrail covers all 6 path tools', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Delete', 'MultiEdit', 'NotebookEdit'] as const) {
      const docs = {
        policy: noRules,
        project: { ...noRules, allow: [tool] },
        user: noRules,
      };
      const r = checkEdit({ file_path: '/elsewhere/x.ts' }, docs, root, tool);
      expect(r).toMatchObject({ decision: 'ask' });
    }
  });

  it('project-scope deny rule beats the downgrade (deny still wins)', () => {
    const docs = {
      policy: noRules,
      project: { ...noRules, deny: ['Read'] },
      user: noRules,
    };
    const r = checkEdit({ file_path: '/elsewhere/x.txt' }, docs, root, 'Read');
    expect(r).toMatchObject({ decision: 'deny' });
  });
});

describe('checkEdit — session-dir auto-allow (pasted/ + tool-results spill files)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = nodeFs.realpathSync.native(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'check-edit-session-')),
    );
  });

  afterEach(() => {
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Session-shaped dir mirroring the CLI's CLAUDE_CONFIG_DIR layout. */
  function mkSessionDir(id = 'chat-aaaa'): string {
    const dir = nodePath.join(tmpRoot, 'claude-sessions', id);
    nodeFs.mkdirSync(nodePath.join(dir, 'pasted'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(dir, 'projects', '-slug-', 'uuid', 'tool-results'), {
      recursive: true,
    });
    nodeFs.mkdirSync(nodePath.join(dir, 'shell-snapshots'), { recursive: true });
    return dir;
  }

  it('Read on a pasted blob auto-allows (paste-dir regression)', () => {
    const dir = mkSessionDir();
    const file = nodePath.join(dir, 'pasted', 'pasted_123.txt');
    nodeFs.writeFileSync(file, 'data');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toEqual({ decision: 'allow' });
  });

  it('Read of a CLI tool-result spill file auto-allows', () => {
    const dir = mkSessionDir();
    const file = nodePath.join(
      dir,
      'projects',
      '-slug-',
      'uuid',
      'tool-results',
      'mcp-firecrawl-scrape-123.txt',
    );
    nodeFs.writeFileSync(file, 'scraped');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toEqual({ decision: 'allow' });
  });

  it('Edit on a pasted blob does NOT auto-allow (Read-only bypass)', () => {
    const dir = mkSessionDir();
    const file = nodePath.join(dir, 'pasted', 'pasted_123.txt');
    nodeFs.writeFileSync(file, 'data');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Edit', dir);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('session files outside the allow-list still prompt (transcripts, shell snapshots, account file)', () => {
    const dir = mkSessionDir();
    const sensitive = [
      nodePath.join('projects', '-slug-', 'uuid.jsonl'),
      nodePath.join('shell-snapshots', 'snap.sh'),
      '.claude.json',
    ];
    for (const rel of sensitive) {
      const file = nodePath.join(dir, rel);
      nodeFs.writeFileSync(file, 'x');
      const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir);
      expect(r).toMatchObject({ decision: 'ask' });
    }
  });

  it('Read outside the session dir still prompts', () => {
    const dir = mkSessionDir();
    const r = checkEdit({ file_path: '/project/src/a.ts' }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('Read with no sessionDirRoot param still prompts (auto-allow inactive)', () => {
    const r = checkEdit({ file_path: '/project/src/a.ts' }, EMPTY_DOCS, root, 'Read');
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('sibling session dirs stay isolated (incl. prefix-collision ids)', () => {
    const dir = mkSessionDir('chat-aaaa');
    const sibling = mkSessionDir('chat-aaaa-bbbb');
    const file = nodePath.join(sibling, 'pasted', 'x.txt');
    nodeFs.writeFileSync(file, 'x');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('lexical tool-results segment cannot escape via ../ traversal', () => {
    const dir = mkSessionDir();
    const outside = nodePath.join(tmpRoot, 'outside.txt');
    nodeFs.writeFileSync(outside, 'x');
    // Path string contains a literal `tool-results` segment but resolves
    // outside the session dir — both containment and the segment check must
    // operate on the RESOLVED path.
    const sneaky = nodePath.join(
      dir,
      'projects',
      '-slug-',
      'uuid',
      'tool-results',
      ...Array(6).fill('..'),
      'outside.txt',
    );
    expect(nodePath.resolve(sneaky)).toBe(outside); // fixture sanity
    const r = checkEdit({ file_path: sneaky }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('sibling subtrees sharing an allow-list prefix still prompt (pasted-evil, projects-evil)', () => {
    const dir = mkSessionDir();
    nodeFs.mkdirSync(nodePath.join(dir, 'pasted-evil'), { recursive: true });
    nodeFs.mkdirSync(nodePath.join(dir, 'projects-evil', 'tool-results'), { recursive: true });
    const lookalikes = [
      nodePath.join('pasted-evil', 'x.txt'),
      nodePath.join('projects-evil', 'tool-results', 'x.txt'),
    ];
    for (const rel of lookalikes) {
      const file = nodePath.join(dir, rel);
      nodeFs.writeFileSync(file, 'x');
      const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir);
      expect(r).toMatchObject({ decision: 'ask' });
    }
  });

  it('deeper-nested tool-results (subagent spill files) still auto-allows', () => {
    const dir = mkSessionDir();
    const deep = nodePath.join(dir, 'projects', '-slug-', 'uuid', 'subagent-1', 'tool-results');
    nodeFs.mkdirSync(deep, { recursive: true });
    const file = nodePath.join(deep, 'result.txt');
    nodeFs.writeFileSync(file, 'x');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toEqual({ decision: 'allow' });
  });

  it('missing session dir (cleaned up mid-session / non-Claude provider) prompts without throwing', () => {
    const ghost = nodePath.join(tmpRoot, 'claude-sessions', 'chat-ghost-9999');
    const file = nodePath.join(ghost, 'pasted', 'x.txt');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', ghost);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('symlink escaping the session dir does NOT auto-allow (realpath containment)', () => {
    // A tool-results path whose realpath resolves outside the session dir must
    // fall through to the prompt — pins isAutoAllowedPath's parent-realpath check.
    const dir = mkSessionDir();
    const outside = nodePath.join(tmpRoot, 'outside');
    nodeFs.mkdirSync(outside, { recursive: true });
    nodeFs.writeFileSync(nodePath.join(outside, 'secret.txt'), 'x');
    const linkParent = nodePath.join(dir, 'projects', '-slug2-', 'uuid');
    nodeFs.mkdirSync(linkParent, { recursive: true });
    nodeFs.symlinkSync(outside, nodePath.join(linkParent, 'tool-results'));
    const file = nodePath.join(linkParent, 'tool-results', 'secret.txt');
    // skillsDirRoots: [] keeps the test hermetic (never reads real skill roots).
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Read', dir, undefined, []);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('system-denied path beats auto-allow even inside the session dir', () => {
    // .env inside pasted/ would normally bypass — system-deny must win.
    const dir = mkSessionDir();
    const envFile = nodePath.join(dir, 'pasted', '.env');
    nodeFs.writeFileSync(envFile, 'SECRET=1');
    const r = checkEdit({ file_path: envFile }, EMPTY_DOCS, root, 'Read', dir);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });
});

describe('checkEdit — plan-dir auto-allow (Claude plan mode)', () => {
  let tmpRoot: string;
  let planDir: string;

  function mkPlanDir(): string {
    tmpRoot = nodeFs.realpathSync.native(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'check-edit-plan-')),
    );
    planDir = nodePath.join(tmpRoot, 'plans');
    nodeFs.mkdirSync(planDir, { recursive: true });
    return planDir;
  }

  afterEach(() => {
    if (tmpRoot) nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Write/Edit/Read/MultiEdit on a plan file auto-allow (no prompt)', () => {
    const dir = mkPlanDir();
    const file = nodePath.join(dir, 'feature.md');
    nodeFs.writeFileSync(file, '# plan');
    for (const tool of ['Write', 'Edit', 'Read', 'MultiEdit'] as const) {
      const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, tool, undefined, dir);
      expect(r).toEqual({ decision: 'allow' });
    }
  });

  it('Delete on a plan file does NOT auto-allow (excluded tool)', () => {
    const dir = mkPlanDir();
    const file = nodePath.join(dir, 'feature.md');
    nodeFs.writeFileSync(file, '# plan');
    const r = checkEdit({ file_path: file }, EMPTY_DOCS, root, 'Delete', undefined, dir);
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('Write outside planDirRoot still prompts', () => {
    const dir = mkPlanDir();
    const r = checkEdit(
      { file_path: '/elsewhere/x.md' },
      EMPTY_DOCS,
      root,
      'Write',
      undefined,
      dir,
    );
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('Write with no planDirRoot param still prompts (auto-allow inactive)', () => {
    const r = checkEdit({ file_path: '/elsewhere/x.md' }, EMPTY_DOCS, root, 'Write');
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('system-denied path beats plan auto-allow even inside planDirRoot', () => {
    const dir = mkPlanDir();
    const envFile = nodePath.join(dir, '.env');
    nodeFs.writeFileSync(envFile, 'SECRET=1');
    const r = checkEdit({ file_path: envFile }, EMPTY_DOCS, root, 'Write', undefined, dir);
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });

  it('relative file_path resolves under project (not plan root) → prompts', () => {
    // Auto-allow uses the absolute path; a relative input anchors to projectRoot,
    // never the plans dir. Documents that the SDK must pass absolute plan paths.
    const dir = mkPlanDir();
    const r = checkEdit({ file_path: 'feature.md' }, EMPTY_DOCS, root, 'Write', undefined, dir);
    expect(r).toMatchObject({ decision: 'ask' });
  });
});

describe('checkEdit — skills-dir auto-allow (~/.frink/skills, first-party trust)', () => {
  let tmpRoot: string;
  let skillsDir: string;

  // checkEdit positional args: (input, docs, projectRoot, toolName, sessionDirRoot,
  // planDirRoot, skillsDirRoots). Override the real getSkillReadRoots() default
  // with temp dirs so the suite never touches the user's home.
  function call(input: { file_path: string }, tool: PathToolName, roots: string[] = [skillsDir]) {
    return checkEdit(input, EMPTY_DOCS, root, tool, undefined, undefined, roots);
  }

  beforeEach(() => {
    tmpRoot = nodeFs.realpathSync.native(
      nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'check-edit-skills-')),
    );
    skillsDir = nodePath.join(tmpRoot, 'skills');
    nodeFs.mkdirSync(nodePath.join(skillsDir, 'frink-flows', 'references'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(skillsDir, 'frink-flows', 'SKILL.md'), '# skill');
    nodeFs.writeFileSync(
      nodePath.join(skillsDir, 'frink-flows', 'references', 'blocks.md'),
      '# ref',
    );
    // The baseline marker is the trust signal — only frink-shipped skills carry it.
    nodeFs.writeFileSync(
      nodePath.join(skillsDir, 'frink-flows', '.baseline.json'),
      '{"version":"1.0.0","files":{}}',
    );
  });

  afterEach(() => {
    if (tmpRoot) nodeFs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // EC1
  it('Read on a file inside the skills dir auto-allows (no prompt)', () => {
    const file = nodePath.join(skillsDir, 'frink-flows', 'references', 'blocks.md');
    expect(call({ file_path: file }, 'Read')).toEqual({ decision: 'allow' });
  });

  // EC2 — Read-only bypass; every mutating op still prompts.
  it('Edit/Write/MultiEdit/Delete/NotebookEdit inside the skills dir still prompt', () => {
    const file = nodePath.join(skillsDir, 'frink-flows', 'SKILL.md');
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'Delete', 'NotebookEdit'] as const) {
      expect(call({ file_path: file }, tool)).toMatchObject({ decision: 'ask' });
    }
  });

  // The bare skills-root dir is not itself a frink skill (no baseline marker under it),
  // so a Read of the root dir prompts — only a marked skill dir beneath it auto-allows.
  it('Read of the bare skills-root dir prompts (no skill targeted)', () => {
    expect(call({ file_path: skillsDir }, 'Read')).toMatchObject({ decision: 'ask' });
  });

  // EC3 — tier-1c system-denied beats the bypass.
  it('Read of a system-denied file inside the skills dir is still denied', () => {
    const envFile = nodePath.join(skillsDir, 'frink-flows', '.env');
    nodeFs.writeFileSync(envFile, 'SECRET=1');
    expect(call({ file_path: envFile }, 'Read')).toMatchObject({
      decision: 'deny',
      reason: { kind: 'safety:path' },
    });
  });

  // EC4 — agent reaches skills via the {session}/skills -> ... -> ~/.frink/skills
  // symlink chain; the input must realpath INTO the skills root and still allow.
  it('Read via a symlink that resolves into the skills dir auto-allows', () => {
    const linkDir = nodePath.join(tmpRoot, 'session-skills');
    nodeFs.symlinkSync(skillsDir, linkDir, 'dir');
    const viaLink = nodePath.join(linkDir, 'frink-flows', 'SKILL.md');
    expect(call({ file_path: viaLink }, 'Read')).toEqual({ decision: 'allow' });
  });

  // EC4b — an in-dir symlink escaping OUT of the skills root must NOT auto-allow.
  it('Read of an in-skills symlink pointing outside the root still prompts', () => {
    const secret = nodePath.join(tmpRoot, 'outside-secret.txt');
    nodeFs.writeFileSync(secret, 'nope');
    const escapeLink = nodePath.join(skillsDir, 'frink-flows', 'escape.txt');
    nodeFs.symlinkSync(secret, escapeLink, 'file');
    expect(call({ file_path: escapeLink }, 'Read')).toMatchObject({ decision: 'ask' });
  });

  // EC5 — scope is exactly `skills`, not all of ~/.frink. builds/ etc. keep prompting.
  it('Read of ~/.frink/builds (sibling of skills) still prompts', () => {
    const buildsFile = nodePath.join(tmpRoot, 'builds', 'proj', 'index.html');
    nodeFs.mkdirSync(nodePath.dirname(buildsFile), { recursive: true });
    nodeFs.writeFileSync(buildsFile, '<html>');
    expect(call({ file_path: buildsFile }, 'Read')).toMatchObject({ decision: 'ask' });
  });

  // EC6 — sibling-prefix boundary: `skills-evil` is not inside `skills`.
  it('Read of a sibling dir whose name prefixes skills still prompts', () => {
    const evilFile = nodePath.join(tmpRoot, 'skills-evil', 'secret.txt');
    nodeFs.mkdirSync(nodePath.dirname(evilFile), { recursive: true });
    nodeFs.writeFileSync(evilFile, 'secret');
    expect(call({ file_path: evilFile }, 'Read')).toMatchObject({ decision: 'ask' });
  });

  // EC8 — fail-closed: an empty skills-roots list disables the bypass (never fail-open).
  it('Read with no skills roots falls through to the normal prompt', () => {
    const file = nodePath.join(skillsDir, 'frink-flows', 'SKILL.md');
    expect(call({ file_path: file }, 'Read', [])).toMatchObject({ decision: 'ask' });
  });

  // Post symlink→copy migration: a frink-shipped skill projected as a REAL COPY
  // (carries .baseline.json) into a per-tool dir auto-allows there — trust follows the
  // baseline marker, not the path, and the copy realpaths to itself (no symlink).
  it('Read of a frink-shipped real-copy skill in a per-tool dir auto-allows', () => {
    const claudeSkills = nodePath.join(tmpRoot, 'claude-skills');
    nodeFs.mkdirSync(nodePath.join(claudeSkills, 'frink-flows'), { recursive: true });
    const file = nodePath.join(claudeSkills, 'frink-flows', 'SKILL.md');
    nodeFs.writeFileSync(file, '# real copy');
    nodeFs.writeFileSync(nodePath.join(claudeSkills, 'frink-flows', '.baseline.json'), '{}');
    expect(nodeFs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(call({ file_path: file }, 'Read', [skillsDir, claudeSkills])).toEqual({
      decision: 'allow',
    });
  });

  // Honors frink-skills-read-permission-trust: a user's OWN skill carries no baseline
  // marker — hand-authored, or a frink projection of the user's skill that has only
  // .frink-projected — so even sitting in a skill read-root it keeps prompting.
  it('Read of a non-frink (no-baseline) skill in a read-root still prompts', () => {
    const claudeSkills = nodePath.join(tmpRoot, 'claude-skills');
    nodeFs.mkdirSync(nodePath.join(claudeSkills, 'my-skill'), { recursive: true });
    const file = nodePath.join(claudeSkills, 'my-skill', 'SKILL.md');
    nodeFs.writeFileSync(file, '# user authored');
    nodeFs.writeFileSync(
      nodePath.join(claudeSkills, 'my-skill', '.frink-projected'),
      '{"hash":"x"}',
    );
    expect(call({ file_path: file }, 'Read', [skillsDir, claudeSkills])).toMatchObject({
      decision: 'ask',
    });
  });

  // Provider topology: Claude Code reaches skills through a TWO-hop chain at
  // distinct path components — {session}/skills (dir symlink) -> ~/.claude/skills,
  // then ~/.claude/skills/<name> (per-skill symlink) -> ~/.frink/skills/<name>.
  // EC4 only covered a single whole-path symlink; this proves realpath resolves
  // the multi-component chain so both Cursor (direct per-skill symlink) and
  // Claude Code (nested) auto-allow identically.
  it('Read via the two-hop {session}->{claude}->{frink} symlink chain auto-allows', () => {
    const claudeSkills = nodePath.join(tmpRoot, 'claude-skills');
    nodeFs.mkdirSync(claudeSkills, { recursive: true });
    nodeFs.symlinkSync(
      nodePath.join(skillsDir, 'frink-flows'),
      nodePath.join(claudeSkills, 'frink-flows'),
      'dir',
    );
    const sessionSkills = nodePath.join(tmpRoot, 'session', 'skills');
    nodeFs.mkdirSync(nodePath.dirname(sessionSkills), { recursive: true });
    nodeFs.symlinkSync(claudeSkills, sessionSkills, 'dir');

    const viaChain = nodePath.join(sessionSkills, 'frink-flows', 'SKILL.md');
    expect(call({ file_path: viaChain }, 'Read')).toEqual({ decision: 'allow' });
  });

  // A relative file_path anchors to the project cwd, never the skills root — so a
  // skill-shaped relative path (e.g. `frink-flows/SKILL.md`) must NOT false-match.
  // Guards the `absolute` (not raw `filePath`) argument passed to the bypass.
  it('relative file_path that mirrors a skill subpath still prompts', () => {
    expect(call({ file_path: 'frink-flows/SKILL.md' }, 'Read')).toMatchObject({
      decision: 'ask',
    });
  });

  // `..` traversal that escapes the skills root must not be auto-allowed — the
  // bypass resolves `..` before containment, so a redirect into a sibling fails.
  it('Read of a `..` path escaping skills into a sibling still prompts', () => {
    const buildsFile = nodePath.join(tmpRoot, 'builds', 'leak.txt');
    nodeFs.mkdirSync(nodePath.dirname(buildsFile), { recursive: true });
    nodeFs.writeFileSync(buildsFile, 'leak');
    const traversal = nodePath.join(skillsDir, 'frink-flows', '..', '..', 'builds', 'leak.txt');
    expect(call({ file_path: traversal }, 'Read')).toMatchObject({ decision: 'ask' });
  });
});

describe('checkEdit — no-project chat (projectRoot = home directory)', () => {
  // General chats route file ops through this ordinary pipeline with the home
  // dir as root and no rules. A Write must land on ask (the permission card),
  // with the system-denied floor still terminal.
  it('Write under $HOME with empty docs → ask', () => {
    const home = nodeOs.homedir();
    const r = checkEdit({ file_path: nodePath.join(home, 'notes.md') }, EMPTY_DOCS, home, 'Write');
    expect(r).toMatchObject({ decision: 'ask' });
  });

  it('Write to ~/.ssh under $HOME root still hard-denies', () => {
    const home = nodeOs.homedir();
    const r = checkEdit(
      { file_path: nodePath.join(home, '.ssh', 'config') },
      EMPTY_DOCS,
      home,
      'Write',
    );
    expect(r).toMatchObject({ decision: 'deny', reason: { kind: 'safety:path' } });
  });
});
