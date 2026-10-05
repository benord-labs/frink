/* eslint-disable max-lines, max-lines-per-function */
/**
 * Unit tests for the boot-time skill provisioner.
 *
 * We test through `__test__.provisionOne` so each case gets a clean temp dir,
 * and we sub in a fake source root holding a minimal SKILL.md + references/
 * fixture with a precomputed `.baseline.json`. The real Electron app path
 * (`process.resourcesPath` / `app.getAppPath()`) is bypassed because
 * `tryRequireElectron()` returns `null` in vitest.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import log from 'electron-log';
import { __test__ } from './skill-provisioner';

const { provisionOne, diffAgainstBaseline, sha256, baselinesEqual } = __test__;

/** The three machine-local real-copy targets the provisioner projects into. */
function ideSkillPaths(home: string, name: string): string[] {
  return [
    join(home, '.agents', 'skills', name),
    join(home, '.claude', 'skills', name),
    join(home, '.cursor', 'skills', name),
  ];
}

/** Assert a projected IDE skill dir is a REAL copy (not a symlink) with content. */
function expectRealCopy(idePath: string): void {
  expect(lstatSync(idePath).isSymbolicLink()).toBe(false);
  expect(existsSync(join(idePath, 'SKILL.md'))).toBe(true);
}

type BaselineFile = { sha256: string; bytes: number };
type Baseline = {
  generatedAt: string;
  version: string;
  files: Record<string, BaselineFile>;
};

function buildBaseline(version: string, files: Record<string, string>): Baseline {
  const entries: Record<string, BaselineFile> = {};
  for (const [rel, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    entries[rel] = {
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  }
  return { generatedAt: `version-${version}`, version, files: entries };
}

async function writeSkillFixture(
  root: string,
  files: Record<string, string>,
  baseline: Baseline,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  await writeFile(join(root, '.baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

describe('skill-provisioner', () => {
  let sandbox: string;
  let sourceRoot: string;
  let userHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  const SKILL_NAME = 'demo-skill';
  const FILES_V1 = {
    'SKILL.md': '# demo v1\n',
    'references/topic.md': 'topic body v1\n',
  };
  const FILES_V2 = {
    'SKILL.md': '# demo v2\n',
    'references/topic.md': 'topic body v2 — new section\n',
  };

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'frink-skill-prov-'));
    sourceRoot = join(sandbox, 'assets', 'skills');
    userHome = join(sandbox, 'home');
    await mkdir(join(sourceRoot, SKILL_NAME, 'references'), {
      recursive: true,
    });
    await mkdir(userHome, { recursive: true });

    // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows; swap both
    // so the provisioner's lazily resolved paths point inside the sandbox.
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    vi.stubEnv('FRINK_HOME', userHome);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserprofile;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('fresh-installs when ~/.frink/skills/<name>/ does not exist', async () => {
    const baseline = buildBaseline('1.0.0', FILES_V1);
    await writeSkillFixture(join(sourceRoot, SKILL_NAME), FILES_V1, baseline);

    const outcome = await provisionOne(SKILL_NAME, sourceRoot);

    expect(outcome.status).toBe('installed');
    const dest = join(userHome, '.frink', 'skills', SKILL_NAME);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'references', 'topic.md'))).toBe(true);
    expect(existsSync(join(dest, '.baseline.json'))).toBe(true);
    expect(await readFile(join(dest, 'references', 'topic.md'), 'utf8')).toBe(
      FILES_V1['references/topic.md'],
    );
    // Projected as REAL COPIES into all three machine-local skill dirs
    // (~/.agents/skills, ~/.claude/skills, ~/.cursor/skills) — not symlinks.
    for (const idePath of ideSkillPaths(userHome, SKILL_NAME)) expectRealCopy(idePath);
  });

  it('atomically migrates a clean semver baseline to a content identity', async () => {
    const baselineV1 = buildBaseline('0.0.10', FILES_V1);
    const dest = join(userHome, '.frink', 'skills', SKILL_NAME);
    await writeSkillFixture(dest, FILES_V1, baselineV1);

    const baselineV2 = buildBaseline('content-0123456789ab', FILES_V1);
    await writeSkillFixture(join(sourceRoot, SKILL_NAME), FILES_V1, baselineV2);

    const outcome = await provisionOne(SKILL_NAME, sourceRoot);

    expect(outcome.status).toBe('updated');
    expect(outcome.details).toContain('0.0.10 → content-0123456789ab');
    expect(await readFile(join(dest, 'references', 'topic.md'), 'utf8')).toBe(
      FILES_V1['references/topic.md'],
    );
    // IDE real copies were (re-)projected on the update path too.
    for (const idePath of ideSkillPaths(userHome, SKILL_NAME)) expectRealCopy(idePath);
  });

  it('reports "unchanged" when versions match exactly', async () => {
    const baseline = buildBaseline('1.0.0', FILES_V1);
    const dest = join(userHome, '.frink', 'skills', SKILL_NAME);
    await writeSkillFixture(dest, FILES_V1, baseline);
    await writeSkillFixture(join(sourceRoot, SKILL_NAME), FILES_V1, baseline);

    const outcome = await provisionOne(SKILL_NAME, sourceRoot);

    expect(outcome.status).toBe('unchanged');
    // Real copies were still projected (idempotently) on the unchanged path.
    for (const idePath of ideSkillPaths(userHome, SKILL_NAME)) expectRealCopy(idePath);
  });

  it('migrates a pre-existing IDE symlink to a real copy on provision', async () => {
    // Simulate an install from before the symlink→copy migration: the canonical
    // store exists and ~/.claude/skills/<name> is still a live symlink into it.
    const baseline = buildBaseline('1.0.0', FILES_V1);
    const dest = join(userHome, '.frink', 'skills', SKILL_NAME);
    await writeSkillFixture(dest, FILES_V1, baseline);
    await writeSkillFixture(join(sourceRoot, SKILL_NAME), FILES_V1, baseline);
    const claudePath = join(userHome, '.claude', 'skills', SKILL_NAME);
    await mkdir(dirname(claudePath), { recursive: true });
    await symlink(dest, claudePath, 'dir');
    expect(lstatSync(claudePath).isSymbolicLink()).toBe(true);

    const outcome = await provisionOne(SKILL_NAME, sourceRoot);

    expect(outcome.status).toBe('unchanged');
    // The legacy symlink is replaced by a real copy with content intact.
    expect(lstatSync(claudePath).isSymbolicLink()).toBe(false);
    expect(await readFile(join(claudePath, 'SKILL.md'), 'utf8')).toBe(FILES_V1['SKILL.md']);
  });

  it('swaps when the version matches but the shipped manifest changed (e.g. file set grew mid-branch)', async () => {
    // User installed an earlier build whose baseline shipped FILES_V1 at v1.0.0.
    const baselineUser = buildBaseline('1.0.0', FILES_V1);
    const dest = join(userHome, '.frink', 'skills', SKILL_NAME);
    await writeSkillFixture(dest, FILES_V1, baselineUser);

    // Same version string ships, but the file SET has grown (extra reference added).
    const FILES_V1_GROWN = {
      ...FILES_V1,
      'references/extra.md': 'new reference added mid-branch\n',
    };
    const baselineShipped = buildBaseline('1.0.0', FILES_V1_GROWN);
    await writeSkillFixture(join(sourceRoot, SKILL_NAME), FILES_V1_GROWN, baselineShipped);

    const outcome = await provisionOne(SKILL_NAME, sourceRoot);

    expect(outcome.status).toBe('updated');
    expect(outcome.details).toContain('manifest refresh');
    expect(existsSync(join(dest, 'references', 'extra.md'))).toBe(true);
    expect(await readFile(join(dest, 'references', 'extra.md'), 'utf8')).toBe(
      'new reference added mid-branch\n',
    );
  });

  describe('per-file merge when the live copy has local edits', () => {
    const USER_EDIT = 'topic body v1 — local custom pattern\n';
    const skillsDir = () => join(userHome, '.frink', 'skills');
    const destDir = () => join(skillsDir(), SKILL_NAME);
    const readDest = (rel: string) => readFile(join(destDir(), rel), 'utf8');
    const readDestBaseline = async (): Promise<Baseline> =>
      JSON.parse(await readDest('.baseline.json'));

    async function installEditedV1(edits: Record<string, string>): Promise<void> {
      await writeSkillFixture(destDir(), FILES_V1, buildBaseline('1.0.0', FILES_V1));
      for (const [rel, content] of Object.entries(edits)) {
        await writeFile(join(destDir(), rel), content, 'utf8');
      }
    }

    async function ship(version: string, files: Record<string, string>): Promise<Baseline> {
      const src = join(sourceRoot, SKILL_NAME);
      await rm(src, { recursive: true, force: true });
      const baseline = buildBaseline(version, files);
      await writeSkillFixture(src, files, baseline);
      return baseline;
    }

    it('updates siblings, keeps the edited file, projects both, and leaves no -rejected dir', async () => {
      await installEditedV1({ 'references/topic.md': USER_EDIT });
      const FILES = { ...FILES_V2, 'references/extra.md': 'extra v2\n' };
      await ship('2.0.0', FILES);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('preserved-user-edits');
      expect(outcome.details).toContain('references/topic.md');
      expect(await readDest('SKILL.md')).toBe(FILES_V2['SKILL.md']);
      expect(await readDest('references/extra.md')).toBe('extra v2\n');
      expect(await readDest('references/topic.md')).toBe(USER_EDIT);
      const entries = await readdir(skillsDir());
      expect(entries.filter((e) => e.endsWith('-rejected'))).toEqual([]);
      // The projected tool copies carry the merged result, not the stale one.
      const claudeCopy = join(userHome, '.claude', 'skills', SKILL_NAME);
      expect(await readFile(join(claudeCopy, 'SKILL.md'), 'utf8')).toBe(FILES_V2['SKILL.md']);
      expect(await readFile(join(claudeCopy, 'references', 'topic.md'), 'utf8')).toBe(USER_EDIT);
    });

    it('keeps a file edited in one tool copy through a shipped update, and updates the rest', async () => {
      await ship('1.0.0', FILES_V1);
      await provisionOne(SKILL_NAME, sourceRoot);
      const [agentsCopy, claudeCopy] = ideSkillPaths(userHome, SKILL_NAME);
      await writeFile(join(claudeCopy, 'SKILL.md'), 'my claude tweak\n', 'utf8');
      const shipped = await ship('2.0.0', FILES_V2);

      await provisionOne(SKILL_NAME, sourceRoot);

      expect(await readFile(join(claudeCopy, 'SKILL.md'), 'utf8')).toBe('my claude tweak\n');
      expect(await readFile(join(claudeCopy, 'references', 'topic.md'), 'utf8')).toBe(
        FILES_V2['references/topic.md'],
      );
      expect(JSON.parse(await readFile(join(claudeCopy, '.baseline.json'), 'utf8'))).toEqual(
        shipped,
      );
      expect(await readFile(join(agentsCopy, 'SKILL.md'), 'utf8')).toBe(FILES_V2['SKILL.md']);
      const warn = vi.spyOn(log, 'warn');
      await provisionOne(SKILL_NAME, sourceRoot);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('is a silent no-op on the next boot after a merge', async () => {
      await installEditedV1({ 'references/topic.md': USER_EDIT });
      await ship('2.0.0', FILES_V2);
      await provisionOne(SKILL_NAME, sourceRoot);
      const baselineAfterMerge = await readDest('.baseline.json');
      const warn = vi.spyOn(log, 'warn');

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('preserved-user-edits');
      expect(await readDest('.baseline.json')).toBe(baselineAfterMerge);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('keeps the edited file across successive shipped updates', async () => {
      await installEditedV1({ 'references/topic.md': USER_EDIT });
      await ship('2.0.0', FILES_V2);
      await provisionOne(SKILL_NAME, sourceRoot);
      const FILES_V3 = {
        'SKILL.md': '# demo v3\n',
        'references/topic.md': 'topic v3\n',
      };
      await ship('3.0.0', FILES_V3);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('preserved-user-edits');
      expect(await readDest('SKILL.md')).toBe(FILES_V3['SKILL.md']);
      expect(await readDest('references/topic.md')).toBe(USER_EDIT);
      // The kept file still carries its ORIGINAL baseline entry, so it stays detected as edited.
      const v1 = buildBaseline('1.0.0', FILES_V1);
      expect((await readDestBaseline()).files['references/topic.md']).toEqual(
        v1.files['references/topic.md'],
      );
    });

    it('restores the shipped version when the user deletes their edited file', async () => {
      await installEditedV1({ 'references/topic.md': USER_EDIT });
      const shipped = await ship('2.0.0', FILES_V2);
      await provisionOne(SKILL_NAME, sourceRoot);
      await rm(join(destDir(), 'references', 'topic.md'));

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('updated');
      expect(await readDest('references/topic.md')).toBe(FILES_V2['references/topic.md']);
      expect(baselinesEqual(await readDestBaseline(), shipped)).toBe(true);
    });

    it('restores a deleted file the update never changed', async () => {
      await installEditedV1({ 'SKILL.md': '# my router\n' });
      // v2 rewrites only the reference, so the kept SKILL.md's baseline entry equals shipped.
      await ship('2.0.0', { ...FILES_V1, 'references/topic.md': FILES_V2['references/topic.md'] });
      await provisionOne(SKILL_NAME, sourceRoot);
      await rm(join(destDir(), 'SKILL.md'));

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('updated');
      expect(await readDest('SKILL.md')).toBe(FILES_V1['SKILL.md']);
      expect(
        await readFile(join(userHome, '.claude', 'skills', SKILL_NAME, 'SKILL.md'), 'utf8'),
      ).toBe(FILES_V1['SKILL.md']);
    });

    it('treats an edit that already matches the shipped content as clean', async () => {
      await installEditedV1({
        'references/topic.md': FILES_V2['references/topic.md'],
      });
      const shipped = await ship('2.0.0', FILES_V2);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('updated');
      expect(baselinesEqual(await readDestBaseline(), shipped)).toBe(true);
    });

    it('deletes a clean file dropped from the shipped set but keeps an edited one in a removed dir', async () => {
      const FILES_OLD = {
        ...FILES_V1,
        'old/clean.md': 'clean\n',
        'old/nested/edited.md': 'orig\n',
      };
      await writeSkillFixture(destDir(), FILES_OLD, buildBaseline('1.0.0', FILES_OLD));
      await writeFile(join(destDir(), 'old', 'nested', 'edited.md'), 'mine\n', 'utf8');
      await ship('2.0.0', FILES_V2);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('preserved-user-edits');
      expect(existsSync(join(destDir(), 'old', 'clean.md'))).toBe(false);
      expect(await readDest('old/nested/edited.md')).toBe('mine\n');
      expect(await readDest('SKILL.md')).toBe(FILES_V2['SKILL.md']);
    });

    it('carries a user-added reference file through the update', async () => {
      await installEditedV1({ 'SKILL.md': '# demo v1 + link to pattern-mine\n' });
      await writeFile(join(destDir(), 'references', 'pattern-mine.md'), 'my pattern\n', 'utf8');
      await ship('2.0.0', FILES_V2);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('preserved-user-edits');
      expect(await readDest('references/pattern-mine.md')).toBe('my pattern\n');
      expect(
        await readFile(
          join(userHome, '.claude', 'skills', SKILL_NAME, 'references', 'pattern-mine.md'),
          'utf8',
        ),
      ).toBe('my pattern\n');
      // Untracked additions never enter the baseline — they stay the user's.
      expect((await readDestBaseline()).files['references/pattern-mine.md']).toBeUndefined();
    });

    it('carries a user-added file through a clean update too', async () => {
      await installEditedV1({});
      await writeFile(join(destDir(), 'references', 'pattern-mine.md'), 'my pattern\n', 'utf8');
      await ship('2.0.0', FILES_V2);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('updated');
      expect(await readDest('references/pattern-mine.md')).toBe('my pattern\n');
      expect(await readDest('SKILL.md')).toBe(FILES_V2['SKILL.md']);
    });

    it('calls out an edited SKILL.md and the delete-to-restore recovery in the warning', async () => {
      await installEditedV1({ 'SKILL.md': '# my router\n' });
      await ship('2.0.0', FILES_V2);
      const warn = vi.spyOn(log, 'warn');

      await provisionOne(SKILL_NAME, sourceRoot);

      const message = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(message).toContain('SKILL.md');
      expect(message).toMatch(/delete/i);
      expect(await readDest('references/topic.md')).toBe(FILES_V2['references/topic.md']);
      warn.mockRestore();
    });

    it('refuses to overwrite a live copy with no .baseline.json and drops no rejected copy', async () => {
      await mkdir(destDir(), { recursive: true });
      await writeFile(join(destDir(), 'SKILL.md'), '# hand-made\n', 'utf8');
      await ship('2.0.0', FILES_V2);

      const outcome = await provisionOne(SKILL_NAME, sourceRoot);

      expect(outcome.status).toBe('preserved-user-edits');
      expect(await readDest('SKILL.md')).toBe('# hand-made\n');
      expect((await readdir(skillsDir())).filter((e) => e.endsWith('-rejected'))).toEqual([]);
    });
  });

  it('removes accumulated -rejected drops on any boot but leaves similarly named skills alone', async () => {
    const baseline = buildBaseline('1.0.0', FILES_V1);
    const skills = join(userHome, '.frink', 'skills');
    await writeSkillFixture(join(skills, SKILL_NAME), FILES_V1, baseline);
    await writeSkillFixture(join(sourceRoot, SKILL_NAME), FILES_V1, baseline);
    await mkdir(join(skills, `${SKILL_NAME}-0.0.10-d51bcaf1-rejected`, 'references'), {
      recursive: true,
    });
    await mkdir(join(skills, `${SKILL_NAME}-notes`), { recursive: true });

    const outcome = await provisionOne(SKILL_NAME, sourceRoot);

    expect(outcome.status).toBe('unchanged');
    const entries = await readdir(skills);
    expect(entries).not.toContain(`${SKILL_NAME}-0.0.10-d51bcaf1-rejected`);
    expect(entries).toContain(`${SKILL_NAME}-notes`);
  });

  it('reports "no-source" when the bundled skill is missing entirely', async () => {
    const outcome = await provisionOne('nonexistent-skill', sourceRoot);
    expect(outcome.status).toBe('no-source');
  });

  describe('diffAgainstBaseline', () => {
    it('returns an empty list when every file matches its baseline', async () => {
      const baseline = buildBaseline('1.0.0', FILES_V1);
      const dest = join(sandbox, 'dest-clean');
      await writeSkillFixture(dest, FILES_V1, baseline);

      const drift = await diffAgainstBaseline(dest, baseline);

      expect(drift).toEqual([]);
    });

    it('reports edited files', async () => {
      const baseline = buildBaseline('1.0.0', FILES_V1);
      const dest = join(sandbox, 'dest-dirty');
      await writeSkillFixture(dest, FILES_V1, baseline);
      await writeFile(join(dest, 'references', 'topic.md'), 'edited\n', 'utf8');

      const drift = await diffAgainstBaseline(dest, baseline);

      expect(drift).toEqual(['references/topic.md']);
    });

    it('does not report missing files — a deleted file is restored from the shipped copy', async () => {
      const baseline = buildBaseline('1.0.0', FILES_V1);
      const dest = join(sandbox, 'dest-partial');
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, 'SKILL.md'), FILES_V1['SKILL.md'], 'utf8');

      const drift = await diffAgainstBaseline(dest, baseline);

      expect(drift).toEqual([]);
    });
  });

  describe('sha256 helper', () => {
    it('matches Node crypto for known input', () => {
      expect(sha256('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });
  });

  describe('baselinesEqual', () => {
    it('returns true for identical manifests', () => {
      const a = buildBaseline('1.0.0', FILES_V1);
      const b = buildBaseline('1.0.0', FILES_V1);
      expect(baselinesEqual(a, b)).toBe(true);
    });

    it('returns false when the version string differs', () => {
      const a = buildBaseline('1.0.0', FILES_V1);
      const b = buildBaseline('1.0.1', FILES_V1);
      expect(baselinesEqual(a, b)).toBe(false);
    });

    it('returns false when the file set differs at the same version', () => {
      const a = buildBaseline('1.0.0', FILES_V1);
      const b = buildBaseline('1.0.0', {
        ...FILES_V1,
        'references/extra.md': 'added\n',
      });
      expect(baselinesEqual(a, b)).toBe(false);
    });

    it('returns false when a single file sha256 differs at the same version + same key set', () => {
      const a = buildBaseline('1.0.0', FILES_V1);
      const b = buildBaseline('1.0.0', {
        ...FILES_V1,
        'references/topic.md': 'rewritten content\n',
      });
      expect(baselinesEqual(a, b)).toBe(false);
    });

    it('ignores generatedAt differences', () => {
      const a = buildBaseline('1.0.0', FILES_V1);
      const b: typeof a = {
        ...buildBaseline('1.0.0', FILES_V1),
        generatedAt: 'something-else',
      };
      expect(baselinesEqual(a, b)).toBe(true);
    });
  });
});
