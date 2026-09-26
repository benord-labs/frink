import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyUserSkill, PROVENANCE_MARKER, projectSkill } from './skill-projection';

const { mockHome, dirHashSpy } = vi.hoisted(() => ({
  mockHome: { value: '' },
  dirHashSpy: vi.fn(),
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => mockHome.value;
  // `default` too — a spread alone leaves it pointing at the real module (see test-mock-home).
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));
// Wrap dirHash (real impl) so a test can assert it is NOT called on the stat fast-path.
vi.mock('./skill-fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skill-fs')>();
  dirHashSpy.mockImplementation(actual.dirHash);
  return { ...actual, dirHash: dirHashSpy };
});

const SKILL = '---\nname: reviewer\ndescription: x\n---\nbody\n';

describe('projectSkill (PCH-2)', () => {
  let tmp: string;
  let srcSkill: string;
  const claudeTarget = () => path.join(tmp, '.claude', 'skills', 'reviewer');
  const allTargets = () => [
    path.join(tmp, '.agents', 'skills', 'reviewer'),
    path.join(tmp, '.claude', 'skills', 'reviewer'),
    path.join(tmp, '.cursor', 'skills', 'reviewer'),
  ];

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pch2-skills-'));
    mockHome.value = tmp;
    vi.stubEnv('FRINK_HOME', tmp);
    srcSkill = path.join(tmp, 'src', 'reviewer');
    await fs.mkdir(srcSkill, { recursive: true });
    await fs.writeFile(path.join(srcSkill, 'SKILL.md'), SKILL);
    await fs.writeFile(path.join(srcSkill, 'ref.md'), 'reference\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('copies the skill into all three universal targets, provenance-marked', async () => {
    await projectSkill('reviewer', srcSkill);
    for (const t of allTargets()) {
      expect(existsSync(path.join(t, 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(t, 'ref.md'))).toBe(true);
      expect(existsSync(path.join(t, PROVENANCE_MARKER))).toBe(true);
    }
  });

  it('migrates an existing symlink target to a real copy', async () => {
    const target = claudeTarget();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(srcSkill, target, 'dir');
    await projectSkill('reviewer', srcSkill);
    const lst = await fs.lstat(target);
    expect(lst.isSymbolicLink()).toBe(false);
    expect(lst.isDirectory()).toBe(true);
    expect(existsSync(path.join(target, PROVENANCE_MARKER))).toBe(true);
  });

  it('never clobbers a user-authored skill dir (no provenance)', async () => {
    const target = claudeTarget();
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'USER OWN\n');
    await projectSkill('reviewer', srcSkill);
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toContain('USER OWN');
    expect(existsSync(path.join(target, PROVENANCE_MARKER))).toBe(false);
  });

  it('preserves a user edit to a projected copy (reconcile)', async () => {
    await projectSkill('reviewer', srcSkill);
    await fs.writeFile(path.join(claudeTarget(), 'SKILL.md'), 'EDITED BY USER\n');
    await projectSkill('reviewer', srcSkill);
    expect(await fs.readFile(path.join(claudeTarget(), 'SKILL.md'), 'utf8')).toContain(
      'EDITED BY USER',
    );
  });

  it('re-projects when the source changed', async () => {
    await projectSkill('reviewer', srcSkill);
    await fs.writeFile(
      path.join(srcSkill, 'SKILL.md'),
      '---\nname: reviewer\ndescription: y\n---\nNEW body\n',
    );
    await projectSkill('reviewer', srcSkill);
    expect(await fs.readFile(path.join(claudeTarget(), 'SKILL.md'), 'utf8')).toContain('NEW body');
  });

  // Multi-pane: concurrent spawns hit the same skill. The mutex must serialize so no
  // target is ever left half-written (staged-but-not-replaced).
  it('serializes concurrent projections without a half-state', async () => {
    await Promise.all([
      projectSkill('reviewer', srcSkill),
      projectSkill('reviewer', srcSkill),
      projectSkill('reviewer', srcSkill),
    ]);
    for (const t of allTargets()) {
      expect(existsSync(path.join(t, 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(t, PROVENANCE_MARKER))).toBe(true);
      // No staging/backup leftovers beside the target.
      const siblings = await fs.readdir(path.dirname(t));
      expect(siblings.some((n) => n.includes('.staging-') || n.includes('.old-'))).toBe(false);
    }
  });

  // sc-849: an unchanged re-projection must take the stat fast-path — NO content hashing.
  it('skips content hashing on an unchanged re-projection (stat short-circuit)', async () => {
    await projectSkill('reviewer', srcSkill);
    dirHashSpy.mockClear();
    await projectSkill('reviewer', srcSkill); // nothing changed
    expect(dirHashSpy).not.toHaveBeenCalled();
    // And the copy was not rewritten (still intact).
    expect(await fs.readFile(path.join(claudeTarget(), 'SKILL.md'), 'utf8')).toBe(SKILL);
  });

  // sc-849 Crit#3: a stat-INVISIBLE edit (same size + restored mtime) must NOT be
  // clobbered — the stat short-circuit may only elect a no-op, never an overwrite.
  it('preserves a projected-copy edit that the stat signature cannot see (touch -r case)', async () => {
    await projectSkill('reviewer', srcSkill);
    const target = claudeTarget();
    const file = path.join(target, 'SKILL.md');
    const before = await fs.stat(file);
    // Same-length edit ('body' → 'BODY'), then restore the original mtime so the stat-sig matches.
    const edited = SKILL.replace('body', 'BODY');
    expect(edited.length).toBe(SKILL.length);
    await fs.writeFile(file, edited);
    await fs.utimes(file, before.atime, before.mtime);
    await projectSkill('reviewer', srcSkill); // source unchanged → short-circuit elects no-op
    expect(await fs.readFile(file, 'utf8')).toBe(edited); // edit survived
  });

  // sc-849 back-compat: an OLD marker carrying only {hash} (no sig/srcSig) must reconcile
  // via the content-hash fallback, not crash.
  it('reconciles an old {hash}-only marker via the content-hash fallback', async () => {
    await projectSkill('reviewer', srcSkill);
    const markerPath = path.join(claudeTarget(), PROVENANCE_MARKER);
    const { hash } = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    await fs.writeFile(markerPath, JSON.stringify({ hash })); // strip sig/srcSig
    await fs.writeFile(
      path.join(srcSkill, 'SKILL.md'),
      '---\nname: reviewer\ndescription: z\n---\nUPDATED\n',
    );
    await projectSkill('reviewer', srcSkill); // no sig → falls through to dirHash → overwrites
    expect(await fs.readFile(path.join(claudeTarget(), 'SKILL.md'), 'utf8')).toContain('UPDATED');
  });

  // Crash debris (`<name>.staging-<pid>-<ts>` / `<name>.old-<ts>`) is swept before a fresh
  // copy — but ONLY exact debris grammar: a user skill merely containing ".old-" survives.
  it('sweeps crash-orphaned staging/backup dirs but never a look-alike user dir', async () => {
    const base = path.join(tmp, '.claude', 'skills');
    await fs.mkdir(path.join(base, 'reviewer.staging-123-456'), { recursive: true });
    await fs.mkdir(path.join(base, 'reviewer.old-1718000000000'), { recursive: true });
    const userDir = path.join(base, 'my-prompt.old-draft'); // user-authored, NOT debris
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'SKILL.md'), 'keep me\n');
    await projectSkill('reviewer', srcSkill);
    expect(existsSync(path.join(base, 'reviewer.staging-123-456'))).toBe(false);
    expect(existsSync(path.join(base, 'reviewer.old-1718000000000'))).toBe(false);
    expect(await fs.readFile(path.join(userDir, 'SKILL.md'), 'utf8')).toBe('keep me\n');
  });

  // sc-849: a DANGLING symlink target (lstat sees a symlink, existsSync would not) migrates.
  it('migrates a dangling symlink target to a real copy', async () => {
    const target = claudeTarget();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(tmp, 'does-not-exist'), target, 'dir');
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    await projectSkill('reviewer', srcSkill);
    const lst = await fs.lstat(target);
    expect(lst.isSymbolicLink()).toBe(false);
    expect(existsSync(path.join(target, 'SKILL.md'))).toBe(true);
  });

  // Orphan sweep is anchored to the EXACT debris grammar — a user dir that merely
  // contains "old-"/"staging-" must survive; only real `<name>.old-<ts>` is removed.
  it('sweeps real crash debris but never a similarly-named user dir', async () => {
    const base = path.join(tmp, '.claude', 'skills');
    await fs.mkdir(base, { recursive: true });
    const userDir = path.join(base, 'notes.old-draft'); // "old-" but not all-numeric ts
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'x.md'), 'mine');
    const orphan = path.join(base, 'reviewer.old-1700000000000'); // real debris
    await fs.mkdir(orphan, { recursive: true });
    await projectSkill('reviewer', srcSkill); // fresh copy → sweepOrphans(base) runs
    expect(existsSync(userDir)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe('copyUserSkill (user-initiated copy across)', () => {
  let base: string;
  let src: string;
  // The `<base>/<tool>/skills` dirs passed to copyUserSkill (it joins the skill name itself).
  const targetDirs = () => [
    path.join(base, '.agents', 'skills'),
    path.join(base, '.claude', 'skills'),
    path.join(base, '.cursor', 'skills'),
  ];
  // The fully-qualified copy dirs (with the skill name) for existence assertions.
  const targets = () => targetDirs().map((d) => path.join(d, 'mine'));

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-across-'));
    src = path.join(base, '.cursor', 'skills', 'mine'); // a Cursor-only source under this base
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '---\nname: mine\ndescription: x\n---\nbody\n');
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('copies into every tool dir as a PLAIN user skill (no .frink-projected marker)', async () => {
    // .agents + .claude get written; .cursor IS the source → skip-self. So wrote=2, kept=0.
    const { wrote, kept } = await copyUserSkill('mine', src, targetDirs());
    expect(wrote).toBe(2);
    expect(kept).toBe(0);
    for (const t of targets()) {
      expect(existsSync(path.join(t, 'SKILL.md'))).toBe(true);
      // The user's copy must NOT be marked Frink-managed (else the scan would skip it).
      expect(existsSync(path.join(t, PROVENANCE_MARKER))).toBe(false);
    }
  });

  it('skips the target that IS the source (never copies onto itself)', async () => {
    await copyUserSkill('mine', src, targetDirs()); // src === base/.cursor/skills/mine
    // .cursor copy is the source itself — still present + still unmarked.
    expect(existsSync(path.join(src, 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(src, PROVENANCE_MARKER))).toBe(false);
  });

  it('never clobbers a hand-edited target — reports it as kept, still writes the rest', async () => {
    const claudeCopy = path.join(base, '.claude', 'skills', 'mine');
    await fs.mkdir(claudeCopy, { recursive: true });
    await fs.writeFile(path.join(claudeCopy, 'SKILL.md'), 'MY EDITED VERSION');
    // .agents written (wrote=1); .claude diverges → preserved (kept=1); .cursor is the source (self).
    const { wrote, kept } = await copyUserSkill('mine', src, targetDirs());
    expect(wrote).toBe(1);
    expect(kept).toBe(1);
    expect(await fs.readFile(path.join(claudeCopy, 'SKILL.md'), 'utf8')).toBe('MY EDITED VERSION');
  });

  it('fails loudly when the source directory is missing (never a silent "kept" no-op)', async () => {
    const gone = path.join(base, '.cursor', 'skills', 'vanished');
    await expect(copyUserSkill('vanished', gone, targetDirs())).rejects.toThrow(
      'Skill source missing',
    );
  });

  it('rejects a traversal-laden skill name before touching the filesystem', async () => {
    await expect(copyUserSkill('../escape', src, targetDirs())).rejects.toThrow(
      'Invalid skill name',
    );
  });
});
