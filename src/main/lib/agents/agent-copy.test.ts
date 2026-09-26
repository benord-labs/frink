import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crossFlavorAgentMd, type SourceAgent } from '../provider/handlers/agent-brain';
import {
  agentFlavorOfDir,
  agentRealRoots,
  agentSourceRootsFor,
  copyUserAgent,
  resolveAgentSource,
} from './agent-copy';

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

describe('crossFlavorAgentMd (shared transform — the stamp seam keeps the projector byte-identical)', () => {
  const agent: SourceAgent = {
    name: 'reviewer',
    filename: 'reviewer.md',
    data: { name: 'reviewer', model: 'opus', tools: 'Read', color: 'blue' },
    body: 'Review code.',
    from: { dir: '/x/.claude/agents', flavor: 'claude' },
  };
  const sameFlavour = { dir: '/y/.frink/agents', flavor: 'claude' as const };
  const crossFlavour = { dir: '/y/.cursor/agents', flavor: 'cursor' as const };

  it('stamp=true marks the auto-mirror; stamp=false leaves a plain user-owned copy', () => {
    expect(crossFlavorAgentMd(agent, sameFlavour, true)).toContain('frinkProjected: true');
    expect(crossFlavorAgentMd(agent, sameFlavour, false)).not.toContain('frinkProjected');
  });

  it('same-flavour is verbatim; cross-flavour drops typed fields + degrades to readonly', () => {
    const same = crossFlavorAgentMd(agent, sameFlavour, false);
    expect(same).toContain('model: opus');
    expect(same).toContain('tools: Read');

    const cross = crossFlavorAgentMd(agent, crossFlavour, false);
    expect(cross).not.toContain('model:');
    expect(cross).not.toContain('tools:');
    expect(cross).toContain('readonly: true'); // tools: Read = read-only → coarse Cursor switch
    expect(cross).toContain('color: blue'); // unknown keys survive
  });

  it('strips a Cursor-only readonly field when copying a Cursor agent TO Claude (symmetric)', () => {
    const cursorAgent: SourceAgent = {
      name: 'r',
      filename: 'r.md',
      data: { name: 'r', readonly: true, color: 'red' },
      body: 'x',
      from: { dir: '/x/.cursor/agents', flavor: 'cursor' },
    };
    const toClaude = crossFlavorAgentMd(
      cursorAgent,
      { dir: '/y/.claude/agents', flavor: 'claude' },
      false,
    );
    expect(toClaude).not.toContain('readonly'); // cursor-only field must not leak into a Claude copy
    expect(toClaude).toContain('color: red');
  });
});

const CLAUDE_AGENT =
  '---\nname: reviewer\nmodel: opus\ntools: Read\ncolor: blue\n---\nReview code.\n';

describe('agentFlavorOfDir', () => {
  it('classifies by path SEGMENT — .codex is codex, .cursor is cursor, everything else claude', () => {
    expect(agentFlavorOfDir(path.join('/h', '.codex', 'agents', 'x.md'))).toBe('codex');
    expect(agentFlavorOfDir(path.join('/h', '.cursor', 'agents', 'x.md'))).toBe('cursor');
    expect(agentFlavorOfDir(path.join('/h', '.claude', 'agents', 'x.md'))).toBe('claude');
    expect(agentFlavorOfDir(path.join('/h', '.frink', 'agents', 'x.md'))).toBe('claude');
  });

  it('does not misclassify a .cursor-backups / .codex-backups look-alike', () => {
    expect(agentFlavorOfDir(path.join('/h', '.cursor-backups', '.claude', 'agents', 'x.md'))).toBe(
      'claude',
    );
    expect(agentFlavorOfDir(path.join('/h', '.codex-backups', '.claude', 'agents', 'x.md'))).toBe(
      'claude',
    );
  });
});

describe('copyUserAgent', () => {
  let base: string;
  let claudeSrc: string; // <base>/.claude/agents/reviewer.md (a claude-flavour source)
  const dir = (tool: string) => path.join(base, tool, 'agents');
  const claude = () => ({ dir: dir('.claude'), flavor: 'claude' as const });
  const cursor = () => ({ dir: dir('.cursor'), flavor: 'cursor' as const });
  const frink = () => ({ dir: dir('.frink'), flavor: 'claude' as const });

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-copy-'));
    claudeSrc = path.join(dir('.claude'), 'reviewer.md');
    await fs.mkdir(dir('.claude'), { recursive: true });
    await fs.writeFile(claudeSrc, CLAUDE_AGENT);
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('writes a PLAIN copy (no frinkProjected stamp) so the auto-mirror never overwrites it', async () => {
    const { wrote, kept } = await copyUserAgent(claudeSrc, [cursor()]);
    expect(wrote).toBe(1);
    expect(kept).toBe(0);
    const { data } = matter(await fs.readFile(path.join(dir('.cursor'), 'reviewer.md'), 'utf-8'));
    expect(data.frinkProjected).toBeUndefined();
  });

  it('cross-family omits Claude-only typed fields and degrades to readonly on Cursor', async () => {
    await copyUserAgent(claudeSrc, [cursor()]);
    const { data } = matter(await fs.readFile(path.join(dir('.cursor'), 'reviewer.md'), 'utf-8'));
    expect(data.model).toBeUndefined();
    expect(data.tools).toBeUndefined();
    expect(data.readonly).toBe(true); // tools: Read = read-only → coarse Cursor switch
    expect(data.color).toBe('blue'); // unknown keys preserved verbatim
  });

  it('keeps every field verbatim for a same-family target', async () => {
    await copyUserAgent(claudeSrc, [frink()]);
    const { data } = matter(await fs.readFile(path.join(dir('.frink'), 'reviewer.md'), 'utf-8'));
    expect(data.model).toBe('opus');
    expect(data.tools).toBe('Read');
    expect(data.color).toBe('blue');
    expect(data.frinkProjected).toBeUndefined();
  });

  it('treats a .codex SOURCE as its own family — strips Claude-typed fields copying to .frink/.claude', async () => {
    // The wiring this guards: copyUserAgent derives the source flavor via agentFlavorOfDir, which now
    // returns 'codex' for a `.codex` path. codex ≠ the claude-family target → the cross-family strip
    // fires. If the source were mis-typed 'claude' (the bug), .codex→.frink reads as same-family and the
    // typed fields leak through unstripped. Codex understands neither Claude model ids nor tool names.
    const codexSrc = path.join(dir('.codex'), 'reviewer.md');
    await fs.mkdir(dir('.codex'), { recursive: true });
    await fs.writeFile(codexSrc, CLAUDE_AGENT); // name + model + tools + color
    const { wrote } = await copyUserAgent(codexSrc, [frink()]);
    expect(wrote).toBe(1);
    const { data } = matter(await fs.readFile(path.join(dir('.frink'), 'reviewer.md'), 'utf-8'));
    expect(data.model).toBeUndefined();
    expect(data.tools).toBeUndefined();
    expect(data.name).toBe('reviewer'); // portable fields survive
    expect(data.color).toBe('blue'); // unknown keys preserved verbatim
  });

  it('NEVER clobbers a frinkProjected mirror — reports it as kept', async () => {
    const mirror = path.join(dir('.cursor'), 'reviewer.md');
    await fs.mkdir(dir('.cursor'), { recursive: true });
    await fs.writeFile(mirror, '---\nname: reviewer\nfrinkProjected: true\n---\nOLD MIRROR\n');
    const { wrote, kept } = await copyUserAgent(claudeSrc, [cursor()]);
    expect(wrote).toBe(0);
    expect(kept).toBe(1);
    expect(await fs.readFile(mirror, 'utf-8')).toContain('OLD MIRROR');
  });

  it('NEVER clobbers a hand-edited copy — reports it as kept', async () => {
    const edited = path.join(dir('.cursor'), 'reviewer.md');
    await fs.mkdir(dir('.cursor'), { recursive: true });
    await fs.writeFile(edited, '---\nname: reviewer\n---\nMY HAND EDIT\n');
    const { wrote, kept } = await copyUserAgent(claudeSrc, [cursor()]);
    expect(wrote).toBe(0);
    expect(kept).toBe(1);
    expect(await fs.readFile(edited, 'utf-8')).toContain('MY HAND EDIT');
  });

  it('skips the target that IS the source', async () => {
    const { wrote, kept } = await copyUserAgent(claudeSrc, [claude()]);
    expect(wrote).toBe(0);
    expect(kept).toBe(0);
  });

  it('binds the destination filename to the SOURCE file, not the frontmatter name', async () => {
    const namedSrc = path.join(dir('.claude'), 'my-agent.md');
    await fs.writeFile(namedSrc, '---\nname: Security Auditor\n---\nAudit.\n');
    await copyUserAgent(namedSrc, [cursor()]);
    expect(existsSync(path.join(dir('.cursor'), 'my-agent.md'))).toBe(true);
    expect(existsSync(path.join(dir('.cursor'), 'Security Auditor.md'))).toBe(false);
  });

  it('detects a divergent NESTED-object hand-edit (not collapsed to {}) and keeps it', async () => {
    // Same-flavour target so there's no cross-family omit; the only difference is inside a nested map.
    const src = path.join(dir('.claude'), 'perm.md');
    await fs.writeFile(src, '---\nname: perm\npermissions:\n  allow: [Read]\n---\nbody\n');
    const target = path.join(dir('.frink'), 'perm.md');
    await fs.mkdir(dir('.frink'), { recursive: true });
    await fs.writeFile(target, '---\nname: perm\npermissions:\n  allow: [Bash]\n---\nbody\n');
    const { wrote, kept } = await copyUserAgent(src, [frink()]);
    expect(wrote).toBe(0);
    expect(kept).toBe(1); // the Bash-vs-Read nested divergence must be seen, not collapsed
    expect(await fs.readFile(target, 'utf-8')).toContain('Bash');
  });

  it('preserves a target hand-edited into MALFORMED yaml instead of failing the whole copy', async () => {
    const bad = path.join(dir('.cursor'), 'reviewer.md');
    await fs.mkdir(dir('.cursor'), { recursive: true });
    await fs.writeFile(bad, '---\nname: [unclosed\n---\nbody\n');
    const { wrote, kept } = await copyUserAgent(claudeSrc, [cursor()]);
    expect(wrote).toBe(0);
    expect(kept).toBe(1);
    expect(await fs.readFile(bad, 'utf-8')).toContain('[unclosed');
  });

  it('publishes atomically — no .tmp leftover after a successful copy', async () => {
    await copyUserAgent(claudeSrc, [cursor()]);
    const entries = await fs.readdir(dir('.cursor'));
    expect(entries.some((e) => e.includes('.tmp-'))).toBe(false);
  });
});

describe('resolveAgentSource (containment + symlink hardening)', () => {
  let base: string;
  let roots: string[];
  let realRoots: string[];

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-src-'));
    roots = agentSourceRootsFor(base);
    await fs.mkdir(path.join(base, '.claude', 'agents'), { recursive: true });
    realRoots = await agentRealRoots(roots); // batch-precomputed once, as the mutation does
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('resolves an in-bounds agent file', async () => {
    const f = path.join(base, '.claude', 'agents', 'a.md');
    await fs.writeFile(f, 'x');
    await expect(resolveAgentSource(f, roots, realRoots)).resolves.toBe(await fs.realpath(f));
  });

  it('rejects a path outside the allowed agent dirs', async () => {
    await expect(resolveAgentSource('/etc/hosts', roots, realRoots)).rejects.toThrow('outside');
  });

  it('rejects a symlink that escapes the allowed dirs (no secret exfil via a link)', async () => {
    const secret = path.join(base, 'secret.md');
    await fs.writeFile(secret, 'SECRET');
    const link = path.join(base, '.claude', 'agents', 'innocent.md');
    await fs.symlink(secret, link);
    await expect(resolveAgentSource(link, roots, realRoots)).rejects.toThrow('outside');
  });
});
