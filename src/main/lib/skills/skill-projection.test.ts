import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirHash } from './skill-fs';
import { copyUserSkill, PROVENANCE_MARKER, projectSkill } from './skill-projection';

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: '' } }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => mockHome.value;
  // `default` too — a spread alone leaves it pointing at the real module (see test-mock-home).
  return { ...actual, default: { ...actual, homedir }, homedir };
});
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

const warnSpy = vi.mocked(log.warn);
// A projection that hashed would hit the unreadable source file and fail, logging a warning;
// the stat signature ignores permission bits. Windows and root do not enforce them.
const canHideContent = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Run `project` with source `file` unreadable; no warning proves it read no content. */
async function expectNoContentRead(file: string, project: () => Promise<void>): Promise<void> {
  warnSpy.mockClear();
  await fs.chmod(file, 0o000);
  await project();
  await fs.chmod(file, 0o644);
  expect(warnSpy).not.toHaveBeenCalled();
}

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
  it.skipIf(!canHideContent)(
    'skips content hashing on an unchanged re-projection (stat short-circuit)',
    async () => {
      await projectSkill('reviewer', srcSkill);
      await expectNoContentRead(path.join(srcSkill, 'SKILL.md'), () =>
        projectSkill('reviewer', srcSkill),
      );
    },
  );

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
    await projectSkill('reviewer', srcSkill); // no sig → falls through to content hashes → overwrites
    expect(await fs.readFile(path.join(claudeTarget(), 'SKILL.md'), 'utf8')).toContain('UPDATED');
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    expect(marker.files).toEqual({ 'SKILL.md': expect.any(String), 'ref.md': expect.any(String) });
  });

  describe('per-file merge of an edited copy', () => {
    const NEW_REF = 'reference v2\n';
    const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), 'utf8');
    const readMarker = async (dir: string) =>
      JSON.parse(await fs.readFile(path.join(dir, PROVENANCE_MARKER), 'utf8'));
    const editSkillMd = () => fs.writeFile(path.join(claudeTarget(), 'SKILL.md'), 'MY EDIT\n');
    const changeSourceRef = () => fs.writeFile(path.join(srcSkill, 'ref.md'), NEW_REF);
    /** Rewrite the marker the way a build without per-file baselines left it. */
    const downgradeMarker = async (dir: string) => {
      const { hash, sig, srcSig } = await readMarker(dir);
      await fs.writeFile(path.join(dir, PROVENANCE_MARKER), JSON.stringify({ hash, sig, srcSig }));
    };

    beforeEach(() => {
      warnSpy.mockClear();
    });

    it('keeps the edited file and updates its siblings; other tool dirs update fully', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await changeSourceRef();
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}more\n`);
      await projectSkill('reviewer', srcSkill);

      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
      for (const t of allTargets().filter((t) => t !== claudeTarget())) {
        expect(await read(t, 'SKILL.md')).toBe(`${SKILL}more\n`);
        expect(await read(t, 'ref.md')).toBe(NEW_REF);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('SKILL.md');
    });

    it.skipIf(!canHideContent)(
      'checks a merge once, then does nothing: no hashing, no write, no warning',
      async () => {
        await projectSkill('reviewer', srcSkill);
        await editSkillMd();
        await changeSourceRef();
        await projectSkill('reviewer', srcSkill); // merges
        warnSpy.mockClear();
        await projectSkill('reviewer', srcSkill); // checks the merged result once
        expect(warnSpy).not.toHaveBeenCalled();
        expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
        const markerPath = path.join(claudeTarget(), PROVENANCE_MARKER);
        const markerBefore = await fs.stat(markerPath);
        warnSpy.mockClear();

        await expectNoContentRead(path.join(srcSkill, 'SKILL.md'), () =>
          projectSkill('reviewer', srcSkill),
        );

        expect(warnSpy).not.toHaveBeenCalled();
        expect((await fs.stat(markerPath)).mtimeMs).toBe(markerBefore.mtimeMs);
      },
    );

    it('restores a file deleted right after a merge on the next projection', async () => {
      await projectSkill('reviewer', srcSkill);
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      // As if removed while the merge was finishing: nothing may hide it from the next run.
      await fs.rm(path.join(claudeTarget(), 'SKILL.md'));
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe(SKILL);
    });

    it.skipIf(!canHideContent)(
      'hashes an edited copy once while the source is unchanged, then takes the fast path',
      async () => {
        await projectSkill('reviewer', srcSkill);
        await editSkillMd();
        await projectSkill('reviewer', srcSkill); // content-verifies the edit, re-records signatures

        await expectNoContentRead(path.join(srcSkill, 'SKILL.md'), () =>
          projectSkill('reviewer', srcSkill),
        );

        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it('restores the source version of a kept file once the user deletes it', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(claudeTarget(), 'SKILL.md'));
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe(SKILL);

      // No longer treated as edited: the next source change to it is applied.
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v3\n`);
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe(`${SKILL}v3\n`);
    });

    it('keeps the edit across a second source change to the same file', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v2\n`);
      await projectSkill('reviewer', srcSkill);
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v3\n`);
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('carries a user-added file over, even when the source later adds the same path', async () => {
      await projectSkill('reviewer', srcSkill);
      await fs.mkdir(path.join(claudeTarget(), 'notes'));
      await fs.writeFile(path.join(claudeTarget(), 'notes', 'mine.md'), 'my notes\n');
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'notes/mine.md')).toBe('my notes\n');

      await fs.mkdir(path.join(srcSkill, 'notes'));
      await fs.writeFile(path.join(srcSkill, 'notes', 'mine.md'), 'shipped notes\n');
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'notes/mine.md')).toBe('my notes\n');
      const agents = allTargets()[0];
      expect(await read(agents, 'notes/mine.md')).toBe('shipped notes\n');
    });

    it('removes a file the source dropped, unless the user edited it', async () => {
      await projectSkill('reviewer', srcSkill);
      const cursor = allTargets()[2];
      await fs.writeFile(path.join(cursor, 'ref.md'), 'my ref\n');
      await fs.rm(path.join(srcSkill, 'ref.md'));
      await projectSkill('reviewer', srcSkill);
      expect(existsSync(path.join(claudeTarget(), 'ref.md'))).toBe(false);
      expect(await read(cursor, 'ref.md')).toBe('my ref\n');
    });

    it.skipIf(!canHideContent)('leaves a copy file it cannot read alone', async () => {
      await projectSkill('reviewer', srcSkill);
      const file = path.join(claudeTarget(), 'ref.md');
      await fs.writeFile(file, 'my ref\n');
      await fs.chmod(file, 0o200);
      await changeSourceRef();
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v2\n`);
      await projectSkill('reviewer', srcSkill);
      await fs.chmod(file, 0o644);
      expect(await read(claudeTarget(), 'ref.md')).toBe('my ref\n');
      expect(await read(claudeTarget(), 'SKILL.md')).toBe(`${SKILL}v2\n`);
    });

    it.skipIf(!canHideContent)(
      'waits for an unreadable source file instead of deleting it',
      async () => {
        await projectSkill('reviewer', srcSkill);
        await fs.chmod(path.join(srcSkill, 'ref.md'), 0o000);
        await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v2\n`);
        await projectSkill('reviewer', srcSkill);
        await fs.chmod(path.join(srcSkill, 'ref.md'), 0o644);
        expect(await read(claudeTarget(), 'ref.md')).toBe('reference\n');
        await projectSkill('reviewer', srcSkill);
        expect(await read(claudeTarget(), 'SKILL.md')).toBe(`${SKILL}v2\n`);
      },
    );

    it.skipIf(!canHideContent)(
      'waits for an unreadable source folder instead of deleting its files',
      async () => {
        await fs.mkdir(path.join(srcSkill, 'refs'));
        await fs.writeFile(path.join(srcSkill, 'refs', 'a.md'), 'a\n');
        await projectSkill('reviewer', srcSkill);
        await fs.chmod(path.join(srcSkill, 'refs'), 0o000);
        await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v2\n`);
        await projectSkill('reviewer', srcSkill);
        await fs.chmod(path.join(srcSkill, 'refs'), 0o755);
        expect(await read(claudeTarget(), 'refs/a.md')).toBe('a\n');
      },
    );

    it('writes the marker without leaving temp files behind', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      const siblings = await fs.readdir(path.dirname(claudeTarget()));
      expect(siblings).toEqual(['reviewer']);
    });

    it('removes a dropped file whose name is also a built-in object key', async () => {
      await fs.writeFile(path.join(srcSkill, 'toString'), 'x\n');
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(srcSkill, 'toString'));
      await projectSkill('reviewer', srcSkill);
      expect(existsSync(path.join(claudeTarget(), 'toString'))).toBe(false);
    });

    it('keeps a stat-invisible edit when a sibling later changes in the source', async () => {
      await projectSkill('reviewer', srcSkill);
      const file = path.join(claudeTarget(), 'SKILL.md');
      const before = await fs.stat(file);
      const edited = SKILL.replace('body', 'BODY');
      await fs.writeFile(file, edited);
      await fs.utimes(file, before.atime, before.mtime);
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await fs.readFile(file, 'utf8')).toBe(edited);
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('records the source hash, so a build that compares whole trees sees kept edits as edited', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      const exclude = new Set([PROVENANCE_MARKER]);
      const { hash } = await readMarker(claudeTarget());
      expect(hash).toBe(await dirHash(srcSkill, exclude));
      expect(hash).not.toBe(await dirHash(claudeTarget(), exclude));
      // A clean copy still reads as clean.
      const agents = allTargets()[0];
      expect((await readMarker(agents)).hash).toBe(await dirHash(agents, exclude));
    });

    /** Edit SKILL.md, then set its modification time back to before the projection. */
    const editSkillMdBackdated = async () => {
      await editSkillMd();
      const past = new Date('2001-01-01T00:00:00Z');
      await fs.utimes(path.join(claudeTarget(), 'SKILL.md'), past, past);
    };

    it('migrates an edited copy with an older marker: the edit is kept, siblings update', async () => {
      await projectSkill('reviewer', srcSkill);
      await downgradeMarker(claudeTarget());
      await editSkillMdBackdated();
      await changeSourceRef();
      await fs.writeFile(path.join(srcSkill, 'extra.md'), 'extra\n');
      await projectSkill('reviewer', srcSkill);

      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
      expect(await read(claudeTarget(), 'extra.md')).toBe('extra\n');
      expect(warnSpy.mock.calls[0][0]).toContain('SKILL.md');
      expect(warnSpy.mock.calls[0][0]).not.toContain('ref.md');
      const { files } = await readMarker(claudeTarget());
      expect(files).toEqual({ 'extra.md': expect.any(String), 'ref.md': expect.any(String) });
    });

    it.each([
      ['not JSON', 'not json'],
      ['a hash that is not a hash', '{"hash":"garbage"}'],
      ['JSON without a hash', '{"files":{}}'],
      ['empty', ''],
    ])(
      'keeps every differing file when the marker is %s, and restores missing ones',
      async (_label, body) => {
        await projectSkill('reviewer', srcSkill);
        await editSkillMd();
        // Corrupted after the edit: its timestamp can no longer say what was edited.
        await fs.writeFile(path.join(claudeTarget(), PROVENANCE_MARKER), body);
        await fs.rm(path.join(claudeTarget(), 'ref.md'));
        await changeSourceRef();
        await projectSkill('reviewer', srcSkill);
        expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
        expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
        expect((await readMarker(claudeTarget())).files['ref.md']).toEqual(expect.any(String));
      },
    );

    it.each([
      ['a non-string hash', { 'SKILL.md': null }],
      ['an empty hash', { 'SKILL.md': '' }],
      ['an array', ['SKILL.md']],
      ['a string', 'SKILL.md'],
    ])('reads a per-file baseline that is %s as an older marker', async (_label, files) => {
      await projectSkill('reviewer', srcSkill);
      const marker = await readMarker(claudeTarget());
      await fs.writeFile(
        path.join(claudeTarget(), PROVENANCE_MARKER),
        JSON.stringify({ ...marker, files }),
      );
      await editSkillMdBackdated();
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);

      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('restores a deleted manifest in a projected copy of a shipped skill', async () => {
      await fs.writeFile(path.join(srcSkill, '.baseline.json'), '{"version":"1","files":{}}');
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(claudeTarget(), '.baseline.json'));
      await projectSkill('reviewer', srcSkill);
      expect(existsSync(path.join(claudeTarget(), '.baseline.json'))).toBe(true);
    });

    it('never writes to or marks a source that lives inside a target base', async () => {
      const own = path.join(tmp, '.cursor', 'skills', 'mine');
      await fs.mkdir(own, { recursive: true });
      await fs.writeFile(path.join(own, 'SKILL.md'), SKILL);
      await projectSkill('mine', own);
      await fs.writeFile(path.join(own, 'SKILL.md'), `${SKILL}v2\n`);
      await projectSkill('mine', own);

      expect(existsSync(path.join(own, PROVENANCE_MARKER))).toBe(false);
      expect(await fs.readdir(own)).toEqual(['SKILL.md']);
      for (const tool of ['.agents', '.claude']) {
        const copy = path.join(tmp, tool, 'skills', 'mine');
        expect(await read(copy, 'SKILL.md')).toBe(`${SKILL}v2\n`);
        expect(existsSync(path.join(copy, PROVENANCE_MARKER))).toBe(true);
      }
    });

    it('keeps an edited file when the source turns that path into a directory', async () => {
      await projectSkill('reviewer', srcSkill);
      await fs.writeFile(path.join(claudeTarget(), 'ref.md'), 'my ref\n');
      await fs.rm(path.join(srcSkill, 'ref.md'));
      await fs.mkdir(path.join(srcSkill, 'ref.md'));
      await fs.writeFile(path.join(srcSkill, 'ref.md', 'part.md'), 'part\n');
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v2\n`);
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'ref.md')).toBe('my ref\n');
      expect(await read(claudeTarget(), 'SKILL.md')).toBe(`${SKILL}v2\n`);
    });

    it('keeps an added nested file when the source turns its folder into a file', async () => {
      await projectSkill('reviewer', srcSkill);
      await fs.mkdir(path.join(claudeTarget(), 'notes'));
      await fs.writeFile(path.join(claudeTarget(), 'notes', 'mine.md'), 'my notes\n');
      await fs.writeFile(path.join(srcSkill, 'notes'), 'now a file\n');
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'notes/mine.md')).toBe('my notes\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('replaces an empty folder the user left where the source now has a file', async () => {
      await projectSkill('reviewer', srcSkill);
      await fs.mkdir(path.join(claudeTarget(), 'guide.md'));
      await fs.writeFile(path.join(srcSkill, 'guide.md'), 'guide\n');
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'guide.md')).toBe('guide\n');
    });

    /** True when `rel` in `dir` is a real file, not a symlink. */
    const isRealFile = async (dir: string, rel: string) =>
      (await fs.lstat(path.join(dir, rel))).isFile();

    it('copies what a source symlink points to as a real file, on first projection and after', async () => {
      await fs.writeFile(path.join(tmp, 'shared.md'), 'shared\n');
      await fs.symlink(path.join(tmp, 'shared.md'), path.join(srcSkill, 'first.md'));
      await projectSkill('reviewer', srcSkill);
      await fs.symlink(path.join(tmp, 'shared.md'), path.join(srcSkill, 'later.md'));
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      for (const t of allTargets()) {
        expect(await read(t, 'ref.md')).toBe(NEW_REF);
        for (const rel of ['first.md', 'later.md']) {
          expect(await read(t, rel)).toBe('shared\n');
          expect(await isRealFile(t, rel)).toBe(true);
        }
      }
      // Removing the linked file from the source side cannot break the copies.
      await fs.rm(path.join(tmp, 'shared.md'));
      expect(await read(claudeTarget(), 'first.md')).toBe('shared\n');
    });

    it('copies a symlinked source folder as a real folder and follows its changes', async () => {
      await fs.mkdir(path.join(tmp, 'shared-refs'));
      await fs.writeFile(path.join(tmp, 'shared-refs', 'a.md'), 'a\n');
      await fs.symlink(path.join(tmp, 'shared-refs'), path.join(srcSkill, 'refs'), 'dir');
      await projectSkill('reviewer', srcSkill);
      expect((await fs.lstat(path.join(claudeTarget(), 'refs'))).isDirectory()).toBe(true);
      await fs.writeFile(path.join(tmp, 'shared-refs', 'a.md'), 'a v2\n');
      await projectSkill('reviewer', srcSkill);
      for (const t of allTargets()) expect(await read(t, 'refs/a.md')).toBe('a v2\n');
    });

    it('copies every link to the same folder, including one beside the real folder', async () => {
      await fs.mkdir(path.join(srcSkill, 'refs'));
      await fs.writeFile(path.join(srcSkill, 'refs', 'a.md'), 'a\n');
      await fs.symlink(path.join(srcSkill, 'refs'), path.join(srcSkill, 'alias-1'), 'dir');
      await fs.symlink(path.join(srcSkill, 'refs'), path.join(srcSkill, 'alias-2'), 'dir');
      await projectSkill('reviewer', srcSkill);
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      for (const rel of ['refs/a.md', 'alias-1/a.md', 'alias-2/a.md']) {
        expect(await read(claudeTarget(), rel)).toBe('a\n');
      }
    });

    it('does not loop on a source symlink that points back up the tree', async () => {
      await fs.symlink(srcSkill, path.join(srcSkill, 'loop'), 'dir');
      await projectSkill('reviewer', srcSkill);
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('projects a source change that only repoints a symlink', async () => {
      await fs.writeFile(path.join(tmp, 'shared.md'), 'shared\n');
      await fs.writeFile(path.join(tmp, 'other.md'), 'other\n');
      await fs.symlink(path.join(tmp, 'shared.md'), path.join(srcSkill, 'shared.md'));
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(srcSkill, 'shared.md'));
      await fs.symlink(path.join(tmp, 'other.md'), path.join(srcSkill, 'shared.md'));
      await projectSkill('reviewer', srcSkill);
      for (const t of allTargets()) expect(await read(t, 'shared.md')).toBe('other\n');
    });

    it('projects a repoint between two files of the same size and time', async () => {
      const when = new Date('2020-01-01T00:00:00Z');
      for (const [name, body] of [
        ['one.md', 'AAAA\n'],
        ['two.md', 'BBBB\n'],
      ]) {
        await fs.writeFile(path.join(tmp, name), body);
        await fs.utimes(path.join(tmp, name), when, when);
      }
      await fs.symlink(path.join(tmp, 'one.md'), path.join(srcSkill, 'shared.md'));
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(srcSkill, 'shared.md'));
      await fs.symlink(path.join(tmp, 'two.md'), path.join(srcSkill, 'shared.md'));
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'shared.md')).toBe('BBBB\n');
    });

    it('replaces a symlink an older projection left in a copy with a real file', async () => {
      await fs.writeFile(path.join(tmp, 'shared.md'), 'shared\n');
      await fs.symlink(path.join(tmp, 'shared.md'), path.join(srcSkill, 'shared.md'));
      await projectSkill('reviewer', srcSkill);
      const copied = path.join(claudeTarget(), 'shared.md');
      await fs.rm(copied);
      await fs.symlink(path.join(tmp, 'shared.md'), copied);
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await isRealFile(claudeTarget(), 'shared.md')).toBe(true);
      expect(await fs.readFile(path.join(tmp, 'shared.md'), 'utf8')).toBe('shared\n');
    });

    it('replaces a folder symlink an older projection left with a real folder', async () => {
      await fs.mkdir(path.join(tmp, 'shared-refs'));
      await fs.writeFile(path.join(tmp, 'shared-refs', 'a.md'), 'a\n');
      await fs.symlink(path.join(tmp, 'shared-refs'), path.join(srcSkill, 'refs'), 'dir');
      await projectSkill('reviewer', srcSkill);
      // As an older projection left it: the copy's `refs` is a link to the same folder.
      await fs.rm(path.join(claudeTarget(), 'refs'), { recursive: true });
      await fs.symlink(path.join(tmp, 'shared-refs'), path.join(claudeTarget(), 'refs'), 'dir');
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect((await fs.lstat(path.join(claudeTarget(), 'refs'))).isDirectory()).toBe(true);
      expect(await read(claudeTarget(), 'refs/a.md')).toBe('a\n');
      expect(await read(tmp, 'shared-refs/a.md')).toBe('a\n');
    });

    it('replaces a leftover symlink to an empty folder with a real empty folder', async () => {
      await fs.mkdir(path.join(tmp, 'empty-refs'));
      await fs.symlink(path.join(tmp, 'empty-refs'), path.join(srcSkill, 'refs'), 'dir');
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(claudeTarget(), 'refs'), { recursive: true, force: true });
      await fs.symlink(path.join(tmp, 'empty-refs'), path.join(claudeTarget(), 'refs'), 'dir');
      await projectSkill('reviewer', srcSkill); // nothing else differs from the source
      // The source's empty folder is carried as a real one in place of the link.
      expect((await fs.lstat(path.join(claudeTarget(), 'refs'))).isDirectory()).toBe(true);
    });

    it('never writes into a folder the user linked into their copy', async () => {
      await fs.mkdir(path.join(srcSkill, 'refs'));
      await fs.writeFile(path.join(srcSkill, 'refs', 'a.md'), 'a\n');
      await projectSkill('reviewer', srcSkill);
      await fs.mkdir(path.join(tmp, 'outside'));
      await fs.rm(path.join(claudeTarget(), 'refs'), { recursive: true });
      await fs.symlink(path.join(tmp, 'outside'), path.join(claudeTarget(), 'refs'), 'dir');
      await fs.writeFile(path.join(srcSkill, 'refs', 'b.md'), 'b\n');
      await projectSkill('reviewer', srcSkill);
      expect(await fs.readdir(path.join(tmp, 'outside'))).toEqual([]);
    });

    it('keeps a folder symlink the user pointed somewhere else', async () => {
      await fs.mkdir(path.join(srcSkill, 'refs'));
      await fs.writeFile(path.join(srcSkill, 'refs', 'a.md'), 'a\n');
      await fs.mkdir(path.join(tmp, 'my-refs'));
      await fs.writeFile(path.join(tmp, 'my-refs', 'mine.md'), 'mine\n');
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(claudeTarget(), 'refs'), { recursive: true });
      await fs.symlink(path.join(tmp, 'my-refs'), path.join(claudeTarget(), 'refs'), 'dir');
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect((await fs.lstat(path.join(claudeTarget(), 'refs'))).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(path.join(tmp, 'my-refs'))).toEqual(['mine.md']);
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('keeps a copy symlink whose source path is gone, without touching what it points to', async () => {
      await fs.writeFile(path.join(tmp, 'shared.md'), 'shared\n');
      await projectSkill('reviewer', srcSkill);
      // A link in the copy with no source counterpart: nothing proves Frink made it.
      await fs.symlink(path.join(tmp, 'shared.md'), path.join(claudeTarget(), 'old.md'));
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect((await fs.lstat(path.join(claudeTarget(), 'old.md'))).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(tmp, 'shared.md'), 'utf8')).toBe('shared\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it.skipIf(process.platform === 'win32')(
      'never reads through a symlink in the copy',
      async () => {
        await projectSkill('reviewer', srcSkill);
        // Reading a FIFO blocks until a writer appears, so any read through this link would hang.
        const fifo = path.join(tmp, 'pipe');
        execFileSync('mkfifo', [fifo]);
        await fs.symlink(fifo, path.join(claudeTarget(), 'peek.md'));
        await changeSourceRef();
        await projectSkill('reviewer', srcSkill);
        expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
        expect((await fs.lstat(path.join(claudeTarget(), 'peek.md'))).isSymbolicLink()).toBe(true);
      },
    );

    it('never reaches into the source through a folder symlink left in a copy', async () => {
      await fs.mkdir(path.join(srcSkill, 'refs'));
      await fs.writeFile(path.join(srcSkill, 'refs', 'a.md'), 'a\n');
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(claudeTarget(), 'refs'), { recursive: true });
      await fs.symlink(path.join(srcSkill, 'refs'), path.join(claudeTarget(), 'refs'), 'dir');
      await fs.rm(path.join(srcSkill, 'refs', 'a.md'));
      await fs.writeFile(path.join(srcSkill, 'refs', 'b.md'), 'b\n');
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(srcSkill, 'refs/b.md')).toBe('b\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('keeps a symlink the user repointed in their copy', async () => {
      await fs.writeFile(path.join(tmp, 'shared.md'), 'shared\n');
      await fs.writeFile(path.join(tmp, 'mine.md'), 'mine\n');
      await fs.symlink(path.join(tmp, 'shared.md'), path.join(srcSkill, 'shared.md'));
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(claudeTarget(), 'shared.md'));
      await fs.symlink(path.join(tmp, 'mine.md'), path.join(claudeTarget(), 'shared.md'));
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'shared.md')).toBe('mine\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
    });

    it('applies the next source change after the source converges on the user edit', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), 'MY EDIT\n');
      await projectSkill('reviewer', srcSkill);
      await fs.writeFile(path.join(srcSkill, 'SKILL.md'), `${SKILL}v3\n`);
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe(`${SKILL}v3\n`);
    });

    it('leaves every copy intact when the source directory disappears', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await fs.rm(srcSkill, { recursive: true });
      await projectSkill('reviewer', srcSkill);
      for (const t of allTargets()) expect(existsSync(path.join(t, 'ref.md'))).toBe(true);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
    });

    it('removes a dropped nested file but keeps the folder while a kept file remains in it', async () => {
      await fs.mkdir(path.join(srcSkill, 'refs', 'deep'), { recursive: true });
      await fs.writeFile(path.join(srcSkill, 'refs', 'a.md'), 'a\n');
      await fs.writeFile(path.join(srcSkill, 'refs', 'deep', 'b.md'), 'b\n');
      await projectSkill('reviewer', srcSkill);
      await fs.writeFile(path.join(claudeTarget(), 'refs', 'a.md'), 'my a\n');
      await fs.rm(path.join(srcSkill, 'refs'), { recursive: true });
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'refs/a.md')).toBe('my a\n');
      expect(existsSync(path.join(claudeTarget(), 'refs', 'deep'))).toBe(false);
      expect(existsSync(path.join(allTargets()[0], 'refs'))).toBe(false);
    });

    it('follows a case-only rename of an unedited file', async () => {
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(srcSkill, 'ref.md'));
      await fs.writeFile(path.join(srcSkill, 'Ref.md'), NEW_REF);
      await projectSkill('reviewer', srcSkill);
      await projectSkill('reviewer', srcSkill);
      const names = (await fs.readdir(claudeTarget())).filter((n) => n.toLowerCase() === 'ref.md');
      expect(names).toEqual(['Ref.md']);
      expect(await read(claudeTarget(), 'Ref.md')).toBe(NEW_REF);
    });

    it('works when one tool skills folder is a symlink to another', async () => {
      await fs.mkdir(path.join(tmp, '.agents', 'skills'), { recursive: true });
      await fs.mkdir(path.join(tmp, '.claude'), { recursive: true });
      await fs.symlink(path.join(tmp, '.agents', 'skills'), path.join(tmp, '.claude', 'skills'));
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await changeSourceRef();
      await projectSkill('reviewer', srcSkill);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
      expect(await read(allTargets()[2], 'SKILL.md')).toBe(SKILL);
    });

    it('carries empty source folders, on the first copy and when one is added later', async () => {
      await fs.mkdir(path.join(srcSkill, 'scratch'));
      await projectSkill('reviewer', srcSkill);
      expect((await fs.lstat(path.join(claudeTarget(), 'scratch'))).isDirectory()).toBe(true);
      await fs.mkdir(path.join(srcSkill, 'later', 'deep'), { recursive: true });
      await projectSkill('reviewer', srcSkill);
      for (const t of allTargets()) {
        expect((await fs.lstat(path.join(t, 'later', 'deep'))).isDirectory()).toBe(true);
      }
    });

    it('turns a file into the empty folder the source now has, in one projection', async () => {
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(srcSkill, 'ref.md'));
      await fs.mkdir(path.join(srcSkill, 'ref.md'));
      await projectSkill('reviewer', srcSkill);
      expect((await fs.lstat(path.join(claudeTarget(), 'ref.md'))).isDirectory()).toBe(true);
    });

    it('removes an empty folder the source dropped, but never one the user made', async () => {
      await fs.mkdir(path.join(srcSkill, 'scratch'));
      await projectSkill('reviewer', srcSkill);
      await fs.mkdir(path.join(claudeTarget(), 'mine'));
      await fs.rm(path.join(srcSkill, 'scratch'), { recursive: true });
      await projectSkill('reviewer', srcSkill);
      expect(existsSync(path.join(claudeTarget(), 'scratch'))).toBe(false);
      expect(existsSync(path.join(claudeTarget(), 'mine'))).toBe(true);
    });

    it.skipIf(!canHideContent)(
      'records only what landed when an update stops part way',
      async () => {
        await fs.mkdir(path.join(srcSkill, 'sub'));
        await fs.writeFile(path.join(srcSkill, 'sub', 'b.md'), 'b\n');
        await projectSkill('reviewer', srcSkill);
        await changeSourceRef();
        await fs.writeFile(path.join(srcSkill, 'sub', 'b.md'), 'b v2\n');
        // ref.md lands, then sub/b.md cannot be moved in a read-only folder and the update stops.
        await fs.chmod(path.join(claudeTarget(), 'sub'), 0o500);
        await projectSkill('reviewer', srcSkill);
        await fs.chmod(path.join(claudeTarget(), 'sub'), 0o755);
        expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
        // A later source change to ref.md must still apply: what landed is not an edit.
        await fs.writeFile(path.join(srcSkill, 'ref.md'), 'reference v3\n');
        await projectSkill('reviewer', srcSkill);
        expect(await read(claudeTarget(), 'ref.md')).toBe('reference v3\n');
        expect(await read(claudeTarget(), 'sub/b.md')).toBe('b v2\n');
      },
    );

    it.skipIf(!canHideContent)('retries removing an empty folder it could not remove', async () => {
      await fs.mkdir(path.join(srcSkill, 'outer', 'scratch'), { recursive: true });
      await fs.writeFile(path.join(srcSkill, 'outer', 'keep.md'), 'k\n');
      await projectSkill('reviewer', srcSkill);
      await fs.rm(path.join(srcSkill, 'outer', 'scratch'), { recursive: true });
      await fs.chmod(path.join(claudeTarget(), 'outer'), 0o500);
      await projectSkill('reviewer', srcSkill);
      await fs.chmod(path.join(claudeTarget(), 'outer'), 0o755);
      expect(existsSync(path.join(claudeTarget(), 'outer', 'scratch'))).toBe(true);
      await projectSkill('reviewer', srcSkill);
      expect(existsSync(path.join(claudeTarget(), 'outer', 'scratch'))).toBe(false);
    });

    it.skipIf(!canHideContent)(
      'keeps an old symlink install working when the source cannot be copied',
      async () => {
        const target = claudeTarget();
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.symlink(srcSkill, target, 'dir');
        await fs.chmod(path.join(srcSkill, 'ref.md'), 0o000);
        await projectSkill('reviewer', srcSkill);
        await fs.chmod(path.join(srcSkill, 'ref.md'), 0o644);
        expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        await projectSkill('reviewer', srcSkill);
        expect((await fs.lstat(target)).isDirectory()).toBe(true);
      },
    );

    it('merges once under concurrent projections and leaves no staging debris', async () => {
      await projectSkill('reviewer', srcSkill);
      await editSkillMd();
      await changeSourceRef();
      await Promise.all([
        projectSkill('reviewer', srcSkill),
        projectSkill('reviewer', srcSkill),
        projectSkill('reviewer', srcSkill),
      ]);
      expect(await read(claudeTarget(), 'SKILL.md')).toBe('MY EDIT\n');
      expect(await read(claudeTarget(), 'ref.md')).toBe(NEW_REF);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const siblings = await fs.readdir(path.dirname(claudeTarget()));
      expect(siblings.some((n) => n.includes('.staging-') || n.includes('.old-'))).toBe(false);
    });
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
