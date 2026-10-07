import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSymlinkEscape } from './symlink-escape';

// The editor opens files by absolute path, so a repository can ship a link that looks
// in-project while it reads and saves somewhere else. This is what the notice is built on.
describe('findSymlinkEscape', () => {
  let project: string;
  let outside: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'frink-escape-proj-'));
    outside = await mkdtemp(join(tmpdir(), 'frink-escape-out-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reports the real path of a linked file that leaves the project', async () => {
    const target = join(outside, 'bashrc');
    await writeFile(target, 'x', 'utf8');
    await symlink(target, join(project, 'config.yml'));

    await expect(findSymlinkEscape(project, join(project, 'config.yml'))).resolves.toEqual({
      escapes: true,
      realPath: await realpath(target),
    });
  });

  it('reports a file reached through a linked directory', async () => {
    const target = join(outside, 'notes.md');
    await writeFile(target, 'x', 'utf8');
    await symlink(outside, join(project, 'docs'));

    await expect(findSymlinkEscape(project, join(project, 'docs', 'notes.md'))).resolves.toEqual({
      escapes: true,
      realPath: await realpath(target),
    });
  });

  it('stays quiet for plain files and links that remain inside the project', async () => {
    await writeFile(join(project, 'real.txt'), 'x', 'utf8');
    await symlink(join(project, 'real.txt'), join(project, 'internal.txt'));

    await expect(findSymlinkEscape(project, join(project, 'real.txt'))).resolves.toEqual({
      escapes: false,
    });
    await expect(findSymlinkEscape(project, join(project, 'internal.txt'))).resolves.toEqual({
      escapes: false,
    });
  });

  it('stays quiet for a file opened from outside the project', async () => {
    const elsewhere = join(outside, 'plan.md');
    await writeFile(elsewhere, 'x', 'utf8');
    // A sibling directory sharing the project's name as a prefix is still outside it.
    const sibling = `${project}-old`;
    await mkdir(sibling);
    await writeFile(join(sibling, 'a.txt'), 'x', 'utf8');

    try {
      await expect(findSymlinkEscape(project, elsewhere)).resolves.toEqual({ escapes: false });
      await expect(findSymlinkEscape(project, join(sibling, 'a.txt'))).resolves.toEqual({
        escapes: false,
      });
      await expect(findSymlinkEscape(project, project)).resolves.toEqual({ escapes: false });
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('follows a chain of links to where the file finally lives', async () => {
    const target = join(outside, 'secrets.env');
    await writeFile(target, 'x', 'utf8');
    // The first hop stays in the project, so only the end of the chain gives it away.
    await symlink(target, join(project, 'hop.env'));
    await symlink(join(project, 'hop.env'), join(project, 'app.env'));

    await expect(findSymlinkEscape(project, join(project, 'app.env'))).resolves.toEqual({
      escapes: true,
      realPath: await realpath(target),
    });
  });

  it('stays quiet for a link that leaves the project and comes back', async () => {
    await writeFile(join(project, 'real.txt'), 'x', 'utf8');
    await symlink(project, join(outside, 'back'));
    await symlink(join(outside, 'back', 'real.txt'), join(project, 'roundtrip.txt'));

    await expect(findSymlinkEscape(project, join(project, 'roundtrip.txt'))).resolves.toEqual({
      escapes: false,
    });
  });

  it('checks files in a folder whose name merely starts with two dots', async () => {
    const target = join(outside, 'settings.json');
    await writeFile(target, 'x', 'utf8');
    await mkdir(join(project, '..config'));
    await writeFile(join(project, '..config', 'plain.json'), 'x', 'utf8');
    await symlink(target, join(project, '..config', 'linked.json'));

    await expect(
      findSymlinkEscape(project, join(project, '..config', 'plain.json')),
    ).resolves.toEqual({ escapes: false });
    await expect(
      findSymlinkEscape(project, join(project, '..config', 'linked.json')),
    ).resolves.toEqual({ escapes: true, realPath: await realpath(target) });
  });

  it('reports the escape whether or not the project path ends in a slash', async () => {
    const target = join(outside, 'bashrc');
    await writeFile(target, 'x', 'utf8');
    await symlink(target, join(project, 'config.yml'));

    await expect(findSymlinkEscape(`${project}/`, join(project, 'config.yml'))).resolves.toEqual({
      escapes: true,
      realPath: await realpath(target),
    });
  });

  it('stays quiet for paths that are not absolute', async () => {
    const target = join(outside, 'bashrc');
    await writeFile(target, 'x', 'utf8');
    await symlink(target, join(project, 'config.yml'));
    // A relative path would be resolved against the main process's working directory,
    // which is not the project the user is looking at.
    const relativeProject = relative(process.cwd(), project);

    await expect(
      findSymlinkEscape(relativeProject, join(relativeProject, 'config.yml')),
    ).resolves.toEqual({ escapes: false });
    await expect(findSymlinkEscape(project, 'config.yml')).resolves.toEqual({ escapes: false });
    await expect(findSymlinkEscape('', join(project, 'config.yml'))).resolves.toEqual({
      escapes: false,
    });
  });

  it('stays quiet rather than throwing when the path cannot be resolved', async () => {
    await expect(findSymlinkEscape(project, join(project, 'missing.txt'))).resolves.toEqual({
      escapes: false,
    });
    await expect(
      findSymlinkEscape(join(outside, 'no-such-project'), join(outside, 'no-such-project', 'a')),
    ).resolves.toEqual({ escapes: false });
  });
});
