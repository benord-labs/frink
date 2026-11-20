import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import log from 'electron-log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFrinkCursorSkills } from './cursor-skill-cleanup';
import * as skillFs from './skill-fs';
import { sha256 } from './skill-fs';
import * as guardedWrite from './skill-guarded-write';
import { copyUserSkill, PROVENANCE_MARKER, projectSkill } from './skill-projection';

const SKILL = '---\nname: reviewer\ndescription: d\n---\nbody\n';

describe('removeFrinkCursorSkills', () => {
  let tmp: string;
  const cursor = (name = 'reviewer') => path.join(tmp, '.cursor', 'skills', name);

  /** A copy Frink projected into ~/.cursor/skills before it stopped writing there. */
  async function oldFrinkCopy(name = 'reviewer'): Promise<string> {
    const src = path.join(tmp, 'src', name);
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), SKILL);
    await fs.writeFile(path.join(src, 'ref.md'), 'ref\n');
    await projectSkill(name, src);
    await fs.cp(path.join(tmp, '.agents', 'skills', name), cursor(name), { recursive: true });
    return cursor(name);
  }

  async function userSkill(name: string): Promise<string> {
    await fs.mkdir(cursor(name), { recursive: true });
    await fs.writeFile(path.join(cursor(name), 'SKILL.md'), SKILL);
    return cursor(name);
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-skill-cleanup-'));
    vi.stubEnv('FRINK_HOME', tmp);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('removes an unedited Frink copy and leaves a user skill beside it', async () => {
    await oldFrinkCopy();
    const mine = await userSkill('mine');
    await removeFrinkCursorSkills();
    expect(existsSync(cursor())).toBe(false);
    expect(await fs.readdir(mine)).toEqual(['SKILL.md']);
    expect(existsSync(path.join(tmp, '.claude', 'skills', 'reviewer', 'SKILL.md'))).toBe(true);
  });

  it('keeps a Frink copy holding an edited file, and says so', async () => {
    const dir = await oldFrinkCopy();
    await fs.writeFile(path.join(dir, 'ref.md'), 'my edit\n');
    await removeFrinkCursorSkills();
    expect(await fs.readFile(path.join(dir, 'ref.md'), 'utf8')).toBe('my edit\n');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining(dir));
  });

  it('keeps a Frink copy the user added a file to', async () => {
    const dir = await oldFrinkCopy();
    await fs.writeFile(path.join(dir, 'notes.md'), 'mine\n');
    await removeFrinkCursorSkills();
    expect(await fs.readFile(path.join(dir, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('keeps a copy whose marker cannot be read', async () => {
    const dir = await oldFrinkCopy();
    await fs.writeFile(path.join(dir, PROVENANCE_MARKER), '{"hash":');
    await removeFrinkCursorSkills();
    expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });

  it('removes an unmarked shipped copy only while it matches its .baseline.json', async () => {
    for (const [name, edit] of [
      ['clean', false],
      ['edited', true],
    ] as const) {
      const dir = cursor(name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL);
      const sibling = path.join(tmp, '.agents', 'skills', name);
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(path.join(sibling, 'SKILL.md'), SKILL);
      const files = { 'SKILL.md': { sha256: sha256(SKILL), bytes: SKILL.length } };
      await fs.writeFile(
        path.join(dir, '.baseline.json'),
        JSON.stringify({ generatedAt: 'x', version: '1', files }),
      );
      if (edit) await fs.writeFile(path.join(dir, 'SKILL.md'), `${SKILL}edit\n`);
    }
    await removeFrinkCursorSkills();
    expect(existsSync(cursor('clean'))).toBe(false);
    expect(await fs.readFile(path.join(cursor('edited'), 'SKILL.md'), 'utf8')).toBe(
      `${SKILL}edit\n`,
    );
  });

  it("unlinks an old link into Frink's store only while Cursor reads the skill elsewhere", async () => {
    await fs.mkdir(path.join(tmp, '.cursor', 'skills'), { recursive: true });
    for (const name of ['frink-flows', 'only-here']) {
      const store = path.join(tmp, '.frink', 'skills', name);
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(path.join(store, 'SKILL.md'), SKILL);
      await fs.symlink(store, cursor(name));
    }
    await fs.cp(
      path.join(tmp, '.frink', 'skills', 'frink-flows'),
      path.join(tmp, '.agents', 'skills', 'frink-flows'),
      { recursive: true },
    );
    const elsewhere = await userSkill('real');
    await fs.symlink(elsewhere, cursor('linked'));
    await removeFrinkCursorSkills();
    expect(existsSync(cursor('frink-flows'))).toBe(false);
    expect(existsSync(path.join(tmp, '.frink', 'skills', 'frink-flows', 'SKILL.md'))).toBe(true);
    expect((await fs.lstat(cursor('only-here'))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(cursor('linked'))).isSymbolicLink()).toBe(true);
  });

  it("never removes a user's Copy across of a Frink copy or a shipped skill", async () => {
    await oldFrinkCopy();
    const shipped = path.join(tmp, '.agents', 'skills', 'shipped');
    await fs.mkdir(shipped, { recursive: true });
    await fs.writeFile(path.join(shipped, 'SKILL.md'), SKILL);
    const files = { 'SKILL.md': { sha256: sha256(SKILL), bytes: SKILL.length } };
    await fs.writeFile(
      path.join(shipped, '.baseline.json'),
      JSON.stringify({ generatedAt: 'x', version: '1', files }),
    );
    const cursorDir = path.join(tmp, '.cursor', 'skills');
    await fs.rm(cursor(), { recursive: true });
    await copyUserSkill('reviewer', path.join(tmp, '.agents', 'skills', 'reviewer'), [cursorDir]);
    await copyUserSkill('shipped', shipped, [cursorDir]);
    expect(await copyUserSkill('shipped', shipped, [cursorDir])).toEqual({ wrote: 0, kept: 0 });
    await removeFrinkCursorSkills();
    expect((await fs.readdir(cursorDir)).sort()).toEqual(['reviewer', 'shipped']);
    expect(existsSync(path.join(cursor(), PROVENANCE_MARKER))).toBe(false);
    expect(existsSync(path.join(cursor('shipped'), '.baseline.json'))).toBe(false);
  });

  it('judges crash debris by what it holds, never by its name', async () => {
    const debris = await oldFrinkCopy('foo');
    await fs.rename(debris, `${debris}.old-1700000000000`);
    await userSkill('release.old-2');
    await removeFrinkCursorSkills();
    expect(await fs.readdir(path.join(tmp, '.cursor', 'skills'))).toEqual(['release.old-2']);
  });

  it('puts an edited copy a stopped run left moved aside back under its name', async () => {
    const dir = await oldFrinkCopy();
    await fs.writeFile(path.join(dir, 'ref.md'), 'my edit\n');
    await fs.rename(dir, `${dir}.frink-aside-123e4567-e89b-12d3-a456-426614174000`);
    await removeFrinkCursorSkills();
    expect(await fs.readdir(path.join(tmp, '.cursor', 'skills'))).toEqual(['reviewer']);
    expect(await fs.readFile(path.join(dir, 'ref.md'), 'utf8')).toBe('my edit\n');
  });

  it("leaves a Cursor skills folder linked to Frink's store or a projection target alone", async () => {
    await oldFrinkCopy();
    const store = path.join(tmp, '.frink', 'skills');
    await fs.mkdir(store, { recursive: true });
    await fs.cp(path.join(tmp, '.agents', 'skills', 'reviewer'), path.join(store, 'reviewer'), {
      recursive: true,
    });
    for (const linked of [path.join(tmp, '.agents', 'skills'), store]) {
      await fs.rm(path.join(tmp, '.cursor', 'skills'), { recursive: true, force: true });
      await fs.symlink(linked, path.join(tmp, '.cursor', 'skills'));
      await removeFrinkCursorSkills();
      expect(existsSync(path.join(linked, 'reviewer', 'SKILL.md'))).toBe(true);
    }
  });

  it('removes an unedited copy with an old marker and keeps one edited after it', async () => {
    for (const name of ['clean', 'edited']) {
      const dir = await oldFrinkCopy(name);
      const marker = path.join(dir, PROVENANCE_MARKER);
      const { files: _files, ...legacy } = JSON.parse(await fs.readFile(marker, 'utf8'));
      await fs.writeFile(marker, JSON.stringify(legacy));
      const past = new Date(Date.now() - 60_000);
      for (const f of ['SKILL.md', 'ref.md', PROVENANCE_MARKER]) {
        await fs.utimes(path.join(dir, f), past, past);
      }
    }
    await fs.writeFile(path.join(cursor('edited'), 'ref.md'), 'my edit\n');
    await removeFrinkCursorSkills();
    expect(existsSync(cursor('clean'))).toBe(false);
    expect(await fs.readFile(path.join(cursor('edited'), 'ref.md'), 'utf8')).toBe('my edit\n');
  });

  it('puts a copy back under its own name when the second check fails', async () => {
    const dir = await oldFrinkCopy();
    const real = skillFs.readTree;
    vi.spyOn(skillFs, 'readTree')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('EIO'));
    await removeFrinkCursorSkills();
    expect(await fs.readdir(path.join(tmp, '.cursor', 'skills'))).toEqual(['reviewer']);
    expect(await fs.readFile(path.join(dir, 'ref.md'), 'utf8')).toBe('ref\n');
  });

  it('still cleans the other entries when one stranded copy cannot be read', async () => {
    await oldFrinkCopy();
    const stuck = cursor('other.frink-aside-123e4567-e89b-12d3-a456-426614174000');
    await fs.mkdir(stuck, { recursive: true });
    const real = guardedWrite.lstatOrNull;
    vi.spyOn(guardedWrite, 'lstatOrNull').mockImplementation(async (p) => {
      if (p === stuck) throw new Error('EACCES');
      return real(p);
    });
    await removeFrinkCursorSkills();
    expect(existsSync(cursor())).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('keeps the last copy of a skill whose other copies are gone', async () => {
    const dir = await oldFrinkCopy();
    await fs.rm(path.join(tmp, '.agents', 'skills', 'reviewer'), { recursive: true });
    await fs.rm(path.join(tmp, '.claude', 'skills', 'reviewer'), { recursive: true });
    await removeFrinkCursorSkills();
    expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });

  it('keeps a copy the other folders only reach through links into it', async () => {
    const dir = await oldFrinkCopy();
    for (const tool of ['.agents', '.claude']) {
      const other = path.join(tmp, tool, 'skills', 'reviewer');
      await fs.rm(other, { recursive: true });
      await fs.symlink(dir, other);
    }
    await removeFrinkCursorSkills();
    expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
  });

  it('keeps a Frink copy the user added an empty folder to', async () => {
    const dir = await oldFrinkCopy();
    await fs.mkdir(path.join(dir, 'drafts'));
    await removeFrinkCursorSkills();
    expect(existsSync(path.join(dir, 'drafts'))).toBe(true);
  });

  it('does nothing when there is no Cursor skills folder', async () => {
    await removeFrinkCursorSkills();
    expect(existsSync(path.join(tmp, '.cursor'))).toBe(false);
  });
});
